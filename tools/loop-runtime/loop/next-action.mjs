// loop/next-action — "지금 이 Task에 대해 Runtime이 할 수 있는 다음 합법 행동은 무엇인가".
//
// 결정론적이다. 다음에 무엇을 할지 LLM에게 묻지 않는다.
// 판단 근거는 디스크에 있는 정본 artifact뿐이며, 매번 새로 읽는다.
//
// 여기서 반환하는 action은 오케스트레이션 내부 개념이다.
// Task YAML에 저장되지 않고 새로운 Task 상태를 만들지도 않는다.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isExample, isAutoDispatchable } from '../task-store.mjs';
import { computeSubject, subjectRef } from '../subject.mjs';
import { latestRunForTask, deriveVerifyReady } from '../gate/runner.mjs';
import { readGateReport } from '../gate/report.mjs';
import { readVerificationReport } from '../verifier/report.mjs';
import { verificationDirFor } from '../verifier/runner.mjs';
import { assess } from '../recovery/retry.mjs';
import { RETRYABLE_ACTIONS, readDiagnosis } from '../recovery/diagnose.mjs';
import { attemptHistory } from '../recovery/limits.mjs';

export const ACTIONS = [
  'RUN_WORKER', 'RUN_GATES', 'RUN_VERIFIER', 'RETRY_WORKER', 'DONE',
  'STOP_BLOCKED', 'STOP_NEEDS_HUMAN', 'STOP_LIMIT', 'STOP_STALLED', 'STOP_AMBIGUOUS', 'STOP_REFUSED',
];

const A = (action, reason, extra = {}) => ({ action, reason, ...extra });

/**
 * 정체 감지 — Step 6이 남긴 지문만 쓴다. 보수적으로, 확실할 때만 STALLED로 본다.
 * 규칙: 직전 Attempt와 **같은 failure fingerprint** 이고,
 *       재시도가 저장소 상태를 **전혀 바꾸지 못했을 때**(worker 직후 subject가 동일).
 * 애매하면 발동하지 않는다. 최종 안전망은 attempt 한도다.
 */
export function detectStagnation({ task, run, diagnosis }) {
  if (!diagnosis?.failure_fingerprint) return null;
  const history = attemptHistory(task.id);
  const current = history.find((h) => h.runId === run.runId);
  const parentId = current?.lineage?.parent_run_id;
  if (!parentId) return null;
  const parent = history.find((h) => h.runId === parentId);
  if (!parent) return null;

  const parentDiag = readDiagnosis(parent.runDir);
  if (!parentDiag || parentDiag.corrupt) return null;
  if (parentDiag.failure_fingerprint !== diagnosis.failure_fingerprint) return null;

  // 재시도가 실제로 무언가 바꿨는가. Worker 직후 subject 지문으로 판단한다.
  const envOf = (dir) => {
    const p = join(dir, 'runtime-envelope.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  };
  const a = envOf(parent.runDir)?.verification_subject_after?.sha256 ?? null;
  const b = envOf(current.runDir)?.verification_subject_after?.sha256 ?? null;
  if (!a || !b || a !== b) return null;   // 증명할 수 없으면 발동하지 않는다

  return {
    fingerprint: diagnosis.failure_fingerprint,
    parent_run_id: parentId,
    subject_sha256: a,
    reason: `attempt ${current.attempt} reproduced the exact failure of attempt ${parent.attempt} `
      + 'and left the repository in an identical state.',
  };
}

/** 실패한 Run 하나에 대해 회복 정책을 적용해 다음 action을 정한다. */
function recoveryAction({ task, run, config, subject }) {
  const assessment = assess({ task, run, config, subject });
  const { diagnosis, budget } = assessment;

  if (diagnosis.failure_class === null) {
    return A('STOP_AMBIGUOUS', `${run.runId} shows no failure but the task is not finished.`, { assessment });
  }

  const stagnation = detectStagnation({ task, run, diagnosis });
  if (stagnation) {
    return A('STOP_STALLED', stagnation.reason, { assessment, stagnation });
  }

  if (!RETRYABLE_ACTIONS.includes(diagnosis.recommended_action)) {
    // RERUN_GATES는 subject가 흔들렸다는 뜻이다. 공유 작업 트리에서 그 원인을 증명할 수 없으므로
    // 자동으로 Gate를 다시 돌리지 않는다(fail-closed).
    if (diagnosis.recommended_action === 'RERUN_GATES') {
      return A('STOP_AMBIGUOUS',
        'the verification subject moved during verification; the runtime cannot prove it is safe to rerun gates automatically.',
        { assessment });
    }
    return A('STOP_NEEDS_HUMAN', diagnosis.reason, { assessment });
  }

  if (!budget.allowed) {
    return A('STOP_LIMIT', budget.reasons.join('; '), { assessment });
  }
  return A('RETRY_WORKER', `${diagnosis.failure_class} -> ${diagnosis.recommended_action}`, { assessment, run });
}

/**
 * 다음 행동을 정한다. 호출자는 매 단계 전에 Task를 디스크에서 다시 읽어 넘겨야 한다.
 * @returns {{ action, reason, run?, assessment?, stagnation? }}
 */
export function resolveNextAction({ task, config }) {
  const subject = subjectRef(computeSubject(ROOT));

  if (isExample(task)) return A('STOP_REFUSED', `${task.id} is the example task and is never executed.`);
  if (!isAutoDispatchable(task)) return A('STOP_REFUSED', `${task.id} has auto_dispatch: false.`);

  const status = task.data.status;
  if (status === 'DROPPED') return A('STOP_REFUSED', `${task.id} is DROPPED.`);
  if (status === 'DONE') return A('DONE', `${task.id} is already DONE.`);
  if (status === 'BLOCKED') return A('STOP_BLOCKED', `${task.id} is BLOCKED and needs a human decision.`);
  if (status === 'TODO') return A('RUN_WORKER', 'first attempt');

  const run = latestRunForTask(task.id);

  if (status === 'IN_PROGRESS') {
    if (!run) {
      return A('STOP_AMBIGUOUS', `${task.id} is IN_PROGRESS but has no completed worker run; the runtime cannot tell whether a worker is still executing.`);
    }
    return recoveryAction({ task, run, config, subject });
  }

  if (status !== 'REVIEW') return A('STOP_AMBIGUOUS', `unexpected task status "${status}".`);

  // ---- REVIEW: 어디까지 진행됐는지 정본 artifact로만 판단한다.
  if (!run) return A('STOP_AMBIGUOUS', `${task.id} is REVIEW but has no completed worker run.`);

  const vr = readVerificationReport(verificationDirFor(run.runDir));
  if (vr && !vr.corrupt) {
    if (vr.result === 'PASS') {
      // PASS인데 DONE이 아니다 — Runtime 상태가 서로 맞지 않는다. 추측하지 않는다.
      return A('STOP_AMBIGUOUS', `${run.runId} has a PASS verification report but ${task.id} is still REVIEW.`);
    }
    return recoveryAction({ task, run, config, subject });
  }
  if (vr?.corrupt) return A('STOP_AMBIGUOUS', `${run.runId}: verification-report.json is corrupt.`);

  const gate = readGateReport(run.runDir);
  if (gate === null) return A('RUN_GATES', 'no gate report for the latest run', { run });
  if (gate.corrupt) return A('STOP_AMBIGUOUS', `${run.runId}: gate-report.json is corrupt.`);

  const v = deriveVerifyReady({ task, config });
  if (v.stale) {
    // Gate 결과가 지금의 저장소 상태에 묶여 있지 않다. 공유 작업 트리에서 원인을 증명할 수 없다.
    return A('STOP_AMBIGUOUS',
      'the repository changed after gates ran; the runtime cannot prove that rerunning gates is safe.', { run });
  }
  if (gate.result !== 'PASS') return recoveryAction({ task, run, config, subject });

  if (!v.requiresVerifier) {
    return A('STOP_NEEDS_HUMAN',
      `${task.id} passed its gates but requires no independent verification; gate-only completion is not implemented.`, { run });
  }
  if (v.ready) return A('RUN_VERIFIER', 'gates passed and the run is verify-ready', { run });

  return A('STOP_AMBIGUOUS', `${run.runId} is not verify-ready: ${v.reasons.join('; ')}`, { run });
}
