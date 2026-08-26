// loop/plan-executor — 승인된 Plan 하나를 Task 단위로 끝까지 몬다.
//
// 여기에 새로운 오케스트레이션 로직은 없다. Task 하나의 Worker · Gate · Verifier ·
// Diagnose · Retry는 전부 `executeTask`가 그대로 소유한다. 이 파일이 하는 일은
// **다음에 무엇을 실행할지 결정론적으로 고르는 것** 하나뿐이다.
//
// 규칙:
//   - 이미 승인·구체화된 Plan에만 동작한다. Plan을 승인하지 않는다.
//   - READY 계산은 Runtime의 의존성 규칙(readyTasks)을 그대로 쓴다.
//   - 한 번에 Task 하나. shared working tree이므로 절대 동시에 돌리지 않는다.
//   - DONE이면 READY를 다시 계산하고 이어간다.
//   - 사람이 필요한 정지(NEEDS_HUMAN · STALLED · RECOVERY_AMBIGUOUS · POLICY_VIOLATION ·
//     subject 모호성 등)에서는 즉시 멈춘다.
//   - LLM을 추가로 호출하지 않는다. 여기서 내리는 판단은 전부 파일 상태에서 나온다.
//
// 재시작은 별도 상태가 필요 없다. 매 순회마다 Task 상태를 디스크에서 다시 읽으므로,
// 같은 명령을 다시 실행하면 남은 Task부터 이어서 간다.

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllTasks, isValid, isExample, isPaused, readyTasks, checkDependencies } from '../task-store.mjs';
import { loadPlan, planDir } from '../planner/store.mjs';
import { executeTask } from './orchestrator.mjs';

export const PLAN_EXECUTIONS_DIR = 'executions';
export const PLAN_REPORT_SCHEMA = 1;

/** Task 하나의 실행 결과 중 **사람이 필요한 것**. 여기서 Plan 진행을 멈춘다. */
export const HUMAN_REQUIRED_RESULTS = new Set([
  'NEEDS_HUMAN', 'STALLED', 'LIMIT_REACHED', 'BLOCKED', 'FAILED', 'INTERRUPTED',
]);

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Plan을 실행 대상으로 해석한다. 승인되지 않았거나 Task가 없으면 실행하지 않는다.
 * @returns {{ ok: true, planId, taskIds } | { ok: false, reason: string }}
 */
export function resolveExecutablePlan(planId) {
  const loaded = loadPlan(planId);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const approval = loaded.approval;
  if (approval === null) {
    return { ok: false, reason: `${planId} is not approved; run \`loopctl plan-approve ${planId}\` first (approval creates the tasks).` };
  }
  if (approval.corrupt) {
    return { ok: false, reason: `${planId}: approval.json is corrupt (${approval.error})` };
  }
  const taskIds = Array.isArray(approval.created_task_ids) ? approval.created_task_ids : [];
  if (taskIds.length === 0) {
    return { ok: false, reason: `${planId}: the approval record lists no created tasks.` };
  }
  return { ok: true, planId, taskIds };
}

/**
 * 지금 실행해야 할 Task 하나를 결정론적으로 고른다.
 *
 * Plan이 만든 Task 중에서만 고르고, READY 판정은 Runtime 규칙을 그대로 쓴다.
 * 순서는 Plan의 Task 생성 순서(= Planner의 위상 순서)를 따른다.
 *
 * @returns {{ done: true } | { pick: object } | { stop: string, reason: string }}
 */
export function selectNextPlanTask(taskIds) {
  const all = loadAllTasks();
  const byId = new Map(all.map((t) => [t.id, t]));

  const mine = taskIds.map((id) => byId.get(id)).filter(Boolean);
  const missing = taskIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { stop: 'PLAN_TASK_MISSING', reason: `tasks named by the plan no longer exist: ${missing.join(', ')}` };
  }

  const broken = mine.filter((t) => !isValid(t));
  if (broken.length > 0) {
    return { stop: 'PLAN_TASK_INVALID', reason: `invalid task(s): ${broken.map((t) => t.id).join(', ')}` };
  }

  const outstanding = mine.filter((t) => t.data.status !== 'DONE' && !isExample(t));
  if (outstanding.length === 0) return { done: true };

  // 사람의 판단을 기다리는 상태가 남아 있으면 다음 Task로 넘어가지 않는다.
  const blocked = outstanding.filter((t) => t.data.status === 'BLOCKED');
  if (blocked.length > 0) {
    return { stop: 'PLAN_TASK_BLOCKED', reason: `blocked task(s) need a human: ${blocked.map((t) => t.id).join(', ')}` };
  }

  const readySet = new Set(readyTasks(all).map((t) => t.id));
  const pick = mine.find((t) => readySet.has(t.id));
  if (pick) return { pick };

  // READY가 없는데 남은 Task가 있다 — 왜 못 가는지 사실대로 보고하고 멈춘다.
  const why = outstanding.map((t) => {
    const d = checkDependencies(t, all);
    if (!d.met) {
      const waits = [...d.waiting_on, ...d.missing.map((m) => `${m} (unresolved)`)];
      return `${t.id} (${t.data.status}) waiting on: ${waits.join(', ')}`;
    }
    return `${t.id} (${t.data.status})`;
  });
  return { stop: 'PLAN_NO_READY_TASK', reason: `no task is ready; outstanding: ${why.join('; ')}` };
}

/**
 * Plan의 Task를 하나씩, 순차적으로 끝까지 실행한다.
 *
 * @param {{ planId, taskIds, config, emit, isInterrupted }} opts
 * @returns {{ result, stopReason, detail, executions, startedAt, finishedAt }}
 */
export async function executePlan({
  planId, taskIds, config, emit = () => {}, isInterrupted = () => false, deadlineMs = null,
}) {
  const startedAt = new Date();
  const executions = [];
  let result = null;
  let stopReason = null;
  let detail = null;

  for (;;) {
    if (isInterrupted()) {
      result = 'INTERRUPTED'; stopReason = 'OPERATOR_INTERRUPT';
      break;
    }
    if (isPaused()) {
      result = 'NEEDS_HUMAN'; stopReason = 'PAUSE_ACTIVE';
      detail = 'PAUSE is active; the plan will not start another task.';
      break;
    }
    if (deadlineMs !== null && Date.now() > deadlineMs) {
      result = 'LIMIT_REACHED'; stopReason = 'PLAN_TIMEOUT';
      break;
    }

    const next = selectNextPlanTask(taskIds);
    if (next.done) {
      result = 'DONE'; stopReason = 'PLAN_COMPLETE';
      break;
    }
    if (next.stop) {
      result = 'NEEDS_HUMAN'; stopReason = next.stop; detail = next.reason;
      break;
    }

    const taskId = next.pick.id;
    emit({ event: 'task-start', task_id: taskId });

    // Task 하나의 루프는 전부 executeTask가 소유한다. 여기서 단계를 흉내내지 않는다.
    const out = await executeTask({
      taskId,
      config,
      emit: (e) => emit({ event: 'stage', task_id: taskId, ...e }),
      isInterrupted,
      deadlineMs,
    });
    executions.push({
      task_id: taskId,
      execution_id: out.execId,
      result: out.report.result,
      stop_reason: out.report.stop_reason,
      final_task_status: out.report.final_task_status,
      attempts: out.report.attempts.length,
      duration_ms: out.report.duration_ms,
      usage_summary: out.report.usage_summary,
    });
    emit({ event: 'task-end', task_id: taskId, result: out.report.result, execution_id: out.execId });

    if (out.report.result !== 'DONE') {
      result = HUMAN_REQUIRED_RESULTS.has(out.report.result) ? out.report.result : 'NEEDS_HUMAN';
      stopReason = 'TASK_STOPPED';
      detail = `${taskId} stopped with ${out.report.result} (${out.report.stop_reason})`;
      break;
    }
  }

  return {
    result: result ?? 'FAILED',
    stopReason: stopReason ?? 'UNKNOWN',
    detail,
    executions,
    startedAt,
    finishedAt: new Date(),
  };
}

/** 이 Plan 실행에서 실제로 관측된 비용만 합친다. 없는 값을 만들지 않는다. */
export function summarizePlanUsage(executions) {
  const known = executions
    .map((e) => e.usage_summary?.provider_cost_usd_known)
    .filter((v) => Number.isFinite(v));
  return {
    task_executions: executions.length,
    llm_invocations: executions.reduce((a, e) => a + (e.usage_summary?.llm_invocations ?? 0), 0),
    gate_invocations: executions.reduce((a, e) => a + (e.usage_summary?.gate_invocations ?? 0), 0),
    provider_cost_usd_known: known.length > 0 ? Number(known.reduce((a, b) => a + b, 0).toFixed(6)) : null,
    executions_with_unknown_cost: executions.length - known.length,
  };
}

export function writePlanExecutionReport(planId, run) {
  const dir = join(planDir(planId), PLAN_EXECUTIONS_DIR);
  mkdirSync(dir, { recursive: true });
  // id는 초 단위 timestamp라 같은 초에 두 번 끝나면 겹친다. 겹치면 순번을 붙인다 —
  // 앞선 실행 기록을 덮어쓰지 않기 위해서다 (run id · execution id와 같은 규칙).
  const base = `PLANEXEC-${stamp(run.finishedAt)}`;
  let id = base;
  for (let n = 2; existsSync(join(dir, `${id}.json`)); n += 1) {
    if (n > 99) throw new Error(`cannot allocate a plan execution id for ${base}`);
    id = `${base}-${n}`;
  }
  const report = {
    schema: PLAN_REPORT_SCHEMA,
    plan_execution_id: id,
    plan_id: planId,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt.toISOString(),
    duration_ms: run.finishedAt - run.startedAt,
    result: run.result,
    stop_reason: run.stopReason,
    detail: run.detail,
    // 오케스트레이션 판단은 전부 결정론적이다. Plan 수준에서 LLM을 부르지 않는다.
    orchestration_llm_calls: 0,
    executions: run.executions.map(({ usage_summary, ...rest }) => rest),
    usage_summary: summarizePlanUsage(run.executions),
  };
  const p = join(dir, `${id}.json`);
  writeFileSync(p, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { path: p, report };
}

/** 기록된 Plan 실행 목록 (오래된 것부터). */
export function listPlanExecutions(planId) {
  const dir = join(planDir(planId), PLAN_EXECUTIONS_DIR);
  if (!existsSync(dir)) return [];
  // 확장자를 뗀 id로 정렬한다. `.json` 을 붙인 채 정렬하면 `...Z-2.json` 이 `...Z.json`
  // 보다 앞서서 시간순이 뒤집힌다 ('-' < '.').
  return readdirSync(dir)
    .filter((f) => f.startsWith('PLANEXEC-') && f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
    .map((id) => {
      try { return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')); } catch { return { corrupt: true, file: `${id}.json` }; }
    });
}
