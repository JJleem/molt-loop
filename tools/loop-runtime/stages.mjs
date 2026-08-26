// stages — Runtime 단계 실행의 단일 진입점.
//
// 수동 CLI(loopctl run/gate/verify/retry)와 자동 오케스트레이터가 **같은 함수**를 부른다.
// 그래야 두 경로의 의미가 갈라지지 않는다. CLI는 인터페이스일 뿐이고 여기가 실행의 출처다.
//
// 이 파일은 출력하지 않는다. 구조화된 결과만 돌려준다.
// 상태 전이는 여전히 task-store.writeStatus() 하나만 거친다(Single Writer).


import { join } from 'node:path';
import {
  LOCAL_DIR, isExample, isAutoDispatchable, isPaused, writeStatus,
  loadAllTasks, checkDependencies,
} from './task-store.mjs';
import { writeSnapshot } from './context-builder.mjs';
import { runWorkerOnce } from './worker/runner.mjs';
import {
  checkEligibility, executeGateSuite, readGateReport, archivePriorGateEvidence,
} from './gate/runner.mjs';
import {
  checkVerifierEligibility, runVerifierOnce, verificationDirFor, readVerificationReport,
  archivePriorVerification,
} from './verifier/runner.mjs';
import { checkRetryEligibility, writeRetrySnapshot } from './recovery/retry.mjs';

/**
 * 첫 Attempt 준비 — 실행 자격 확인 + TODO -> IN_PROGRESS + Snapshot.
 * `run`의 의미를 그대로 유지한다. 재시도 경로가 이 검사를 우회하지 않는다.
 * @returns {{ ok, errors, claim?, snapshot? }}
 */
export function startFirstAttempt({ task, config, tasks = null }) {
  if (isPaused()) {
    return { ok: false, errors: [`PAUSE is active (${join(LOCAL_DIR, 'PAUSE')}).`, '  Remove that file to run workers.'] };
  }
  const notRunnable = (why) => ({
    ok: false,
    errors: [
      `${task.id} is not ready for Worker execution.`,
      `  Current state: ${task.data.status}`,
      `  ${why}`,
    ],
  });
  if (isExample(task)) return notRunnable('This is the example task and is never dispatched.');
  if (!isAutoDispatchable(task)) return notRunnable('auto_dispatch is false.');
  if (task.data.status !== 'TODO') {
    return notRunnable(task.data.status === 'REVIEW'
      ? 'Worker execution requires TODO. This task is awaiting gates/verification — try `loopctl gate` or `loopctl verify`.'
      : 'Worker execution requires TODO.');
  }

  // 선행 Task 검사 — run과 execute가 여기 하나를 공유한다. CLI 쪽에서 다시 구현하지 않는다.
  const deps = checkDependencies(task, tasks ?? loadAllTasks());
  if (!deps.met) {
    const lines = [`${task.id} is not ready.`, ''];
    if (deps.waiting_on.length > 0) {
      lines.push('Waiting on:');
      for (const d of deps.waiting_on) lines.push(`  ${d}`);
    }
    if (deps.missing.length > 0) {
      lines.push('Unresolvable dependencies:');
      for (const d of deps.missing) lines.push(`  ${d}  (not found or invalid)`);
    }
    return { ok: false, errors: lines, dependencies: deps };
  }

  const claim = writeStatus(task, 'IN_PROGRESS');
  if (!claim.ok) return { ok: false, errors: [claim.reason] };
  task.data.status = 'IN_PROGRESS';

  let snapshot;
  try {
    snapshot = writeSnapshot(task, { attempt: 1 });
  } catch (e) {
    return { ok: false, errors: [`Snapshot failed: ${e.message}`, `${task.id} remains IN_PROGRESS — no worker was launched.`], claim };
  }
  return { ok: true, errors: [], claim, snapshot, attempt: 1 };
}

/**
 * 재시도 Attempt 준비 — 진단 기반 자격 확인 + (필요시) REVIEW -> IN_PROGRESS + Snapshot.
 * @returns {{ ok, errors, pre, transition?, snapshot?, attempt? }}
 */
export function startRetryAttempt({ task, run, config }) {
  const pre = checkRetryEligibility({ task, run, config });
  if (!pre.ok) return { ok: false, errors: pre.errors, pre };

  let transition = null;
  if (pre.needsTransition) {
    const moved = writeStatus(task, 'IN_PROGRESS');
    if (!moved.ok) return { ok: false, errors: [moved.reason], pre };
    task.data.status = 'IN_PROGRESS';
    transition = moved;
  }

  let snapshot;
  try {
    snapshot = writeRetrySnapshot({
      task, sourceRun: run, diagnosis: pre.assessment.diagnosis, memos: pre.memos, attempt: pre.nextAttempt,
    });
  } catch (e) {
    return { ok: false, errors: [`Snapshot failed: ${e.message}`], pre, transition };
  }
  return { ok: true, errors: [], pre, transition, snapshot, attempt: pre.nextAttempt };
}

/**
 * Worker 1회 실행 + 요청된 전이 적용. 첫 시도와 재시도가 공유한다.
 * @returns {{ ok, envelope?, workerResult?, failures, transition: object|null, launchError?: string }}
 */
export async function stageWorker({ task, snapshot, config, attempt }) {
  let outcome;
  try {
    outcome = await runWorkerOnce({ task, snapshot, config, attempt });
  } catch (e) {
    return { ok: false, failures: [`Worker could not be launched: ${e.message}`], launchError: e.message, transition: null };
  }
  const { envelope, workerResult, failures } = outcome;
  if (failures.length > 0) {
    return { ok: false, envelope, workerResult, failures, transition: null };
  }

  const requested = workerResult.requested_transition;
  if (requested === null) {
    return { ok: true, envelope, workerResult, failures: [], transition: null };
  }
  const applied = writeStatus(task, requested);
  if (!applied.ok) {
    return { ok: false, envelope, workerResult, failures: [applied.reason], transition: null };
  }
  task.data.status = applied.to;
  return { ok: true, envelope, workerResult, failures: [], transition: applied };
}

/**
 * 결정론적 Gate 실행. LLM을 호출하지 않는다.
 * @returns {{ ok, refused?, errors, report?, reportPath?, duplicate?: object, archived?: string|null }}
 */
export async function stageGate({ task, run, config, rerun = false, onGateFinish, dryRun = false }) {
  if (isExample(task)) return { ok: false, refused: true, errors: [`${task.id} is an example task and is not gateable.`] };

  const eligibility = checkEligibility({ task, run, config });
  if (!eligibility.ok) return { ok: false, refused: true, errors: eligibility.errors, eligibility };

  const existing = readGateReport(run.runDir);
  if (existing && !rerun) return { ok: false, refused: true, duplicate: existing, errors: [], eligibility };

  // dryRun은 자격/중복만 확인하고 아무것도 실행하거나 옮기지 않는다.
  if (dryRun) return { ok: true, dryRun: true, errors: [], eligibility, willArchive: Boolean(existing) };

  let archived = null;
  if (existing && rerun) archived = archivePriorGateEvidence(run.runDir);

  const { required, gateConfig } = eligibility;
  const { report, reportPath } = await executeGateSuite({
    task, run, config, required, gateConfig, onGateFinish,
  });
  return { ok: true, errors: [], report, reportPath, eligibility, archived, required };
}

/**
 * 독립 Verifier 1회 실행 + Runtime Verification Report가 PASS일 때만 REVIEW -> DONE.
 * @returns {{ ok, refused?, errors, outcome?, report?, transition: object|null, duplicate?: object }}
 */
export async function stageVerify({ task, run, config, rerun = false, onLaunch, dryRun = false }) {
  if (isExample(task)) return { ok: false, refused: true, errors: [`${task.id} is an example task and is not verifiable.`], transition: null };

  const eligibility = checkVerifierEligibility({ task, run, config });
  if (!eligibility.ok) return { ok: false, refused: true, errors: eligibility.errors, eligibility, transition: null };

  const vdir = verificationDirFor(run.runDir);
  const existing = readVerificationReport(vdir);
  if (existing && !rerun) return { ok: false, refused: true, duplicate: existing, errors: [], eligibility, transition: null };

  if (dryRun) return { ok: true, dryRun: true, errors: [], eligibility, transition: null, willArchive: Boolean(existing) };

  let archived = null;
  if (existing && rerun) archived = archivePriorVerification(vdir);

  let outcome;
  try {
    outcome = await runVerifierOnce({ task, run, config, eligibility, onLaunch });
  } catch (e) {
    return { ok: false, errors: [`Verifier could not be launched: ${e.message}`], transition: null, launchError: e.message };
  }

  const { report } = outcome;
  if (report.result !== 'PASS') {
    return { ok: true, errors: [], outcome, report, transition: null, archived };
  }
  // Runtime Verification Report가 PASS일 때만 상태를 쓴다. 전이 표를 우회하지 않는다.
  const applied = writeStatus(task, 'DONE');
  if (!applied.ok) {
    return { ok: false, errors: [applied.reason], outcome, report, transition: null, archived };
  }
  task.data.status = 'DONE';
  return { ok: true, errors: [], outcome, report, transition: applied, archived };
}

