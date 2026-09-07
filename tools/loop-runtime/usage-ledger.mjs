// Read canonical envelopes, including archived verifications, exactly once.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LOCAL_DIR } from './task-store.mjs';

const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
export function usageLedger({ taskIds = null, planId = null, localDir = LOCAL_DIR } = {}) {
  const invocations = [];
  const gates = [];
  const ids = taskIds ? new Set(taskIds) : null;
  let includePlanReview = false;
  const visit = (dir, taskId = null) => {
    if (!existsSync(dir)) return;
    const manifest = read(join(dir, 'manifest.json'));
    taskId = manifest?.task_id ?? taskId;
    for (const stage of ['worker', 'verifier', 'planner']) {
      const receipt = join(dir, `${stage}-started.json`);
      const envelope = stage === 'worker' ? 'runtime-envelope.json' : `${stage}-envelope.json`;
      if ((includePlanReview || !ids || ids.has(taskId)) && existsSync(receipt) && !existsSync(join(dir, envelope))) {
        invocations.push({ artifact: relative(localDir, receipt), task_id: taskId, stage, tokens: {}, provider_cost_usd: null, unfinished: true });
      }
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { visit(p, taskId); continue; }
      if (!includePlanReview && ids && !ids.has(taskId)) continue;
      if (['runtime-envelope.json', 'verifier-envelope.json', 'planner-envelope.json'].includes(e.name)) {
        const env = read(p);
        invocations.push({
          artifact: relative(localDir, p).split('\\').join('/'), task_id: taskId,
          stage: e.name === 'runtime-envelope.json' ? 'worker' : e.name.split('-')[0],
          run_id: env?.run_id ?? null, attempt: env?.attempt ?? null,
          duration_ms: env?.duration_ms ?? null, model: env?.model ?? null,
          provider_cost_usd: env?.usage?.provider_cost_usd ?? null,
          tokens: env?.usage?.tokens ?? { source: 'unavailable' }, corrupt: env === null,
        });
      }
      if (e.name === 'gate-report.json') {
        const report = read(p);
        gates.push({ task_id: taskId, duration_ms: report?.duration_ms ?? null, result: report?.result ?? 'UNKNOWN' });
      }
    }
  };
  visit(join(localDir, 'runs'));
  if (planId) {
    includePlanReview = true;
    visit(join(localDir, 'plans', planId, 'goal-checks'));
    includePlanReview = false;
    // A plan's planner cost belongs to its budget, even when tasks are filtered.
    const p = join(localDir, 'plans', planId, 'planner-envelope.json');
    if (existsSync(p)) {
      const env = read(p);
      invocations.push({ artifact: relative(localDir, p), stage: 'planner', task_id: null, duration_ms: env?.duration_ms ?? null, tokens: env?.usage?.tokens ?? {}, provider_cost_usd: env?.usage?.provider_cost_usd ?? null });
    } else if (existsSync(join(localDir, 'plans', planId, 'planner-started.json'))) {
      invocations.push({ artifact: p, stage: 'planner', task_id: null, tokens: {}, provider_cost_usd: null, unfinished: true });
    }
  } else if (!ids) visit(join(localDir, 'plans'));
  const known = invocations.filter((i) => Number.isFinite(i.provider_cost_usd));
  const stops = [];
  const executionRoot = join(localDir, 'executions');
  for (const e of existsSync(executionRoot) ? readdirSync(executionRoot, { withFileTypes: true }) : []) {
    if (!e.isDirectory() || !e.name.startsWith('EXEC-')) continue;
    const r = read(join(executionRoot, e.name, 'execution-report.json'));
    if (r && (!ids || ids.has(r.task_id)) && ['NEEDS_HUMAN', 'BLOCKED', 'STALLED'].includes(r.result)) stops.push({ task_id: r.task_id, execution_id: r.execution_id, reason: r.stop_reason });
  }
  const tokens = {};
  for (const field of ['input', 'output', 'cached_input', 'cache_creation_input']) {
    const reported = invocations.filter((i) => Number.isFinite(i.tokens[field]));
    if (reported.length) tokens[field] = reported.reduce((n, i) => n + i.tokens[field], 0);
  }
  return {
    invocations, gates, tokens, human_stops: stops,
    retry_worker_cost_usd_known: known.filter((i) => i.stage === 'worker' && i.attempt > 1).reduce((n, i) => n + i.provider_cost_usd, 0),
    known_cost_usd: known.reduce((n, i) => n + i.provider_cost_usd, 0),
    unknown_cost_invocations: invocations.length - known.length,
    stage_ms: Object.fromEntries(['worker', 'verifier', 'planner'].map((s) => [s, invocations.filter((i) => i.stage === s).reduce((n, i) => n + (i.duration_ms ?? 0), 0)]).concat([['gate', gates.reduce((n, g) => n + (g.duration_ms ?? 0), 0)]])),
  };
}

export function checkBudget({ config, taskId = null, planId = null, taskIds = null, localDir = LOCAL_DIR }) {
  const b = config.efficiency?.budget;
  if (!b) return { allowed: true, reasons: [] };
  if ([b.task_usd, b.plan_usd, b.task_output_tokens].every((v) => v === null || v === undefined)) return { allowed: true, reasons: [] };
  const reasons = [];
  const check = (ledger, limit, label) => {
    if (limit === null || limit === undefined) return;
    if (ledger.known_cost_usd >= limit) reasons.push(`${label} reached: $${ledger.known_cost_usd.toFixed(4)} / $${limit}`);
    if (ledger.unknown_cost_invocations && b.on_unknown_cost !== 'continue') reasons.push(`${label}: ${ledger.unknown_cost_invocations} invocation(s) have unknown cost`);
  };
  if (taskId) {
    const ledger = usageLedger({ taskIds: [taskId], localDir });
    check(ledger, b.task_usd, 'TASK_BUDGET');
    if (b.task_output_tokens !== null && b.task_output_tokens !== undefined) {
      if ((ledger.tokens.output ?? 0) >= b.task_output_tokens) reasons.push('TASK_OUTPUT_TOKEN_BUDGET reached');
      if (ledger.invocations.some((i) => !Number.isFinite(i.tokens.output)) && b.on_unknown_cost !== 'continue') reasons.push('TASK_OUTPUT_TOKEN_BUDGET: output usage unavailable');
    }
  }
  planId ??= config.executionPlanId;
  taskIds ??= config.executionTaskIds;
  if (planId && taskIds) check(usageLedger({ taskIds, planId, localDir }), b.plan_usd, 'PLAN_BUDGET');
  if (taskId && !planId && b.plan_usd !== null && b.plan_usd !== undefined) {
    const plans = join(localDir, 'plans');
    for (const e of existsSync(plans) ? readdirSync(plans, { withFileTypes: true }) : []) {
      if (!e.isDirectory()) continue;
      const approved = read(join(plans, e.name, 'approval.json'));
      if (approved?.created_task_ids?.includes(taskId)) check(usageLedger({ taskIds: approved.created_task_ids, planId: e.name, localDir }), b.plan_usd, `PLAN_BUDGET ${e.name}`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

export function assertBudget(config, taskId = null) {
  const check = checkBudget({ config, taskId });
  if (!check.allowed) throw new Error(check.reasons.join('; '));
}
