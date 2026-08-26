// gate/runner — 결정론적 Gate 실행기. LLM을 호출하지 않는다.
//
// 입력은 "완료된 Worker Run 하나"다. Gate는 Task ID가 아니라 Run ID에 귀속된다.
// 새 Worker Run을 만들지 않고, Worker를 다시 부르지도 않으며, Task 상태를 바꾸지도 않는다.
// 판정 근거는 프로세스 사실(exit code · signal · timeout)뿐이다. 출력 해석은 하지 않는다.

import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, createWriteStream, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { ROOT, LOCAL_DIR } from '../task-store.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { validateWorkerResult } from '../worker/result.mjs';
import {
  loadGateConfig, resolveRequiredGates, checkGateRefs, gateTimeoutSeconds, gateCwd, gateCwdExists,
  relFromRoot,
} from './resolver.mjs';
import {
  gateDir, reportPath, buildGateReport, writeGateReport, readGateReport, archivePriorGateEvidence,
  priorGateAttempts, sha256File, freeze, GATES_DIR,
} from './report.mjs';

export const RUNS_DIR = join(LOCAL_DIR, 'runs');
// SIGTERM 이후 프로세스가 스스로 끝날 시간을 준 뒤 SIGKILL 한다.
const KILL_GRACE_MS = 5000;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Run 디렉터리 목록. manifest를 읽지 못하는 디렉터리는 그 사실을 그대로 남긴다. */
export function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((runId) => {
      const runDir = join(RUNS_DIR, runId);
      let manifest = null;
      let manifestError = null;
      try {
        manifest = readJson(join(runDir, 'manifest.json'));
      } catch (err) {
        manifestError = err.message;
      }
      return {
        runId,
        runDir,
        manifest,
        manifestError,
        taskId: manifest?.task_id ?? null,
        hasEnvelope: existsSync(join(runDir, 'runtime-envelope.json')),
      };
    });
}

/**
 * 완료된 Worker Run 중 해당 Task의 최신 것. run id는 `RUN-<timestamp>-<TASK>` 이므로
 * 사전식 정렬이 곧 시간순이고, 같은 초의 충돌은 `-2` 접미사로 결정론적으로 갈린다.
 */
export function latestRunForTask(taskId) {
  const runs = listRuns().filter((r) => r.taskId === taskId && r.hasEnvelope);
  return runs.length === 0 ? null : runs[runs.length - 1];
}

/**
 * `gate <RUN-ID>` 또는 `gate <TASK-ID>` 인자를 하나의 Run으로 해석한다.
 * Run ID가 정본이며, Task ID는 편의 경로일 뿐이다.
 * @returns {{ ok: true, run: object, selectedBy: string } | { ok: false, reason: string }}
 */
export function resolveRunRef(ref) {
  if (existsSync(join(RUNS_DIR, ref)) && statSync(join(RUNS_DIR, ref)).isDirectory()) {
    const run = listRuns().find((r) => r.runId === ref);
    return { ok: true, run, selectedBy: 'run-id' };
  }
  if (ref.startsWith('RUN-')) {
    return { ok: false, reason: `run not found: ${ref} (${relFromRoot(join(RUNS_DIR, ref))})` };
  }
  const run = latestRunForTask(ref);
  if (!run) {
    return {
      ok: false,
      reason: `no completed worker run found for ${ref} (a run needs runtime-envelope.json)`,
    };
  }
  return { ok: true, run, selectedBy: 'latest-run-for-task' };
}

/**
 * Gate 실행 자격 검사. 하나라도 걸리면 Gate는 실행되지 않고 Report도 만들어지지 않는다.
 * @returns {{ ok: boolean, errors: string[], envelope: object|null, workerResult: object|null,
 *             required: object, gateConfig: object }}
 */
export function checkEligibility({ task, run, config }) {
  const errors = [];
  const gateConfig = loadGateConfig(config);
  errors.push(...gateConfig.errors);

  if (run.manifest === null) {
    errors.push(`run ${run.runId}: cannot read manifest.json (${run.manifestError})`);
  } else if (run.manifest.task_id !== task.id) {
    errors.push(`run ${run.runId} belongs to ${run.manifest.task_id}, not ${task.id}`);
  }

  let envelope = null;
  const envPath = join(run.runDir, 'runtime-envelope.json');
  if (!existsSync(envPath)) {
    errors.push(`run ${run.runId}: no runtime-envelope.json — this run has no completed worker execution`);
  } else {
    try {
      envelope = readJson(envPath);
    } catch (e) {
      errors.push(`run ${run.runId}: runtime-envelope.json is not valid JSON (${e.message})`);
    }
  }
  if (envelope) {
    if (envelope.run_id !== run.runId) {
      errors.push(`run ${run.runId}: envelope run_id is "${envelope.run_id}"`);
    }
    if (envelope.task_id !== task.id) {
      errors.push(`run ${run.runId}: envelope task_id is "${envelope.task_id}", not ${task.id}`);
    }
    if (envelope.policy_violation === true) {
      errors.push(`run ${run.runId}: unresolved worker policy violation — gates will not run`);
    }
    if (envelope.worker_result_valid !== true) {
      errors.push(`run ${run.runId}: worker result was not valid (${(envelope.worker_result_errors ?? []).join('; ') || 'see runtime-envelope.json'})`);
    }
  }

  // Worker Result는 Envelope의 기록을 믿지 않고 다시 결정론적으로 검증한다.
  let workerResult = null;
  const resultPath = join(run.runDir, 'worker-result.json');
  if (!existsSync(resultPath)) {
    errors.push(`run ${run.runId}: worker-result.json is missing`);
  } else {
    let raw = null;
    try {
      raw = readJson(resultPath);
    } catch (e) {
      errors.push(`run ${run.runId}: worker-result.json is not valid JSON (${e.message})`);
    }
    if (raw !== null) {
      const v = validateWorkerResult(raw, { runId: run.runId, taskId: task.id });
      if (!v.valid) errors.push(...v.errors.map((m) => `run ${run.runId}: worker result: ${m}`));
      else workerResult = v.result;
    }
  }

  if (task.data.status !== 'REVIEW') {
    errors.push(`${task.id} is ${task.data.status}; gate execution requires REVIEW`);
  }

  const required = resolveRequiredGates(task);
  errors.push(...checkGateRefs(task, gateConfig));

  return { ok: errors.length === 0, errors, envelope, workerResult, required, gateConfig };
}

/**
 * Gate 하나를 Runtime 소유 subprocess로 실행한다.
 * 명령 문자열은 Runtime 설정에서만 오고, 여기서 조립되거나 확장되지 않는다.
 *
 * Worker self-check(gate/self-check.mjs)도 이 함수를 그대로 쓴다 — 같은 명령을
 * 두 가지 방식으로 실행하는 경로를 만들지 않기 위해서다. 다만 self-check는
 * Run 디렉터리가 아닌 scratch 디렉터리를 주고, Gate Report를 만들지 않는다.
 */
export function executeGate({ def, runDir, timeoutSeconds }) {
  const dir = gateDir(runDir, def.name);
  mkdirSync(dir, { recursive: true });
  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');
  const startedAt = new Date();

  const finish = (extra) => {
    const finishedAt = new Date();
    return {
      name: def.name,
      status: extra.status,
      command: def.command,
      cwd: relFromRoot(gateCwd(def)) || '.',
      enabled: def.enabled,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt - startedAt,
      exit_code: extra.exit_code ?? null,
      signal: extra.signal ?? null,
      timed_out: extra.timed_out ?? false,
      timeout_seconds: timeoutSeconds,
      stdout_bytes: extra.stdout_bytes ?? 0,
      stderr_bytes: extra.stderr_bytes ?? 0,
      stdout_file: `${GATES_DIR}/${def.name}/stdout.log`,
      stderr_file: `${GATES_DIR}/${def.name}/stderr.log`,
      stdout_sha256: sha256File(stdoutPath),
      stderr_sha256: sha256File(stderrPath),
      error: extra.error ?? null,
    };
  };

  // 실행 불가 조건은 프로세스를 띄우기 전에 ERROR로 확정한다. PASS를 지어내지 않는다.
  const preflightError = (() => {
    if (!def.enabled) {
      return `gate "${def.name}" is disabled in project.yaml${def.reason ? ` (${def.reason})` : ''}`;
    }
    if (!def.command) return `gate "${def.name}" has no command configured`;
    if (!gateCwdExists(def)) return `working directory does not exist: ${relFromRoot(gateCwd(def))}`;
    return null;
  })();

  if (preflightError) {
    try {
      writeFileSync(stdoutPath, '', 'utf8');
      writeFileSync(stderrPath, `${preflightError}\n`, 'utf8');
    } catch { /* 아래에서 write 실패로 보고된다 */ }
    const rec = finish({ status: 'ERROR', error: preflightError, stderr_bytes: Buffer.byteLength(`${preflightError}\n`) });
    return Promise.resolve(rec);
  }

  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let writeError = null;
    let exitCode = null;
    let signal = null;

    const out = createWriteStream(stdoutPath);
    const err = createWriteStream(stderrPath);
    out.on('error', (e) => { writeError ??= `stdout artifact write failed: ${e.message}`; });
    err.on('error', (e) => { writeError ??= `stderr artifact write failed: ${e.message}`; });

    let child;
    try {
      child = spawn(def.command, {
        cwd: gateCwd(def),
        shell: true,          // 플랫폼 기본 shell (POSIX: /bin/sh, Windows: cmd.exe)
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        // POSIX: 자체 process group으로 띄운다. shell이 만든 자식까지 한 번에 종료하기 위해서다.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      out.end();
      err.end();
      return resolve(finish({ status: 'ERROR', error: `could not launch gate: ${e.message}` }));
    }

    let launchError = null;
    child.on('error', (e) => {
      launchError ??= `could not launch gate: ${e.message}`;
      // spawn 실패 시 stdio는 end 없이 destroy된다. pipe가 스트림을 닫아주지 않으므로 직접 닫는다.
      child.stdout?.unpipe(out);
      child.stderr?.unpipe(err);
      out.end();
      err.end();
    });

    child.stdout.on('data', (c) => { stdoutBytes += c.length; });
    child.stderr.on('data', (c) => { stderrBytes += c.length; });
    child.stdout.pipe(out);
    child.stderr.pipe(err);

    // shell이 만든 자식까지 확실히 정리한다. shell만 죽이면 손자 프로세스가 파이프를 붙든 채 남는다.
    const killTree = (signalName) => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          process.kill(-child.pid, signalName);
        }
      } catch {
        try { child.kill(signalName); } catch { /* 이미 종료됨 */ }
      }
    };

    let childClosed = false;
    let outClosed = false;
    let errClosed = false;
    let forced = false;
    let settled = false;
    const timers = [];
    const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); return t; };

    const settle = () => {
      if (settled) return;
      if (!forced && !(childClosed && outClosed && errClosed)) return;
      settled = true;
      for (const t of timers) clearTimeout(t);

      let status;
      let error = null;
      if (launchError) { status = 'ERROR'; error = launchError; }
      else if (timedOut) { status = 'TIMEOUT'; error = `gate exceeded ${timeoutSeconds}s`; }
      else if (writeError) { status = 'ERROR'; error = writeError; }
      else if (exitCode === 0) status = 'PASS';
      else if (exitCode === null) { status = 'ERROR'; error = `gate terminated by signal ${signal ?? 'unknown'}`; }
      else status = 'FAIL';
      if (forced && timedOut) error = `gate exceeded ${timeoutSeconds}s and did not exit after SIGKILL`;

      resolve(finish({
        status, error, exit_code: exitCode, signal, timed_out: timedOut,
        stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes,
      }));
    };

    timers.push(setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      later(() => killTree('SIGKILL'), KILL_GRACE_MS);
      // SIGKILL 후에도 파이프가 닫히지 않으면 관찰을 포기하고 TIMEOUT으로 확정한다. 매달리지 않는다.
      later(() => {
        forced = true;
        child.stdout?.unpipe(out);
        child.stderr?.unpipe(err);
        out.end();
        err.end();
        settle();
      }, KILL_GRACE_MS * 2);
    }, timeoutSeconds * 1000));

    child.on('close', (code, sig) => { exitCode = code; signal = sig; childClosed = true; settle(); });
    out.on('close', () => { outClosed = true; settle(); });
    err.on('close', () => { errClosed = true; settle(); });
  });
}

/**
 * 필수 Gate를 설정 순서대로, 순차적으로 모두 실행한다.
 * 앞선 Gate가 실패해도 멈추지 않는다 — 한 번의 실행으로 완전한 진단 리포트를 얻기 위해서다.
 */
export async function executeGateSuite({ task, run, config, required, gateConfig, onGateFinish }) {
  const startedAt = new Date();
  // Gate가 실제로 검사한 저장소 상태를 기록해 둔다. Verifier는 이 값과 대조한다.
  const subject = subjectRef(computeSubject(ROOT));
  const gateResults = [];
  for (const name of required.names) {
    const def = gateConfig.gates[name];
    const timeoutSeconds = gateTimeoutSeconds(config, def);
    const rec = await executeGate({ def, runDir: run.runDir, timeoutSeconds });
    writeFileSync(join(gateDir(run.runDir, name), 'result.json'), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
    for (const f of ['stdout.log', 'stderr.log', 'result.json']) freeze(join(gateDir(run.runDir, name), f));
    gateResults.push(rec);
    onGateFinish?.(rec);
  }
  const finishedAt = new Date();

  const report = buildGateReport({
    runId: run.runId,
    taskId: task.id,
    task,
    required,
    gateConfig,
    gateResults,
    startedAt,
    finishedAt,
    attempt: priorGateAttempts(run.runDir) + 1,
    subject,
  });
  const path = writeGateReport(run.runDir, report);
  return { report, reportPath: path };
}

export { reportPath, readGateReport, archivePriorGateEvidence, resolveRequiredGates, loadGateConfig, checkGateRefs };

/**
 * VERIFY_READY — Task YAML에 저장되지 않는 파생 상태. Runtime이 매번 계산한다.
 * 조건: status == REVIEW · Worker Result 유효 · policy violation 없음 ·
 *       필수 Gate 전부에 대한 정본 Gate Report 존재 · 전체 결과 PASS · Verifier 판정이 필요함.
 */
export function deriveVerifyReady({ task, config }) {
  const reasons = [];
  const run = latestRunForTask(task.id);
  if (!run) {
    return { ready: false, reasons: ['no completed worker run'], run: null, report: null };
  }

  const eligibility = checkEligibility({ task, run, config });
  reasons.push(...eligibility.errors);

  const current = subjectRef(computeSubject(ROOT));
  let stale = false;
  const report = readGateReport(run.runDir);
  if (report === null) {
    reasons.push('no gate report for this run');
  } else if (report.corrupt) {
    reasons.push('gate-report.json is corrupt');
  } else {
    // Gate Report는 "지금의 필수 Gate"에 대한 것이어야 한다. Task가 바뀌었으면 stale이다.
    const same = JSON.stringify(report.required_gates) === JSON.stringify(eligibility.required.names);
    if (!same) reasons.push('gate report is stale — required gates changed since it was written');
    if (report.result !== 'PASS') reasons.push(`gate result is ${report.result}`);
    // Gate 결과는 그것이 실제로 검사한 저장소 상태에만 유효하다.
    if (!report.verification_subject?.sha256) {
      reasons.push('gate report predates verification-subject binding — rerun gates');
      stale = true;
    } else if (!sameSubject(report.verification_subject, current)) {
      reasons.push('verification subject changed since gates ran — rerun gates');
      stale = true;
    }
  }

  const requiresVerifier = task.data.stop_condition.requires_verifier === true
    || task.data.acceptance_criteria.some((ac) => ac.verification.type === 'verifier');
  if (!requiresVerifier) reasons.push('task does not require verifier evaluation');

  return { ready: reasons.length === 0, reasons, run, report, requiresVerifier, stale, subject: current };
}
