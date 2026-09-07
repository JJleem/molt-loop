import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml, plannerResult, proposal } from './fixture.mjs';
import { efficiencyConfig } from '../efficiency.mjs';
import { usageLedger, checkBudget } from '../usage-ledger.mjs';

const WORKER = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', outcome: 'success', summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW' });
const VERIFIER = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__', result: 'PASS', criteria: [{ id: 'AC1', status: 'PASS', reason: 'present', evidence_basis: 'repository_content', evidence_refs: ['.loop/tasks/__TASK__.yaml'] }], failed_criteria: [], reason: 'done' });
const GOOD = { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_VERIFIER: VERIFIER };
const project = (opts, fn) => { const p = makeProject(opts); try { return fn(p); } finally { p.cleanup(); } };
const configure = (p, lines) => p.write('.loop/project.yaml', readFileSync(join(p.root, '.loop/project.yaml'), 'utf8').replace('runtime:\n', `runtime:\n${lines}\n`));
const runs = (p) => readdirSync(join(p.root, '.loop-local/runs')).filter((n) => n.startsWith('RUN-'));
const runJson = (p, id, name) => JSON.parse(readFileSync(join(p.root, '.loop-local/runs', id, name), 'utf8'));
const one = { tasks: { 'TASK-001': taskYaml('TASK-001') } };
const gateTask = () => taskYaml('TASK-001').replace('requires_verifier: true', 'requires_verifier: false').replace('type: verifier', 'type: gate\n      ref: build');

test('isolated process failure retries against the receiving subject, not private Git HEAD', () => project(one, (p) => {
  configure(p, '  isolate_workers: true');
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_EXIT: '1' });
  assert.equal(runs(p).length, 2, r.out);
  const id = runs(p)[0];
  const receipt = runJson(p, id, 'integration.json');
  const env = runJson(p, id, 'runtime-envelope.json');
  assert.equal(receipt.status, 'integrated');
  assert.notEqual(receipt.main_subject_after.sha256, env.verification_subject_after.sha256);
  assert.match(r.out, /STALLED|LIMIT/);
}));

test('isolated malformed result preserves recovery receipt and retries', () => project(one, (p) => {
  configure(p, '  isolate_workers: true');
  const r = p.run(['execute', 'TASK-001'], { LOOP_MOCK_RESULT: '{bad' });
  assert.equal(runs(p).length, 2, r.out);
  assert.equal(runJson(p, runs(p)[0], 'integration.json').status, 'integrated');
}));

test('unrelated edits still block isolated failure recovery', () => project(one, (p) => {
  configure(p, '  isolate_workers: true');
  p.run(['run', 'TASK-001'], { ...GOOD, LOOP_MOCK_EXIT: '1' });
  p.write('unrelated.txt', 'human edit');
  const r = p.run(['execute', 'TASK-001'], GOOD);
  assert.equal(r.code, 1, r.out);
  assert.equal(runs(p).length, 1);
  assert.match(r.out, /changed|AMBIGUOUS/);
}));

test('goal-level review rejects a plan even when every task is DONE', () => project({}, (p) => {
  configure(p, '  goal_verification: true');
  p.run(['plan', 'deliver the complete original goal'], { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }) });
  const id = p.plans()[0];
  assert.equal(p.run(['plan-approve', id]).code, 0);
  const r = p.run(['execute-plan', id], GOOD);
  assert.equal(r.code, 1, r.out); // Task AC1 cannot impersonate independent GOAL evidence.
  assert.match(p.taskText('TASK-001'), /status: DONE/);
  assert.match(r.out, /GOAL_CHECK_FAILED/);
}));

test('adaptive verifier recovery repairs schema failures without a second worker', () => project(one, (p) => {
  configure(p, '  adaptive_recovery: true');
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_VERIFIER_SEQ: JSON.stringify(['bad', VERIFIER]) });
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 1);
  assert.ok(existsSync(join(p.root, '.loop-local/runs', runs(p)[0], 'verification/history/1/verifier-envelope.json')));
}));

test('goal review passes with independent evidence and is included in plan billing', () => project({}, (p) => {
  configure(p, '  goal_verification: true');
  p.run(['plan', 'deliver the complete original goal'], { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }) });
  const id = p.plans()[0];
  p.run(['plan-approve', id]);
  const goal = VERIFIER.replaceAll('AC1', 'GOAL').replace('.loop/tasks/__TASK__.yaml', '.loop/project.yaml');
  const r = p.run(['execute-plan', id], { ...GOOD, LOOP_MOCK_VERIFIER_SEQ: JSON.stringify([VERIFIER, goal]), LOOP_MOCK_VERIFIER_COST: '0.25' });
  assert.equal(r.code, 0, r.out);
  const ledger = usageLedger({ localDir: join(p.root, '.loop-local'), planId: id, taskIds: ['TASK-001'] });
  assert.equal(ledger.invocations.filter((i) => i.stage === 'verifier').length, 2);
  assert.equal(ledger.known_cost_usd, 0.5);
}));

test('efficiency settings reject unsafe concurrency and malformed policies', () => {
  assert.throws(() => efficiencyConfig({ max_parallel_workers: 2 }), /isolate/);
  assert.throws(() => efficiencyConfig({ recovery_paths: ['../outside'] }), /relative/);
  assert.throws(() => efficiencyConfig({}, { budget: { task_usd: -1 } }), /nonnegative/);
  assert.throws(() => efficiencyConfig({ gate_only_completion: 'yes' }), /boolean/);
});

test('parallel-safe gates overlap while unsafe gates form a sequential barrier', () => project({ tasks: { 'TASK-001': gateTask().replace('gates: []', 'gates: [first, build, last]') }, gates: `  first:
    enabled: true
    command: node -e "setTimeout(()=>{}, 400)"
    parallel_safe: true
  build:
    enabled: true
    command: node -e "setTimeout(()=>{}, 400)"
    parallel_safe: true
  last:
    enabled: true
    command: node -e "setTimeout(()=>{}, 10)"
` }, (p) => {
  configure(p, '  max_parallel_gates: 2\n  gate_only_completion: true');
  const r = p.run(['execute', 'TASK-001'], GOOD);
  assert.equal(r.code, 0, r.out);
  const gates = runJson(p, runs(p)[0], 'gate-report.json').gates;
  assert.deepEqual(gates.map((g) => g.name), ['first', 'build', 'last']);
  assert.ok(Date.parse(gates[1].started_at) < Date.parse(gates[0].finished_at));
  assert.ok(Date.parse(gates[2].started_at) >= Math.max(...gates.slice(0, 2).map((g) => Date.parse(g.finished_at))));
}));

test('a zero task budget refuses before creating a run or changing task state', () => project(one, (p) => {
  p.write('.loop/policies/limits.yaml', 'budget:\n  task_usd: 0\n');
  const r = p.run(['run', 'TASK-001'], GOOD);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /TASK_BUDGET/);
  assert.equal(runs(p).length, 0);
  assert.match(p.taskText('TASK-001'), /status: TODO/);
}));

test('plan budgets include planner cost and cannot be bypassed by direct verify', () => project({}, (p) => {
  p.write('.loop/policies/limits.yaml', 'budget:\n  plan_usd: 1\n');
  const planned = p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }), LOOP_MOCK_PLANNER_COST: '0.5' });
  assert.equal(planned.code, 0, planned.out);
  const id = p.plans()[0];
  assert.equal(p.run(['plan-approve', id]).code, 0);
  const r = p.run(['execute-plan', id], { ...GOOD, LOOP_MOCK_COST: '0.6' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /USAGE_BUDGET_EXHAUSTED/);
  const direct = p.run(['verify', 'TASK-001'], GOOD);
  assert.equal(direct.code, 1, direct.out);
  assert.match(direct.out, /PLAN_BUDGET/);
  assert.equal(existsSync(join(p.root, '.loop-local/runs', runs(p)[0], 'verification/verifier-envelope.json')), false);
}));

test('an unfinished paid invocation is unknown usage, not zero cost', () => project({}, (p) => {
  p.write('.loop-local/runs/RUN-X/manifest.json', JSON.stringify({ task_id: 'TASK-001' }));
  p.write('.loop-local/runs/RUN-X/worker-started.json', '{}');
  const localDir = join(p.root, '.loop-local');
  assert.equal(usageLedger({ localDir }).unknown_cost_invocations, 1);
  const config = { efficiency: efficiencyConfig({}, { budget: { task_usd: 5 } }) };
  assert.equal(checkBudget({ config, taskId: 'TASK-001', localDir }).allowed, false);
}));

test('runtime mutation lock rejects another owner but leaves read-only commands usable', () => project(one, (p) => {
  p.write('.loop-local/operation.lock', JSON.stringify({ pid: process.pid, command: 'test-owner' }));
  assert.equal(p.run(['status']).code, 0);
  const r = p.run(['run', 'TASK-001'], GOOD);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /another runtime operation is active/);
  assert.equal(runs(p).length, 0);
  assert.equal(p.run(['self-check', 'build']).code, 0);
}));

test('disabled required gates fail preflight before a paid worker', () => project({ tasks: { 'TASK-001': gateTask().replace('ref: build', 'ref: lint') } }, (p) => {
  const r = p.run(['run', 'TASK-001'], GOOD);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /required gate lint is disabled/);
  assert.equal(runs(p).length, 0);
}));

test('isolated workers also support a diagnosed retry after verifier failure', () => project(one, (p) => {
  configure(p, '  isolate_workers: true');
  const fail = JSON.parse(VERIFIER);
  fail.result = 'FAIL'; fail.criteria[0].status = 'FAIL'; fail.failed_criteria = ['AC1'];
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_VERIFIER_SEQ: JSON.stringify([JSON.stringify(fail), VERIFIER]) });
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 2);
  assert.ok(runs(p).every((id) => runJson(p, id, 'integration.json').status === 'integrated'));
}));

test('a saved worker result can recover a missing status transition without another invocation', () => project(one, (p) => {
  p.run(['run', 'TASK-001'], GOOD);
  p.write('.loop/tasks/TASK-001.yaml', p.taskText('TASK-001').replace('status: REVIEW', 'status: IN_PROGRESS'));
  const r = p.run(['resume', 'TASK-001'], GOOD);
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 1);
  assert.match(p.taskText('TASK-001'), /status: DONE/);
}));

test('a saved PASS can recover a missing DONE transition without rerunning verification', () => project(one, (p) => {
  p.run(['execute', 'TASK-001'], GOOD);
  p.write('.loop/tasks/TASK-001.yaml', p.taskText('TASK-001').replace('status: DONE', 'status: REVIEW'));
  const r = p.run(['resume', 'TASK-001']);
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 1);
  assert.equal(runJson(p, runs(p)[0], 'verification/verification-report.json').attempt, 1);
}));

test('simple model routing respects an explicit CLI model', () => {
  for (const [flags, expected] of [[[], 'small-test-model'], [['--model', 'explicit-test-model'], 'explicit-test-model']]) {
    project({ tasks: { 'TASK-001': gateTask() } }, (p) => {
      configure(p, '  gate_only_completion: true\n  worker_simple_model: small-test-model');
      const r = p.run(['execute', 'TASK-001', ...flags], GOOD);
      assert.equal(r.code, 0, r.out);
      assert.equal(runJson(p, runs(p)[0], 'runtime-envelope.json').model, expected);
    });
  }
});

test('exhausted cost budget still permits free gate-only finalization', () => project({ tasks: { 'TASK-001': gateTask() } }, (p) => {
  configure(p, '  gate_only_completion: true');
  p.write('.loop/policies/limits.yaml', 'budget:\n  task_usd: 1\n');
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_COST: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(p.taskText('TASK-001'), /status: DONE/);
}));

test('gate-only completion is opt-in, uses all criteria, and makes zero verifier calls', () => project({ tasks: { 'TASK-001': gateTask() } }, (p) => {
  const old = p.run(['execute', 'TASK-001'], GOOD);
  assert.equal(old.code, 1, old.out);
  assert.match(p.taskText('TASK-001'), /status: REVIEW/);
  configure(p, '  gate_only_completion: true');
  // Configuration changed after the old gates: explicit revalidation is required.
  assert.equal(p.run(['gate', 'TASK-001', '--rerun']).code, 0);
  const r = p.run(['execute', 'TASK-001'], GOOD);
  assert.equal(r.code, 0, r.out);
  const id = runs(p)[0];
  assert.equal(runJson(p, id, 'verification/verification-report.json').completion_method, 'gate-only');
  assert.equal(existsSync(join(p.root, '.loop-local/runs', id, 'verification/verifier-envelope.json')), false);
  assert.match(p.run(['verification', 'TASK-001']).out, /not invoked \(gate-only\)/);
}));

test('gate-only policy does not bypass a required independent verifier', () => project(one, (p) => {
  configure(p, '  gate_only_completion: true');
  assert.equal(p.run(['execute', 'TASK-001'], GOOD).code, 0);
  assert.equal(existsSync(join(p.root, '.loop-local/runs', runs(p)[0], 'verification/verifier-envelope.json')), true);
}));

test('resume reports changed paths and reuses worker while rerunning gates', () => project(one, (p) => {
  assert.equal(p.run(['run', 'TASK-001'], GOOD).code, 0);
  assert.equal(p.run(['gate', 'TASK-001']).code, 0);
  p.write('notes.txt', 'operator note');
  const stopped = p.run(['execute', 'TASK-001'], GOOD);
  assert.equal(stopped.code, 1, stopped.out);
  assert.match(stopped.out, /ADDED notes.txt/);
  assert.match(p.run(['diagnose', 'TASK-001']).out, /ADDED notes.txt/);
  const resumed = p.run(['resume', 'TASK-001', '--rerun-gates'], GOOD);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(runs(p).length, 1);
  assert.equal(runJson(p, runs(p)[0], 'gate-report.json').attempt, 2);
  assert.equal(existsSync(join(p.root, '.loop-local/runs', runs(p)[0], 'gate-history/1/gate-report.json')), true);
}));

test('only predeclared recovery paths are automatically revalidated', () => project(one, (p) => {
  configure(p, '  recovery_paths: [notes.txt]');
  p.run(['run', 'TASK-001'], GOOD);
  p.run(['gate', 'TASK-001']);
  p.write('notes.txt', 'a note');
  const r = p.run(['execute', 'TASK-001'], GOOD);
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 1);
  assert.equal(runJson(p, runs(p)[0], 'gate-report.json').attempt, 2);
}));

test('resume cannot silently accept a changed control plane', () => project(one, (p) => {
  p.run(['run', 'TASK-001'], GOOD);
  p.run(['gate', 'TASK-001']);
  p.write('.loop/KERNEL.md', readFileSync(join(p.root, '.loop/KERNEL.md'), 'utf8') + '\nchanged');
  const r = p.run(['resume', 'TASK-001', '--rerun-gates'], GOOD);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /CHANGED .loop\/KERNEL.md/);
}));

test('task budget blocks the next paid call and survives re-entry', () => project(one, (p) => {
  p.write('.loop/policies/limits.yaml', 'budget:\n  task_usd: 1\n');
  const env = { ...GOOD, LOOP_MOCK_COST: '1.2' };
  const r = p.run(['execute', 'TASK-001'], env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /USAGE_BUDGET_EXHAUSTED/);
  assert.equal(runs(p).length, 1);
  assert.equal(existsSync(join(p.root, '.loop-local/runs', runs(p)[0], 'verification/verifier-envelope.json')), false);
  const again = p.run(['resume', 'TASK-001'], env);
  assert.equal(again.code, 1, again.out);
  assert.equal(runs(p).length, 1);
}));

test('usage totals archived verifier invocations once and keeps token categories separate', () => project({}, (p) => {
  const base = '.loop-local/runs/RUN-X';
  p.write(`${base}/manifest.json`, JSON.stringify({ task_id: 'TASK-001' }));
  p.write(`${base}/runtime-envelope.json`, JSON.stringify({ usage: { provider_cost_usd: 1, tokens: { input: 2, cached_input: 100, output: 3 } }, duration_ms: 20 }));
  p.write(`${base}/verification/history/1/verifier-envelope.json`, JSON.stringify({ usage: { provider_cost_usd: 0.5, tokens: { output: 4 } }, duration_ms: 10 }));
  p.write(`${base}/verification/verifier-envelope.json`, JSON.stringify({ usage: { tokens: { output: 5 } }, duration_ms: 10 }));
  const ledger = usageLedger({ localDir: join(p.root, '.loop-local'), taskIds: ['TASK-001'] });
  assert.equal(ledger.known_cost_usd, 1.5);
  assert.equal(ledger.unknown_cost_invocations, 1);
  assert.equal(ledger.invocations.length, 3);
  assert.deepEqual(ledger.tokens, { input: 2, output: 12, cached_input: 100 });
  const config = { efficiency: efficiencyConfig({}, { budget: { task_usd: 10 } }) };
  assert.equal(checkBudget({ config, taskId: 'TASK-001', localDir: join(p.root, '.loop-local') }).allowed, false);
  assert.match(p.run(['usage', '--all']).out, /unknown cost: 1/);
}));

test('task resources are bounded and refresh file hashes when the source changes', () => project({ tasks: { 'TASK-001': taskYaml('TASK-001', { request: 'Update src/parser.mjs' }) } }, (p) => {
  p.write('src/parser.mjs', 'export function parse() {}\n');
  const before = p.run(['context', 'TASK-001']);
  assert.match(before.out, /src\/parser.mjs sha256=/);
  assert.match(before.out, /L1: export function parse/);
  p.write('src/parser.mjs', 'export function parse(value) {}\n');
  const after = p.run(['context', 'TASK-001']);
  assert.notEqual(before.out, after.out);
  const section = after.out.split('--- TASK RESOURCES ---')[1];
  assert.ok(section.length < 6100);
}));

test('execute-plan resumes a task already in REVIEW without another worker', () => project({}, (p) => {
  assert.equal(p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: plannerResult() }).code, 0);
  const id = p.plans()[0];
  assert.equal(p.run(['plan-approve', id]).code, 0);
  p.run(['run', 'TASK-001'], GOOD);
  const r = p.run(['execute-plan', id], GOOD);
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 2);
}));

test('start follows explicit phases and the same command does not pay or plan again', () => project({}, (p) => {
  p.write('phase1.md', 'first phase');
  p.write('phase2.md', 'second phase');
  const env = { ...GOOD, LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }) };
  const args = ['start', '--file', 'phase1.md', '--file', 'phase2.md'];
  const r = p.run(args, env);
  assert.equal(r.code, 0, r.out);
  assert.equal(p.plans().length, 2);
  assert.equal(runs(p).length, 2);
  const again = p.run(args, env);
  assert.equal(again.code, 0, again.out);
  assert.equal(p.plans().length, 2);
  assert.equal(runs(p).length, 2);
}));

test('start preserves human questions and never approves an unapprovable plan', () => project({}, (p) => {
  p.write('phase.md', 'ambiguous goal');
  const r = p.run(['start', '--file', 'phase.md'], { LOOP_MOCK_PLANNER: plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['Which storage?'] }) });
  assert.equal(r.code, 1, r.out);
  assert.equal(p.taskFiles().length, 0);
  const again = p.run(['start', '--file', 'phase.md']);
  assert.equal(again.code, 1);
  assert.equal(p.plans().length, 1);
}));

test('isolated worker integrates product changes and verifies them on the main tree', () => project(one, (p) => {
  configure(p, '  isolate_workers: true');
  p.write('source.txt', 'before');
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_WRITE_PATH: 'source.txt', LOOP_MOCK_WRITE_BODY: 'after' });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(p.root, 'source.txt'), 'utf8'), 'after');
  assert.equal(runJson(p, runs(p)[0], 'integration.json').status, 'integrated');
  assert.equal(runJson(p, runs(p)[0], 'verification/verification-report.json').result, 'PASS');
}));

test('independent workers overlap only in private workspaces', () => project({}, (p) => {
  configure(p, '  isolate_workers: true');
  p.write('.loop/project.yaml', readFileSync(join(p.root, '.loop/project.yaml'), 'utf8').replace('max_parallel_workers: 1', 'max_parallel_workers: 2'));
  p.write('src/.keep', '');
  const plan = plannerResult({ tasks: [proposal('P1'), proposal('P2')] });
  assert.equal(p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: plan }).code, 0);
  const id = p.plans()[0];
  p.run(['plan-approve', id]);
  const r = p.run(['execute-plan', id], { ...GOOD, LOOP_MOCK_SLEEP_MS: '1500', LOOP_MOCK_WRITE_PATH: 'src/__TASK__.txt', LOOP_MOCK_WRITE_BODY: '__TASK__' });
  assert.equal(r.code, 0, r.out);
  const envelopes = runs(p).map((run) => runJson(p, run, 'runtime-envelope.json')).sort((a, b) => a.started_at.localeCompare(b.started_at));
  assert.equal(envelopes.length, 2);
  assert.ok(Date.parse(envelopes[1].started_at) < Date.parse(envelopes[0].finished_at), 'workers must overlap');
  for (const task of ['TASK-001', 'TASK-002']) assert.equal(readFileSync(join(p.root, 'src', `${task}.txt`), 'utf8'), task);
}));

test('conflicting parallel results are preserved, not overwritten or silently retried', () => project({}, (p) => {
  configure(p, '  isolate_workers: true');
  p.write('.loop/project.yaml', readFileSync(join(p.root, '.loop/project.yaml'), 'utf8').replace('max_parallel_workers: 1', 'max_parallel_workers: 2'));
  p.write('shared.txt', 'before');
  p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1'), proposal('P2')] }) });
  const id = p.plans()[0];
  p.run(['plan-approve', id]);
  const env = { ...GOOD, LOOP_MOCK_SLEEP_MS: '1000', LOOP_MOCK_WRITE_PATH: 'shared.txt', LOOP_MOCK_WRITE_BODY: '__TASK__' };
  const r = p.run(['execute-plan', id], env);
  assert.equal(r.code, 1, r.out);
  const value = readFileSync(join(p.root, 'shared.txt'), 'utf8');
  assert.ok(['TASK-001', 'TASK-002'].includes(value));
  const pending = runs(p).find((id) => runJson(p, id, 'integration.json').status === 'pending');
  assert.ok(pending);
  const again = p.run(['resume', pending], env);
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /integration conflict/);
  assert.equal(runs(p).length, 2);
  assert.equal(readFileSync(join(p.root, 'shared.txt'), 'utf8'), value);
}));
