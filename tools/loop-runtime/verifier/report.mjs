// verifier/report — Runtime이 쓰는 최종 Verification Report.
//
// 이 파일이 완료 판정의 정본이다. Verifier의 `result: "PASS"` 한 필드를 믿지 않는다.
// Gate 사실 · Verifier의 개별 AC 판정 · policy violation · subject 동일성을
// Runtime이 다시 조합해서 결론을 낸다.

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const VERIFICATION_REPORT_FILE = 'verification-report.json';
export const REPORT_SCHEMA = 'loop.verification-report/v0';
export const HISTORY_DIR = 'history';

// Runtime이 검증을 거부/실패시키는 결정론적 사유.
export const VERDICT_REASONS = {
  GATE_NOT_PASS: 'gate result is not PASS',
  WORKER_POLICY_VIOLATION: 'worker policy violation',
  VERIFIER_POLICY_VIOLATION: 'verifier mutated files it must not touch',
  VERIFIER_RESULT_INVALID: 'verifier result did not validate',
  VERIFIER_PROCESS_FAILED: 'verifier process did not complete cleanly',
  VERIFIER_TIMEOUT: 'verifier timed out',
  VERIFIER_FAIL: 'verifier judged one or more acceptance criteria as not satisfied',
  STALE_VERIFICATION_SUBJECT: 'verification subject changed during verification',
};

const reportPath = (dir) => join(dir, VERIFICATION_REPORT_FILE);

export function freeze(path) {
  try { chmodSync(path, 0o444); } catch { /* 지원하지 않으면 무시 */ }
}

export function priorVerificationAttempts(verificationDir) {
  const dir = join(verificationDir, HISTORY_DIR);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

/** --rerun 시 이전 Verifier 산출물(사용량 기록 포함)을 파괴하지 않고 history/<n>/ 으로 옮긴다. */
export function archivePriorVerification(verificationDir) {
  const movable = [
    'context.md', 'manifest.json', 'subject.json', 'canonical-diff.patch',
    'verifier-result.json', 'verifier-envelope.json', VERIFICATION_REPORT_FILE,
    'stdout.log', 'stderr.log',
  ].filter((f) => existsSync(join(verificationDir, f)));
  if (movable.length === 0) return null;

  const historyRoot = join(verificationDir, HISTORY_DIR);
  mkdirSync(historyRoot, { recursive: true });
  let n = priorVerificationAttempts(verificationDir) + 1;
  while (existsSync(join(historyRoot, String(n)))) n += 1;
  const dest = join(historyRoot, String(n));
  mkdirSync(dest, { recursive: true });
  for (const f of movable) renameSync(join(verificationDir, f), join(dest, f));
  return `${HISTORY_DIR}/${n}`;
}

/**
 * 최종 Verification Report. Runtime이 조합하며, 이 함수 밖에서 result를 만들지 않는다.
 * @returns {object}
 */
export function buildVerificationReport({
  runId, taskId, task, attempt, subjectBefore, subjectAfter, gateReport,
  verifierValidation, verifierEnvelope, workerPolicyViolation, startedAt, finishedAt,
}) {
  const blockers = [];

  if (gateReport.result !== 'PASS') blockers.push(VERDICT_REASONS.GATE_NOT_PASS);
  if (workerPolicyViolation) blockers.push(VERDICT_REASONS.WORKER_POLICY_VIOLATION);
  if (verifierEnvelope.verifier_policy_violation) blockers.push(VERDICT_REASONS.VERIFIER_POLICY_VIOLATION);
  if (!verifierValidation.valid) blockers.push(VERDICT_REASONS.VERIFIER_RESULT_INVALID);

  // 프로세스가 깨끗하게 끝나지 않았으면 결과 JSON이 유효해 보여도 신뢰하지 않는다.
  const proc = verifierEnvelope.process;
  if (proc.launch_error) blockers.push(`${VERDICT_REASONS.VERIFIER_PROCESS_FAILED}: ${proc.launch_error}`);
  else if (proc.timed_out) blockers.push(`${VERDICT_REASONS.VERIFIER_TIMEOUT} after ${proc.timeout_seconds}s`);
  else if (proc.exit_code !== 0) blockers.push(`${VERDICT_REASONS.VERIFIER_PROCESS_FAILED}: exit ${proc.exit_code}`);

  const subjectStable = Boolean(subjectBefore.sha256) && subjectBefore.sha256 === subjectAfter.sha256;
  if (!subjectStable) blockers.push(VERDICT_REASONS.STALE_VERIFICATION_SUBJECT);

  // Gate가 판정한 AC는 Gate Report에서, Verifier가 판정한 AC는 Verifier Result에서 가져온다.
  // 어느 쪽도 상대의 영역을 덮어쓰지 않는다.
  const gateStatus = new Map((gateReport.acceptance_criteria ?? []).map((a) => [a.id, a.status]));
  const verifierStatus = new Map((verifierValidation.result?.criteria ?? []).map((c) => [c.id, c]));

  const criteria = task.data.acceptance_criteria.map((ac) => {
    if (ac.verification.type === 'gate') {
      return {
        id: ac.id,
        verification_type: 'gate',
        source: 'gate-report',
        gate: ac.verification.ref,
        status: gateStatus.get(ac.id) ?? 'UNKNOWN',
        reason: null,
      };
    }
    const v = verifierStatus.get(ac.id);
    return {
      id: ac.id,
      verification_type: 'verifier',
      source: 'verifier-result',
      gate: null,
      status: v ? v.status : 'NOT_JUDGED',
      reason: v ? v.reason : null,
    };
  });

  const allCriteriaPass = criteria.every((c) => c.status === 'PASS');
  if (!allCriteriaPass) {
    const failing = criteria.filter((c) => c.status !== 'PASS').map((c) => c.id);
    blockers.push(`acceptance criteria not satisfied: ${failing.join(', ')}`);
  }
  if (verifierValidation.valid && verifierValidation.result.result !== 'PASS') {
    blockers.push(VERDICT_REASONS.VERIFIER_FAIL);
  }

  const result = blockers.length === 0 ? 'PASS' : 'FAIL';

  return {
    schema: REPORT_SCHEMA,
    run_id: runId,
    task_id: taskId,
    attempt,

    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,

    verification_subject_sha256: subjectBefore.sha256,
    verification_subject: subjectBefore,
    verification_subject_after: subjectAfter,
    verification_subject_stable: subjectStable,

    gate_result: gateReport.result,
    gate_report_attempt: gateReport.attempt,

    verifier_result: verifierValidation.valid ? verifierValidation.result.result : null,
    verifier_result_valid: verifierValidation.valid,
    verifier_result_errors: verifierValidation.errors,
    verifier_global_failure: verifierValidation.global_failure ?? false,
    verifier_reason: verifierValidation.valid ? verifierValidation.result.reason : null,

    worker_policy_violation: workerPolicyViolation,
    verifier_policy_violation: verifierEnvelope.verifier_policy_violation,
    verifier_process: {
      exit_code: proc.exit_code,
      timed_out: proc.timed_out,
      launch_error: proc.launch_error,
    },

    acceptance_criteria: criteria,

    result,
    blockers,
  };
}

export function writeVerificationReport(verificationDir, report) {
  const path = reportPath(verificationDir);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  freeze(path);
  return path;
}

export function readVerificationReport(verificationDir) {
  const path = reportPath(verificationDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { corrupt: true };
  }
}

export { reportPath as verificationReportPath };
