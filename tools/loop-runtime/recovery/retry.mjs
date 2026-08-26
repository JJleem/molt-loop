// recovery/retry — 진단에 근거한 **명시적** Worker 재시도 1회.
//
// Retry != Loop. 실패를 분류하고 다음 Attempt가 받을 정보를 바꾼 뒤에만 다시 실행한다.
// 자동 연쇄(Worker -> Gate -> Verifier -> Retry)는 여기에 없다. 운영자가 각 단계를 호출한다.
//
// 이 파일은 Task 상태를 직접 쓰지 않는다. 전이는 loopctl이 task-store를 통해서만 수행한다.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isExample, isAutoDispatchable, isPaused } from '../task-store.mjs';
import { computeSubject, subjectRef } from '../subject.mjs';
import { writeSnapshot } from '../context-builder.mjs';
import { getDiagnosis, readDiagnosis, RETRYABLE_ACTIONS } from './diagnose.mjs';
import { getFailureMemo, readFailureMemo } from './failure-memo.mjs';
import { checkRetryBudget, attemptHistory } from './limits.mjs';

/**
 * 실패한 Run 하나에 대한 진단 + Memo. diagnose 명령과 retry가 같은 경로를 쓴다.
 * (진단 로직을 두 곳에 복제하지 않는다.)
 */
export function assess({ task, run, config, subject = null }) {
  const current = subject ?? subjectRef(computeSubject(ROOT));
  const { diagnosis, reused, archived } = getDiagnosis({ task, run, config, subject: current });
  const memoResult = getFailureMemo({ diagnosis, run });
  const budget = checkRetryBudget({ task, config, action: diagnosis.recommended_action });
  return { diagnosis, diagnosisReused: reused, archived, memo: memoResult.memo, memoReason: memoResult.reason, budget, subject: current };
}

/**
 * lineage를 따라 올라가며 이전 Attempt들의 증류된 Memo를 모은다.
 * Run 내용 전체를 옮기지 않는다. 개수는 attempt 상한이 자연스럽게 묶어 준다.
 */
export function collectMemoChain(taskId, sourceRunId) {
  const byId = new Map(attemptHistory(taskId).map((h) => [h.runId, h]));
  const chain = [];
  let cursor = sourceRunId;
  const seen = new Set();
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const h = byId.get(cursor);
    const memo = readFailureMemo(h.runDir);
    if (memo && !memo.corrupt) chain.push(memo);
    cursor = h.lineage?.parent_run_id ?? null;
  }
  return chain.sort((a, b) => a.attempt - b.attempt);
}

/**
 * 유료 Worker를 다시 띄우기 전 preflight. 하나라도 걸리면 AI를 호출하지 않는다.
 * @returns {{ ok: boolean, errors: string[], assessment, nextAttempt, memos }}
 */
export function checkRetryEligibility({ task, run, config, subject = null }) {
  const errors = [];
  const assessment = assess({ task, run, config, subject });
  const { diagnosis, budget } = assessment;

  if (isPaused()) errors.push('PAUSE is active. Remove .loop-local/PAUSE to run workers.');
  if (isExample(task)) errors.push(`${task.id} is the example task and is never dispatched.`);
  if (!isAutoDispatchable(task)) errors.push(`${task.id} has auto_dispatch: false.`);

  if (!existsSync(join(run.runDir, 'runtime-envelope.json'))) {
    errors.push(`run ${run.runId} has no completed worker attempt to retry.`);
  }

  // 재시도는 실패한 Attempt가 남긴 저장소 상태 위에서만 안전하다.
  // 진단은 이 경우를 이미 RECOVERY_AMBIGUOUS로 낮췄지만, 운영자에게는 일반 메시지 대신
  // 무엇이 문제인지 그대로 말해 준다.
  const sc = diagnosis.subject_check;
  const downgraded = diagnosis.subject_downgraded === true;
  const drifted = downgraded && Boolean(sc?.bound_to) && sc.matches === false;
  const unknownSubject = downgraded && Boolean(sc) && !sc.bound_to;

  if (diagnosis.failure_class === null) {
    errors.push(`${run.runId} has no recorded failure — there is nothing to retry.`);
  } else if (!downgraded && !RETRYABLE_ACTIONS.includes(diagnosis.recommended_action)) {
    // 실패 자체가 재시도 대상이 아니다 (policy violation · gate ERROR · verifier 사고 ...).
    // 저장소 상태보다 이쪽이 더 강한 차단 사유이므로 먼저 보고한다.
    errors.push(`latest failure is ${diagnosis.failure_class}, recommended action ${diagnosis.recommended_action}.`);
    errors.push(`  ${diagnosis.reason}`);
  } else if (drifted) {
    errors.push(`repository state changed since ${run.runId}.`);
    errors.push('  a retry would be layered onto unrelated working-tree changes.');
    errors.push('  inspect the changes and re-establish a known subject, then rerun gates.');
  } else if (unknownSubject) {
    errors.push(`the runtime cannot prove which repository state ${run.runId} left behind.`);
    errors.push('  this run predates verification-subject recording; another worker attempt is not provably safe.');
  } else if (!RETRYABLE_ACTIONS.includes(diagnosis.recommended_action)) {
    errors.push(`latest failure is ${diagnosis.failure_class}, recommended action ${diagnosis.recommended_action}.`);
    errors.push(`  ${diagnosis.reason}`);
  }

  if (!assessment.memo && RETRYABLE_ACTIONS.includes(diagnosis.recommended_action)
      && diagnosis.recommended_action === 'RETRY_WITH_HINT') {
    errors.push(`no failure memo could be distilled (${assessment.memoReason ?? 'unknown'}).`);
  }

  if (!budget.allowed) errors.push(...budget.reasons);

  // Gate/Verifier 실패는 REVIEW에서, Worker 실패는 IN_PROGRESS에서 재시도한다.
  const st = task.data.status;
  if (st !== 'REVIEW' && st !== 'IN_PROGRESS') {
    errors.push(`${task.id} is ${st}; retry requires REVIEW (gate/verifier failure) or IN_PROGRESS (worker failure).`);
  }

  const memos = collectMemoChain(task.id, run.runId);
  return {
    ok: errors.length === 0,
    errors,
    assessment,
    nextAttempt: budget.nextAttempt,
    memos,
    needsTransition: st === 'REVIEW',
  };
}

/**
 * 재시도 Attempt의 Snapshot을 만든다. lineage와 증류된 Memo만 넘긴다.
 * Worker 실행 자체는 기존 worker/runner를 그대로 쓴다 — retry 전용 adapter는 만들지 않는다.
 */
export function writeRetrySnapshot({ task, sourceRun, diagnosis, memos, attempt }) {
  const history = attemptHistory(task.id);
  const sourceEntry = history.find((h) => h.runId === sourceRun.runId);
  const rootRunId = sourceEntry?.lineage?.root_run_id ?? sourceRun.runId;

  return writeSnapshot(task, {
    attempt,
    failureMemos: memos,
    lineage: {
      root_run_id: rootRunId,
      parent_run_id: sourceRun.runId,
      retry_reason: diagnosis.failure_class,
      retry_action: diagnosis.recommended_action,
      parent_failure_fingerprint: diagnosis.failure_fingerprint,
      failure_memo: `${sourceRun.runId}/recovery/failure-memo.json`,
    },
  });
}

export { readDiagnosis, readFailureMemo, attemptHistory };
