// quick-ux.test — V0.3: 빠른 경로(quick · profile · effort · 호출당 상한)와 운영 편의(latest · NEXT · 추세).
//
// 대응 근거:
//   OBS-005 — Task당 Worker 비용이 단조 증가했는데 사람이 execution-report를 손으로 모아야 보였다 (CI-004).
//   Claude Code 2.1.272 실측(2026-09-15) — --effort 와 --max-budget-usd 가 --print 에서 동작한다.
//   Ideas — `loopctl init`/onboarding 마찰: PLAN ID 복붙, status가 다음 명령을 말하지 않음.
//
// 전부 mock adapter다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml, plannerResult, proposal } from './fixture.mjs';

const WORKER = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', outcome: 'success', summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW' });
const VERIFIER = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__', result: 'PASS', criteria: [{ id: 'AC1', status: 'PASS', reason: 'present', evidence_basis: 'repository_content', evidence_refs: ['.loop/tasks/__TASK__.yaml'] }], failed_criteria: [], reason: 'done' });
const GOOD = { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_VERIFIER: VERIFIER };
const ONE_TASK_PLAN = { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }) };

const project = (opts, fn) => { const p = makeProject(opts); try { return fn(p); } finally { p.cleanup(); } };
const configure = (p, lines) => p.write('.loop/project.yaml', readFileSync(join(p.root, '.loop/project.yaml'), 'utf8').replace('runtime:\n', `runtime:\n${lines}\n`));
const runs = (p) => readdirSync(join(p.root, '.loop-local/runs')).filter((n) => n.startsWith('RUN-')).sort();
const runJson = (p, id, name) => JSON.parse(readFileSync(join(p.root, '.loop-local/runs', id, name), 'utf8'));
const verifierEnvelope = (p, id) => JSON.parse(readFileSync(join(p.root, '.loop-local/runs', id, 'verification', 'verifier-envelope.json'), 'utf8'));
const one = { tasks: { 'TASK-001': taskYaml('TASK-001') } };

const QUICK_PROFILE = `  profiles:
    quick:
      worker_effort: low
      verifier_effort: low
      planner_effort: medium
      max_call_budget_usd: 2.5
      goal_verification: false
      max_tasks_per_plan: 2`;

// ------------------------------------------------------------------
// latest — Plan ID를 복붙하지 않아도 된다
// ------------------------------------------------------------------

test('"latest" resolves to the newest plan for plan-show, plan-approve and execute-plan', () => project({}, (p) => {
  assert.equal(p.run(['plan-show', 'latest']).code, 1, 'no plan yet → refused with a hint, not a crash');
  assert.equal(p.run(['plan', 'first goal'], ONE_TASK_PLAN).code, 0);
  assert.equal(p.run(['plan', 'second goal'], ONE_TASK_PLAN).code, 0);
  const newest = p.plans().sort().reverse()[0];
  const shown = p.run(['plan-show', 'latest']);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.stdout, new RegExp(newest));
  assert.equal(p.run(['plan-approve', 'latest']).code, 0);
  assert.ok(p.planJson(newest, 'approval.json'), 'approval landed on the newest plan');
  const r = p.run(['execute-plan', 'latest'], GOOD);
  assert.equal(r.code, 0, r.out);
  assert.equal(runs(p).length, 1);
}));

// ------------------------------------------------------------------
// status NEXT — 다음 명령을 파일 상태에서 결정론적으로 고른다
// ------------------------------------------------------------------

test('status ends with a NEXT hint that follows the plan → approve → execute → done flow', () => project({}, (p) => {
  const next = () => { const r = p.run(['status']); assert.equal(r.code, 0, r.out); return r.stdout.split('NEXT\n')[1]; };
  assert.match(next(), /loopctl start --file/);

  assert.equal(p.run(['plan', 'goal'], ONE_TASK_PLAN).code, 0);
  const id = p.plans()[0];
  assert.match(next(), new RegExp(`loopctl plan-show ${id}`));

  assert.equal(p.run(['plan-approve', id]).code, 0);
  assert.match(next(), new RegExp(`loopctl execute-plan ${id}`));
  assert.match(next(), /1 of 1 task\(s\) remaining/);

  assert.equal(p.run(['execute-plan', id], GOOD).code, 0);
  assert.match(next(), /loopctl start --file/, 'nothing pending after the plan is DONE');
}));

test('status NEXT points at diagnose when the latest execution needed a human', () => project(one, (p) => {
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_EXIT: '1' });
  assert.notEqual(r.code, 0);
  const s = p.run(['status']);
  assert.match(s.stdout.split('NEXT\n')[1], /loopctl diagnose TASK-001/);
}));

test('status NEXT names the PAUSE file while paused and execute for a plan-less READY task', () => project(one, (p) => {
  assert.match(p.run(['status']).stdout.split('NEXT\n')[1], /loopctl execute TASK-001/);
  p.write('.loop-local/PAUSE', '');
  assert.match(p.run(['status']).stdout.split('NEXT\n')[1], /remove \.loop-local\/PAUSE/);
}));

// ------------------------------------------------------------------
// usage --all — Task별 추세 표 (CI-004)
// ------------------------------------------------------------------

test('usage --all prints a per-task trend row with worker and verifier cost from recorded envelopes', () => project({ tasks: { 'TASK-001': taskYaml('TASK-001'), 'TASK-002': taskYaml('TASK-002') } }, (p) => {
  assert.equal(p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_COST: '1.5', LOOP_MOCK_VERIFIER_COST: '0.5', LOOP_MOCK_USAGE: '{"output":100,"cached_input":1000}' }).code, 0);
  assert.equal(p.run(['execute', 'TASK-002'], { ...GOOD, LOOP_MOCK_COST: '3', LOOP_MOCK_VERIFIER_COST: '0.5', LOOP_MOCK_USAGE: '{"output":200,"cached_input":4000}' }).code, 0);
  const r = p.run(['usage', '--all']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Per-task trend/);
  const row1 = r.stdout.split('\n').find((l) => l.trim().startsWith('TASK-001'));
  const row2 = r.stdout.split('\n').find((l) => l.trim().startsWith('TASK-002'));
  assert.match(row1, /1\.5000\s+-\s+0\.5000/, 'first task has no previous task to compare with');
  assert.match(row2, /3\.0000\s+\+100%\s+0\.5000/, 'worker cost doubled from the previous task');
  assert.match(row2, /4,000/);
}));

test('usage --all marks a task whose calls reported no cost instead of counting it as zero', () => project(one, (p) => {
  assert.equal(p.run(['execute', 'TASK-001'], GOOD).code, 0);
  const r = p.run(['usage', '--all']);
  const row = r.stdout.split('\n').find((l) => l.trim().startsWith('TASK-001'));
  assert.match(row, /0\.0000\?/, 'unknown cost is flagged, not hidden');
}));

// ------------------------------------------------------------------
// effort · 호출당 상한 — 설정과 플래그가 adapter까지 도달하고 Envelope에 남는다
// ------------------------------------------------------------------

test('configured effort and per-call budget reach the worker, verifier and planner adapters', () => project({}, (p) => {
  configure(p, '  worker_effort: high\n  verifier_effort: low\n  planner_effort: medium\n  max_call_budget_usd: 1.25');
  assert.equal(p.run(['plan', 'goal'], ONE_TASK_PLAN).code, 0);
  const planId = p.plans()[0];
  const planner = p.planJson(planId, 'planner-envelope.json');
  assert.equal(planner.effort_requested, 'medium');
  assert.equal(planner.adapter_meta.received.effort, 'medium');
  assert.equal(planner.adapter_meta.received.max_budget_usd, 1.25);

  assert.equal(p.run(['plan-approve', planId]).code, 0);
  assert.equal(p.run(['execute-plan', planId], GOOD).code, 0);
  const run = runs(p)[0];
  const worker = runJson(p, run, 'runtime-envelope.json');
  assert.equal(worker.effort_requested, 'high');
  assert.equal(worker.max_call_budget_usd, 1.25);
  assert.equal(worker.adapter_meta.received.effort, 'high');
  const verifier = verifierEnvelope(p, run);
  assert.equal(verifier.effort_requested, 'low');
  assert.equal(verifier.adapter_meta.received.max_budget_usd, 1.25);
}));

test('--effort on the command line overrides the configured value and rejects unknown levels', () => project(one, (p) => {
  configure(p, '  worker_effort: low');
  assert.equal(p.run(['run', 'TASK-001', '--effort', 'bogus'], GOOD).code, 2);
  assert.equal(runs(p).length, 0, 'a usage error runs nothing');
  assert.equal(p.run(['run', 'TASK-001', '--effort', 'xhigh'], GOOD).code, 0);
  assert.equal(runJson(p, runs(p)[0], 'runtime-envelope.json').effort_requested, 'xhigh');
}));

test('an invalid effort or budget in project.yaml fails closed before anything runs', () => project(one, (p) => {
  configure(p, '  worker_effort: fast');
  const r = p.run(['run', 'TASK-001'], GOOD);
  assert.equal(r.code, 1);
  assert.match(r.out, /worker_effort must be one of/);
  assert.equal(runs(p).length, 0);
}));

test('a non-positive per-call budget in project.yaml is refused', () => project(one, (p) => {
  configure(p, '  max_call_budget_usd: -1');
  const r = p.run(['run', 'TASK-001'], GOOD);
  assert.equal(r.code, 1);
  assert.match(r.out, /max_call_budget_usd must be a positive number/);
  assert.equal(runs(p).length, 0);
}));

// ------------------------------------------------------------------
// profiles — 속도·비용 값만 묶어서 고른다
// ------------------------------------------------------------------

test('--profile applies only the configured keys and prints what changed', () => project(one, (p) => {
  configure(p, QUICK_PROFILE);
  const r = p.run(['execute', 'TASK-001', '--profile', 'quick'], GOOD);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Profile: quick/);
  assert.match(r.stdout, /worker_effort: null -> low/);
  assert.match(r.stdout, /Gates, verifier requirements and approval boundaries are not changed/);
  const env = runJson(p, runs(p)[0], 'runtime-envelope.json');
  assert.equal(env.profile, 'quick');
  assert.equal(env.effort_requested, 'low');
  assert.equal(env.max_call_budget_usd, 2.5);
  assert.equal(verifierEnvelope(p, runs(p)[0]).effort_requested, 'low');
}));

test('an explicit --effort wins over the profile', () => project(one, (p) => {
  configure(p, QUICK_PROFILE);
  assert.equal(p.run(['execute', 'TASK-001', '--profile', 'quick', '--effort', 'max'], GOOD).code, 0);
  assert.equal(runJson(p, runs(p)[0], 'runtime-envelope.json').effort_requested, 'max');
}));

test('an unknown profile or a profile with a non-speed key is refused', () => project(one, (p) => {
  const r = p.run(['execute', 'TASK-001', '--profile', 'nope'], GOOD);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown profile "nope"/);
  assert.equal(runs(p).length, 0);
  configure(p, '  profiles:\n    sneaky:\n      gate_only_completion: true');
  const bad = p.run(['status']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /gate_only_completion is not a profile key/);
}));

// ------------------------------------------------------------------
// quick — 인라인 목표 하나로 계획 · 승인 · 실행
// ------------------------------------------------------------------

test('quick "<goal>" plans, approves and executes with the quick profile and records everything', () => project({}, (p) => {
  configure(p, QUICK_PROFILE);
  const env = { ...GOOD, ...ONE_TASK_PLAN };
  const r = p.run(['quick', 'add', 'a', 'greeting'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Profile: quick/);
  assert.match(r.stdout, /Goal file: \.loop-local\/goals\/quick-[0-9a-f]{16}\.md/);
  assert.match(r.stdout, /Workflow: DONE/);

  const goals = readdirSync(join(p.root, '.loop-local/goals'));
  assert.equal(goals.length, 1);
  assert.equal(readFileSync(join(p.root, '.loop-local/goals', goals[0]), 'utf8'), 'add a greeting\n');

  assert.equal(p.plans().length, 1);
  const planId = p.plans()[0];
  assert.equal(p.planJson(planId, 'planner-envelope.json').effort_requested, 'medium');
  assert.equal(p.planJson(planId, 'planner-envelope.json').profile, 'quick');
  assert.ok(p.planJson(planId, 'approval.json'), 'the command itself is the approval, like start');
  assert.equal(p.taskFiles().length, 1);
  assert.equal(runs(p).length, 1);
  assert.equal(runJson(p, runs(p)[0], 'runtime-envelope.json').effort_requested, 'low');

  const workflows = readdirSync(join(p.root, '.loop-local/workflows')).filter((f) => f.endsWith('.json'));
  assert.equal(workflows.length, 1);
  const record = JSON.parse(readFileSync(join(p.root, '.loop-local/workflows', workflows[0]), 'utf8'));
  assert.equal(record.profile, 'quick');
  assert.equal(record.approval, 'explicit-start-command');

  // 같은 목표를 다시 quick 하면 이미 끝난 범위다 — 계획도 실행도 다시 하지 않는다.
  const again = p.run(['quick', 'add a greeting'], env);
  assert.equal(again.code, 0, again.out);
  assert.equal(p.plans().length, 1);
  assert.equal(runs(p).length, 1);
}));

test('quick --file uses the file as scope, exactly like start', () => project({}, (p) => {
  configure(p, QUICK_PROFILE);
  p.write('phase.md', 'file goal');
  const r = p.run(['quick', '--file', 'phase.md'], { ...GOOD, ...ONE_TASK_PLAN });
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(p.root, '.loop-local/goals')), 'no inline goal file is written for --file');
  assert.equal(runs(p).length, 1);
}));

test('quick refuses to run without a quick profile and without changing anything', () => project({}, (p) => {
  const r = p.run(['quick', 'do it'], { ...GOOD, ...ONE_TASK_PLAN });
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown profile "quick"/);
  assert.match(r.out, /quick needs a profile/);
  assert.equal(p.plans().length, 0);
  assert.equal(p.taskFiles().length, 0);
  assert.ok(!existsSync(join(p.root, '.loop-local/goals')), 'a refused quick leaves no goal file behind');
}));

test('quick keeps the approval boundary: an unapprovable plan stops with the human questions', () => project({}, (p) => {
  configure(p, QUICK_PROFILE);
  const r = p.run(['quick', 'ambiguous'], { LOOP_MOCK_PLANNER: plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['Which storage?'] }) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Which storage\?/);
  assert.equal(p.taskFiles().length, 0, 'no task is created for a NEEDS_HUMAN plan');
}));

test('quick and start refuse mixed or missing goal arguments as usage errors', () => project({}, (p) => {
  configure(p, QUICK_PROFILE);
  assert.equal(p.run(['quick']).code, 2);
  assert.equal(p.run(['quick', 'text', '--file', 'x.md']).code, 2);
  assert.equal(p.run(['quick', '--bogus']).code, 2);
  assert.equal(p.run(['start', 'inline text']).code, 2, 'start does not accept an inline goal');
  assert.equal(p.plans().length, 0);
}));

// ------------------------------------------------------------------
// DROPPED 선행 — ply-converter 실측: replan으로 대체된 Task를 기다리던 Task가 무기한 "waiting"으로 남았다
// ------------------------------------------------------------------

test('a task waiting on a DROPPED task is reported as unresolvable, and NEXT does not suggest executing that plan', () => project({}, (p) => {
  assert.equal(p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1'), { ...proposal('P2'), depends_on: ['P1'] }] }) }).code, 0);
  const id = p.plans()[0];
  assert.equal(p.run(['plan-approve', id]).code, 0);
  assert.equal(p.run(['transition', 'TASK-001', 'DROPPED']).code, 0);
  const ready = p.run(['ready']);
  assert.match(ready.stdout, /TASK-001 \(DROPPED — needs a replan\)/);
  const s = p.run(['status']);
  assert.match(s.stdout, /DROPPED — needs a replan/);
  const next = s.stdout.split('NEXT\n')[1];
  assert.doesNotMatch(next, new RegExp(`execute-plan ${id}`), 'a plan that can never progress is not the next command');
  assert.match(next, /waiting on DROPPED tasks/);
  const r = p.run(['execute', 'TASK-002'], GOOD);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DROPPED — this task needs a replan/);
}));
