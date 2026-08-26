// loop/orchestrator — 이미 만들어진 단계들을 조합해 Task 하나를 끝까지 돌린다.
//
// 여기에 단계의 업무 로직은 없다. Worker · Gate · Verifier · Diagnose · Retry는
// 전부 기존 모듈(stages.mjs / recovery/)을 그대로 부른다. CLI를 subprocess로 띄우지 않는다.
//
// 매 단계 전에 Task와 Run artifact를 **디스크에서 다시 읽는다.**
// 앞 단계의 반환값을 유일한 진실로 삼지 않는다 — 그래야 중단·재시작이 안전해진다.

import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllTasks, isValid, isExample, isPaused, LOCAL_DIR } from '../task-store.mjs';
import { latestRunForTask } from '../gate/runner.mjs';
import { startFirstAttempt, startRetryAttempt, stageWorker, stageGate, stageVerify } from '../stages.mjs';
import { resolveNextAction } from './next-action.mjs';
import { evaluateStop, loopGuardLimit } from './stop-evaluator.mjs';
import {
  ACTIVE_DIR, allocateExecutionId, buildExecutionReport, buildUsageSummary,
  writeExecutionReport, executionDir, readActiveMarker, classifyActiveMarker,
} from './execution-report.mjs';

const activeMarker = (taskId) => join(ACTIVE_DIR, `${taskId}.json`);

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * 같은 Task에 대한 명백한 중복 오케스트레이터를 막는 가벼운 표식.
 * **Lease가 아니다.** 죽은 프로세스가 남긴 표식만 안전하게 회수한다.
 *
 * 생존 판정의 정본은 **Runtime이 남긴 heartbeat**다. PID는 보조 신호로만 본다 —
 * 부모 없는 좀비 프로세스는 `kill(pid, 0)` 에 계속 성공해서, PID만 보면 이미 끝난
 * 실행이 영원히 살아 있는 것으로 보인다(OBS-006).
 */
export function claimExecution(taskId, { now = Date.now() } = {}) {
  mkdirSync(ACTIVE_DIR, { recursive: true });
  const p = activeMarker(taskId);
  if (existsSync(p)) {
    const prev = readActiveMarker(taskId);
    if (prev === null || prev.corrupt) {
      return { ok: false, reason: `an execution marker for ${taskId} exists but is unreadable; resolve it manually (${p}).` };
    }
    const liveness = classifyActiveMarker(prev, { now });
    const pidAlive = Number.isInteger(prev.pid) && prev.pid !== process.pid && isAlive(prev.pid);
    if (liveness.state === 'RUNNING' && pidAlive) {
      return {
        ok: false,
        reason: `${taskId} is already being executed by ${prev.execution_id} (pid ${prev.pid}, ${liveness.reason}).`,
      };
    }
    // heartbeat가 끊겼거나 프로세스가 없다 -> 앞선 실행이 남긴 표식이다. 회수한다.
    return { ok: true, reclaimed: prev.execution_id ?? null, path: p, staleReason: liveness.reason };
  }
  return { ok: true, reclaimed: null, path: p };
}

/**
 * 표식을 쓰거나 갱신한다. 매 단계마다 불러서 heartbeat와 현재 단계를 남긴다.
 * status가 읽는 것은 이 파일이지 프로세스 테이블이 아니다.
 */
export function writeClaim(taskId, execId, progress = {}) {
  mkdirSync(ACTIVE_DIR, { recursive: true });
  const existing = readActiveMarker(taskId);
  const startedAt = (existing && !existing.corrupt && existing.execution_id === execId)
    ? existing.started_at
    : new Date().toISOString();
  writeFileSync(activeMarker(taskId), `${JSON.stringify({
    task_id: taskId,
    execution_id: execId,
    pid: process.pid,
    started_at: startedAt,
    heartbeat_at: new Date().toISOString(),
    stage: progress.stage ?? (existing && !existing.corrupt ? existing.stage : null) ?? 'starting',
    run_id: progress.run_id ?? (existing && !existing.corrupt ? existing.run_id : null) ?? null,
    attempt: progress.attempt ?? (existing && !existing.corrupt ? existing.attempt : null) ?? null,
  }, null, 2)}\n`, 'utf8');
}

export function releaseClaim(taskId) {
  try { rmSync(activeMarker(taskId), { force: true }); } catch { /* 이미 없으면 무시 */ }
}

/** Task를 디스크에서 다시 읽는다. 인메모리 그림자 상태를 신뢰하지 않는다. */
function reloadTask(taskId) {
  const t = loadAllTasks().find((x) => x.id === taskId);
  if (!t) return { ok: false, reason: `Task not found: ${taskId}` };
  if (!isValid(t)) return { ok: false, reason: `${taskId} is invalid: ${t.errors.join('; ')}` };
  return { ok: true, task: t };
}

/**
 * Task 하나를 정지 조건에 도달할 때까지 실행한다.
 *
 * @param {{ taskId, config, emit, isInterrupted, deadlineMs }} opts
 *   emit(event) — 진행 상황 출력용 콜백. 오케스트레이션 판단에는 관여하지 않는다.
 * @returns {{ report, reportPath, execId, result }}
 */
export async function executeTask({ taskId, config, emit = () => {}, isInterrupted = () => false, deadlineMs = null }) {
  const startedAt = new Date();
  const execId = allocateExecutionId(taskId, startedAt);
  const guardLimit = loopGuardLimit(config);

  const events = [];
  const attempts = new Map();   // attempt번호 -> 요약
  const touchedRuns = new Map(); // runId -> runDir
  let transitions = 0;

  const record = (stage, extra) => {
    const e = { stage, ...extra };
    events.push(e);
    // 표식을 매 단계 갱신한다 — 진행 중 상태가 디스크에 남아야 세션이 끊겨도 복원된다.
    writeClaim(taskId, execId, { stage, run_id: e.run_id ?? null, attempt: e.attempt ?? null });
    emit(e);
    return e;
  };
  const noteRun = (run) => { if (run) touchedRuns.set(run.runId, run.runDir); };
  const attemptEntry = (n, runId) => {
    if (!attempts.has(n)) attempts.set(n, { attempt: n, run_id: runId, worker: null, gate: null, verifier: null, diagnosis: null, action: null });
    const a = attempts.get(n);
    if (runId) a.run_id = runId;
    return a;
  };

  let result = null;
  let stopReason = null;

  writeClaim(taskId, execId);
  try {
    for (;;) {
      if (transitions >= guardLimit) {
        const verdict = evaluateStop({ next: { action: 'NOOP' }, guardExceeded: true });
        result = verdict.result; stopReason = verdict.reason;
        record('guard', { result: 'RUNTIME_LOOP_GUARD_EXCEEDED', transitions });
        break;
      }

      // --- 매 단계 전에 디스크에서 상태를 다시 읽는다.
      const reloaded = reloadTask(taskId);
      if (!reloaded.ok) {
        result = 'FAILED'; stopReason = 'RUNTIME_STATE_INCONSISTENT';
        record('state', { result: reloaded.reason });
        break;
      }
      const task = reloaded.task;

      const next = resolveNextAction({ task, config });
      const deadlineExceeded = deadlineMs !== null && Date.now() > deadlineMs;
      const verdict = evaluateStop({
        next,
        interrupted: isInterrupted(),
        deadlineExceeded,
        guardExceeded: false,
      });
      if (verdict.stop) {
        result = verdict.result;
        stopReason = verdict.reason;
        if (next.assessment?.diagnosis?.failure_class) {
          const d = next.assessment.diagnosis;
          const a = attemptEntry(d.attempt, d.run_id);
          a.diagnosis = d.failure_class;
          a.action = d.recommended_action;
          record('diagnose', { run_id: d.run_id, result: d.failure_class, action: d.recommended_action });
        }
        record('stop', { result, reason: stopReason, detail: verdict.detail ?? next.reason });
        break;
      }

      transitions += 1;

      // --- 정확히 하나의 행동만 수행한다.
      if (next.action === 'RUN_WORKER') {
        const start = startFirstAttempt({ task, config });
        if (!start.ok) {
          result = 'FAILED'; stopReason = 'WORKER_NOT_DISPATCHABLE';
          record('stop', { result, reason: stopReason, detail: start.errors.join(' ') });
          break;
        }
        noteRun({ runId: start.snapshot.runId, runDir: start.snapshot.runDir });
        attemptEntry(1, start.snapshot.runId);
        const w = await stageWorker({ task, snapshot: start.snapshot, config, attempt: 1 });
        const a = attemptEntry(1, start.snapshot.runId);
        a.worker = w.ok ? (w.transition?.to ?? 'no-transition') : 'failed';
        record('worker', { run_id: start.snapshot.runId, attempt: 1, result: a.worker, failures: w.failures });
        continue;
      }

      if (next.action === 'RETRY_WORKER') {
        const d = next.assessment.diagnosis;
        const a0 = attemptEntry(d.attempt, d.run_id);
        a0.diagnosis = d.failure_class;
        a0.action = d.recommended_action;
        record('diagnose', { run_id: d.run_id, result: d.failure_class, action: d.recommended_action });

        const started = startRetryAttempt({ task, run: next.run, config });
        if (!started.ok) {
          result = 'NEEDS_HUMAN'; stopReason = 'RETRY_REFUSED';
          record('stop', { result, reason: stopReason, detail: started.errors.join(' ') });
          break;
        }
        transitions += 1;
        noteRun({ runId: started.snapshot.runId, runDir: started.snapshot.runDir });
        attemptEntry(started.attempt, started.snapshot.runId);
        const w = await stageWorker({ task, snapshot: started.snapshot, config, attempt: started.attempt });
        const a = attemptEntry(started.attempt, started.snapshot.runId);
        a.worker = w.ok ? (w.transition?.to ?? 'no-transition') : 'failed';
        record('worker', {
          run_id: started.snapshot.runId, attempt: started.attempt, result: a.worker, failures: w.failures, retry_of: next.run.runId,
        });
        continue;
      }

      if (next.action === 'RUN_GATES') {
        const run = next.run ?? latestRunForTask(taskId);
        noteRun(run);
        const g = await stageGate({ task, run, config });
        if (!g.ok) {
          result = 'NEEDS_HUMAN'; stopReason = 'GATE_NOT_ELIGIBLE';
          record('stop', { result, reason: stopReason, detail: g.errors.join(' ') });
          break;
        }
        const a = attemptEntry(run.manifest?.attempt ?? 1, run.runId);
        a.gate = g.report.result;
        record('gate', {
          run_id: run.runId,
          result: g.report.result,
          gates: g.report.gates.map((x) => ({ name: x.name, status: x.status })),
        });
        continue;
      }

      if (next.action === 'RUN_VERIFIER') {
        const run = next.run ?? latestRunForTask(taskId);
        noteRun(run);
        const v = await stageVerify({ task, run, config });
        if (!v.ok && v.refused) {
          result = 'NEEDS_HUMAN'; stopReason = 'VERIFIER_NOT_ELIGIBLE';
          record('stop', { result, reason: stopReason, detail: v.errors.join(' ') });
          break;
        }
        if (!v.ok) {
          result = 'FAILED'; stopReason = 'VERIFIER_LAUNCH_FAILED';
          record('stop', { result, reason: stopReason, detail: v.errors.join(' ') });
          break;
        }
        const a = attemptEntry(run.manifest?.attempt ?? 1, run.runId);
        a.verifier = v.report.verifier_result ?? 'INVALID';
        record('verifier', {
          run_id: run.runId,
          result: v.report.result,
          verifier_result: v.report.verifier_result ?? 'INVALID',
          transition: v.transition ? `${v.transition.from} -> ${v.transition.to}` : null,
        });
        continue;
      }

      // 여기에 오면 resolver가 알 수 없는 action을 냈다는 뜻이다. 추측하지 않는다.
      result = 'FAILED'; stopReason = 'UNKNOWN_NEXT_ACTION';
      record('stop', { result, reason: stopReason, detail: next.action });
      break;
    }
  } finally {
    releaseClaim(taskId);
  }

  const finishedAt = new Date();
  const finalTask = reloadTask(taskId);
  const report = buildExecutionReport({
    execId,
    taskId,
    startedAt,
    finishedAt,
    result: result ?? 'FAILED',
    stopReason: stopReason ?? 'UNKNOWN',
    attempts: [...attempts.values()].sort((a, b) => a.attempt - b.attempt),
    events,
    usageSummary: buildUsageSummary(touchedRuns),
    finalStatus: finalTask.ok ? finalTask.task.data.status : null,
    guard: { limit: guardLimit, stage_transitions: transitions },
  });
  const reportPath = writeExecutionReport(execId, report);
  return { report, reportPath, execId, result: report.result };
}

export { executionDir, isPaused, isExample };
