// recovery/limits — 재시도 예산. 정책은 .loop/policies/limits.yaml 한 곳에서만 온다.
//
// 사다리(escalation ladder):
//   attempt 1        최초 시도
//   RETRY            transient 실패에 대한 평범한 재시도       (retry_max 회)
//   RETRY_WITH_HINT  Failure Memo의 lesson을 주입한 재시도     (hint_retry_max 회)
//   그 다음           needs-human
//
// 예산을 넘기면 조용히 초과하지 않고 거부한다.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns } from '../gate/runner.mjs';
import { readDiagnosis, RECOVERY_DIR } from './diagnose.mjs';

/** Task 하나의 Attempt 이력. Run manifest가 정본이며 Worker가 신고한 값은 쓰지 않는다. */
export function attemptHistory(taskId) {
  return listRuns()
    .filter((r) => r.taskId === taskId && r.manifest)
    .map((r) => ({
      runId: r.runId,
      runDir: r.runDir,
      attempt: Number.isInteger(r.manifest.attempt) ? r.manifest.attempt : 1,
      lineage: r.manifest.lineage ?? null,
      hasEnvelope: r.hasEnvelope,
    }))
    .sort((a, b) => (a.attempt - b.attempt) || (a.runId < b.runId ? -1 : 1));
}

/**
 * 지금까지 쓴 재시도 예산. lineage에 기록된 retry_action을 센다.
 * @returns {{ attempts, plainRetries, hintRetries, consecutiveFailures }}
 */
export function budgetUsed(taskId) {
  const history = attemptHistory(taskId);
  let plainRetries = 0;
  let hintRetries = 0;
  for (const h of history) {
    if (h.lineage?.retry_action === 'RETRY') plainRetries += 1;
    if (h.lineage?.retry_action === 'RETRY_WITH_HINT') hintRetries += 1;
  }
  // 연속 실패 — 진단이 남아 있는 Attempt를 뒤에서부터 센다. V0에서 DONE은 종단이므로
  // 성공 후 실패가 이어지는 경우는 없고, 사실상 진단된 실패의 개수와 같다.
  let consecutiveFailures = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const d = readDiagnosis(history[i].runDir);
    if (d && !d.corrupt && d.failure_class !== null) consecutiveFailures += 1;
    else break;
  }
  return {
    attempts: history.length === 0 ? 0 : Math.max(...history.map((h) => h.attempt)),
    plainRetries,
    hintRetries,
    consecutiveFailures,
    history,
  };
}

/**
 * 이 Task에 적용되는 실효 한도. Task가 max_consecutive_failures를 직접 정하면 그것이 우선한다.
 */
export function effectiveLimits(task, config) {
  const policy = config.limits;
  return {
    max_attempts: policy.max_attempts,
    max_consecutive_failures: task.data.stop_condition.max_consecutive_failures ?? policy.max_consecutive_failures,
    retry_max: policy.retry_max,
    hint_retry_max: policy.hint_retry_max,
    source: policy.source,
  };
}

/**
 * 권고된 action을 실제로 수행할 예산이 남아 있는가.
 * @returns {{ allowed: boolean, reasons: string[], limits, used, nextAttempt }}
 */
export function checkRetryBudget({ task, config, action }) {
  const limits = effectiveLimits(task, config);
  const used = budgetUsed(task.id);
  const reasons = [];
  const nextAttempt = used.attempts + 1;

  if (used.attempts >= limits.max_attempts) {
    reasons.push(`maximum attempts reached (${used.attempts}/${limits.max_attempts})`);
  }
  if (used.consecutiveFailures >= limits.max_consecutive_failures) {
    reasons.push(`maximum consecutive failures reached (${used.consecutiveFailures}/${limits.max_consecutive_failures})`);
  }
  if (action === 'RETRY' && used.plainRetries >= limits.retry_max) {
    reasons.push(`plain retry budget exhausted (${used.plainRetries}/${limits.retry_max}) — escalation.retry_max`);
  }
  if (action === 'RETRY_WITH_HINT' && used.hintRetries >= limits.hint_retry_max) {
    reasons.push(`hint retry budget exhausted (${used.hintRetries}/${limits.hint_retry_max}) — escalation.hint_retry_max`);
  }

  return { allowed: reasons.length === 0, reasons, limits, used, nextAttempt };
}

export { RECOVERY_DIR };
export const recoveryDirFor = (runDir) => join(runDir, RECOVERY_DIR);
export const readJsonSafe = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { corrupt: true }; }
};
