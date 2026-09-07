import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, LOOP_DIR } from '../task-store.mjs';
import { planDir, loadPlan } from '../planner/store.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { assertBudget } from '../usage-ledger.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { fingerprintDir, compareFingerprints } from '../worker/runner.mjs';
import { normalizeTokens } from '../worker/telemetry.mjs';
import { verifierProtocol, VERIFIER_TOOLS, VERIFIER_DENY } from '../verifier/runner.mjs';
import { verifierResultSchema, validateVerifierResult } from '../verifier/result.mjs';

// Independent final review of the original goal, not the planner's decomposition.
export async function checkPlanGoal({ planId, taskIds, config }) {
  const goal = loadPlan(planId).report?.goal;
  if (typeof goal !== 'string' || !goal.trim()) return { result: 'FAIL', reason: 'Original goal is missing.' };
  const subject = subjectRef(computeSubject(ROOT));
  const goalHash = createHash('sha256').update(goal).digest('hex');
  const root = join(planDir(planId), 'goal-checks');
  const dir = join(root, `${goalHash}-${subject.sha256}`);
  const reportPath = join(dir, 'goal-report.json');
  if (existsSync(reportPath)) return JSON.parse(readFileSync(reportPath, 'utf8'));
  if (existsSync(join(dir, 'verifier-started.json'))) return { result: 'FAIL', reason: 'Unfinished goal review requires inspection; no duplicate paid invocation.' };
  assertBudget(config);
  const adapter = getAdapter(config.runtime.verifier_adapter);
  const available = await adapter.detect();
  if (!available.available || typeof adapter.runVerifier !== 'function') return { result: 'FAIL', reason: 'Goal verifier adapter unavailable.' };
  if (!subject.sha256) return { result: 'FAIL', reason: 'Repository subject unavailable.' };
  mkdirSync(dir, { recursive: true });
  const taskId = 'GOAL', runId = planId;
  const task = { id: taskId, data: { acceptance_criteria: [{ id: 'GOAL', description: goal, verification: { type: 'verifier' } }] } };
  const context = `ORIGINAL AUTHORIZED GOAL\n${goal}\n\nCompleted task IDs: ${taskIds.join(', ')}\nInspect the actual repository and runtime evidence. Task DONE is not evidence that the original goal is met. Check missing requirements, integration regressions, and weakened tests. Unobserved execution claims must fail. Do not change scope or files.`;
  writeFileSync(join(dir, 'context.md'), context);
  const before = fingerprintDir(LOOP_DIR), start = Date.now();
  writeFileSync(join(dir, 'verifier-started.json'), JSON.stringify({ started_at: new Date(start).toISOString() }));
  let proc;
  try {
    proc = await adapter.runVerifier({ runId, taskId, subjectSha256: subject.sha256, context,
      systemPrompt: verifierProtocol({ runId, taskId, subjectSha256: subject.sha256, criterionIds: ['GOAL'] }),
      cwd: ROOT, timeoutMs: config.runtime.verifier_timeout_seconds * 1000, model: config.runtime.verifier_model,
      schema: verifierResultSchema(), tools: VERIFIER_TOOLS, deny: VERIFIER_DENY });
  } catch (e) { proc = { launch_error: e.message, exit_code: null }; }
  writeFileSync(join(dir, 'stdout.log'), proc.stdout ?? '');
  writeFileSync(join(dir, 'stderr.log'), proc.stderr ?? '');
  writeFileSync(join(dir, 'verifier-result.json'), JSON.stringify(proc.structured_output ?? null, null, 2));
  const stable = sameSubject(subject, subjectRef(computeSubject(ROOT))) && !compareFingerprints(before, fingerprintDir(LOOP_DIR)).violated;
  const validation = validateVerifierResult(proc.structured_output, { runId, taskId, subjectSha256: subject.sha256, task,
    evidenceFacts: { diffFileCount: 0, gateReport: null, refExists: (p) => {
      const path = resolve(ROOT, p);
      return path.startsWith(resolve(ROOT) + sep) && existsSync(path);
    } } });
  const pass = stable && proc.exit_code === 0 && !proc.timed_out && !proc.launch_error && validation.valid && validation.result?.result === 'PASS';
  const report = { result: pass ? 'PASS' : 'FAIL', goal_sha256: goalHash, verification_subject: subject,
    subject_stable: stable, reason: validation.result?.reason ?? proc.launch_error ?? validation.errors.join('; '), validation,
    finished_at: new Date().toISOString() };
  writeFileSync(join(dir, 'verifier-envelope.json'), JSON.stringify({ stage: 'goal-verifier', duration_ms: Date.now() - start,
    model: proc.model ?? null, process: { exit_code: proc.exit_code, timed_out: proc.timed_out, launch_error: proc.launch_error },
    usage: { tokens: normalizeTokens(proc.provider_usage), provider_cost_usd: proc.adapter_meta?.provider_cost_usd ?? null } }, null, 2));
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}
