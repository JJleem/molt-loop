import { mkdirSync } from 'node:fs';
import { computeSubject, sameSubject } from '../subject.mjs';
import { checkEligibility, readGateReport } from './runner.mjs';
import { writeStatus } from '../task-store.mjs';
import { verificationDirFor } from '../verifier/runner.mjs';
import { writeVerificationReport, REPORT_SCHEMA } from '../verifier/report.mjs';

export function completeGateOnly({ task, run, config }) {
  const criteria = task.data.acceptance_criteria;
  const report = readGateReport(run.runDir);
  const subject = computeSubject();
  if (!config.efficiency?.gate_only_completion || task.data.stop_condition.requires_verifier || !criteria.length || criteria.some((c) => c.verification.type !== 'gate')) throw new Error('gate-only completion is not authorized for this task');
  const eligible = checkEligibility({ task, run, config });
  if (!eligible.ok) throw new Error(eligible.errors.join('; '));
  if (report?.result !== 'PASS' || !sameSubject(report.verification_subject, subject) || criteria.some((c) => !report.acceptance_criteria.some((r) => r.id === c.id && r.status === 'PASS'))) throw new Error('gate-only completion requires current PASS evidence for every criterion');
  const dir = verificationDirFor(run.runDir);
  mkdirSync(dir, { recursive: true });
  writeVerificationReport(dir, {
    schema: REPORT_SCHEMA, run_id: run.runId, task_id: task.id, attempt: 1,
    result: 'PASS', completion_method: 'gate-only', verifier_result: null,
    verifier_result_valid: false, verifier_policy_violation: false, worker_policy_violation: false,
    verification_subject: report.verification_subject, verification_subject_sha256: subject.sha256,
    verification_subject_after: subject, verification_subject_stable: true,
    gate_result: 'PASS', gate_report_attempt: report.attempt,
    acceptance_criteria: report.acceptance_criteria.map((a) => ({ ...a, verification_type: 'gate', source: 'gate-report' })), blockers: [],
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 0,
  });
  const moved = writeStatus(task, 'DONE');
  if (!moved.ok) throw new Error(moved.reason);
  return moved;
}
