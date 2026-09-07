// Explicit goal files define the authorized scope. Re-entry uses saved plan IDs, never replans completed phases.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LOCAL_DIR, isPaused } from '../task-store.mjs';
import { runPlannerOnce } from '../planner/runner.mjs';
import { approvePlan } from '../planner/approval.mjs';
import { loadPlan } from '../planner/store.mjs';
import { executePlan, resolveExecutablePlan, writePlanExecutionReport } from './plan-executor.mjs';

export async function runWorkflow({ files, config, emit = () => {}, isInterrupted = () => false }) {
  if (!files.length) throw new Error('start requires at least one --file; each file is one authorized phase');
  const goals = files.map((file) => ({ path: resolve(file), goal: readFileSync(file, 'utf8') }));
  if (goals.some((g) => !g.goal.trim())) throw new Error('goal files must not be empty');
  const hash = createHash('sha256').update(JSON.stringify(goals)).digest('hex');
  const dir = join(LOCAL_DIR, 'workflows');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { scope_sha256: hash, approval: 'explicit-start-command', phases: goals.map((g) => ({ file: g.path, plan_id: null, done: false })), created_at: new Date().toISOString() };
  if (state.scope_sha256 !== hash || state.phases.length !== goals.length) throw new Error('workflow scope does not match saved record');
  const save = () => { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 2)); renameSync(tmp, path); };
  save();
  for (let i = 0; i < goals.length; i++) {
    if (isPaused() || isInterrupted()) return { result: 'INTERRUPTED', path };
    const phase = state.phases[i];
    if (phase.done) continue;
    if (!phase.plan_id) {
      const out = await runPlannerOnce({ goal: goals[i].goal, goalSource: goals[i].path, config, onLaunch: ({ planId }) => { phase.plan_id = planId; save(); } });
      phase.plan_id = out.planId;
      save();
    }
    emit({ event: 'phase', file: phase.file, plan_id: phase.plan_id });
    const loaded = loadPlan(phase.plan_id);
    const questions = loaded.report?.human_questions ?? [];
    if (questions.length) return { result: 'NEEDS_HUMAN', path, plan_id: phase.plan_id, detail: questions.join('\n') };
    const approved = approvePlan(phase.plan_id);
    if (!approved.ok) return { result: 'NEEDS_HUMAN', path, detail: approved.reason, plan_id: phase.plan_id };
    const plan = resolveExecutablePlan(phase.plan_id);
    if (!plan.ok) return { result: 'NEEDS_HUMAN', path, detail: plan.reason };
    const run = await executePlan({ planId: phase.plan_id, taskIds: plan.taskIds, config, emit, isInterrupted });
    writePlanExecutionReport(phase.plan_id, run);
    phase.done = run.result === 'DONE';
    phase.last_result = run.result;
    save();
    if (!phase.done) return { result: run.result, path, detail: run.detail };
  }
  return { result: 'DONE', path };
}
