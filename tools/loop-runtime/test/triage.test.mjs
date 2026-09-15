// triage.test — V0.4: 사람을 부르기 직전에 먼저 보는 Triage.
//
// 확인하는 계약:
//   - limits.yaml에 triage 절이 없으면 예전처럼 곧바로 사람에게 간다 (이전 프로젝트 호환)
//   - Triage는 Runtime이 준 메뉴에서만 고른다. 메뉴 밖 결정 · 없는 근거 경로 · 결과 없음은 전부 ESCALATE다
//   - DONE은 어떤 경우에도 Triage가 만들지 못한다 — 완료는 여전히 Gate와 Verifier가 정한다
//   - RERUN_GATES(OBS-003) · RERUN_VERIFIER · RETRY_WITH_LESSON · UNBLOCK · REPLAN · ANSWER 각각의 경로
//   - 판단 예산(decisions · retries · replans · answers)은 결정론적 사다리와 별개로 잡힌다
//   - REPLAN은 start/quick 아래에서만 실행된다
//
// 전부 mock adapter다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml, plannerResult, proposal } from './fixture.mjs';

const WORKER = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', outcome: 'success', summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW' });
const WORKER_BLOCKED = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', outcome: 'blocked', summary: 'Which port should the server listen on? The task does not say.', changed_files: [], evidence: [], requested_transition: 'BLOCKED' });
const VERIFIER = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__', result: 'PASS', criteria: [{ id: 'AC1', status: 'PASS', reason: 'present', evidence_basis: 'repository_content', evidence_refs: ['.loop/tasks/__TASK__.yaml'] }], failed_criteria: [], reason: 'done' });
const VERIFIER_FAIL = JSON.stringify({ run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__', result: 'FAIL', criteria: [{ id: 'AC1', status: 'FAIL', reason: 'the greeting is missing', evidence_basis: 'repository_content', evidence_refs: ['.loop/tasks/__TASK__.yaml'] }], failed_criteria: ['AC1'], reason: 'AC1 unsatisfied' });
const GOAL_PASS = VERIFIER.replaceAll('AC1', 'GOAL').replace('.loop/tasks/__TASK__.yaml', '.loop/project.yaml');
const GOAL_FAIL = VERIFIER_FAIL.replaceAll('AC1', 'GOAL').replace('.loop/tasks/__TASK__.yaml', '.loop/project.yaml').replace('the greeting is missing', 'the goal also asked for a farewell');
const GOOD = { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_VERIFIER: VERIFIER };
const ONE_TASK_PLAN = { LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }) };

const decision = (d, extra = {}) => JSON.stringify({ decision: d, reason: `mock triage chose ${d}`, evidence_basis: 'runtime_artifact', evidence_refs: ['.loop/project.yaml'], ...extra });

const TRIAGE_LIMITS = (extra = '') => `stop:
  max_attempts: 3
  max_consecutive_failures: 2

escalation:
  retry_max: 1
  hint_retry_max: 0
  then: needs-human

planning:
  max_tasks_per_plan: 3

triage:
  enabled: true
  max_decisions_per_task: 2
  max_retries_per_task: 1
  max_replans_per_plan: 1
  max_answers_per_plan: 1
${extra}`;

const project = (opts, fn) => { const p = makeProject(opts); try { return fn(p); } finally { p.cleanup(); } };
const triaged = (opts, fn) => project({ ...opts, limits: TRIAGE_LIMITS() }, fn);
const configure = (p, lines) => p.write('.loop/project.yaml', readFileSync(join(p.root, '.loop/project.yaml'), 'utf8').replace('runtime:\n', `runtime:\n${lines}\n`));
const runs = (p) => readdirSync(join(p.root, '.loop-local/runs')).filter((n) => n.startsWith('RUN-')).sort();
const runJson = (p, id, name) => JSON.parse(readFileSync(join(p.root, '.loop-local/runs', id, name), 'utf8'));
const triageResults = (p, runId) => {
  const root = join(p.root, '.loop-local/runs', runId, 'triage');
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().map((n) => JSON.parse(readFileSync(join(root, n, 'triage-result.json'), 'utf8')));
};
const latestExecution = (p) => {
  const dir = join(p.root, '.loop-local/executions');
  const id = readdirSync(dir).filter((n) => n.startsWith('EXEC-')).sort().reverse()[0];
  return JSON.parse(readFileSync(join(dir, id, 'execution-report.json'), 'utf8'));
};
const taskStatus = (p, id) => p.taskText(id).match(/^status: (\S+)/m)[1];
const one = { tasks: { 'TASK-001': taskYaml('TASK-001') } };

// ------------------------------------------------------------------
// 기본값과 경계
// ------------------------------------------------------------------

test('without a triage section the runtime stops for a human exactly as before', () => project(one, (p) => {
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_VERIFIER: VERIFIER_FAIL, LOOP_MOCK_TRIAGE: decision('RETRY_WITH_LESSON', { lesson: 'x' }) });
  assert.notEqual(r.code, 0);
  assert.equal(triageResults(p, runs(p)[0]).length, 0, 'no triage artifact when the section is absent');
  assert.ok(!latestExecution(p).events.some((e) => e.stage === 'triage'));
}));

test('the manual profile turns triage off for one command', () => triaged(one, (p) => {
  configure(p, '  profiles:\n    manual:\n      triage: false');
  p.run(['execute', 'TASK-001', '--profile', 'manual'], { ...GOOD, LOOP_MOCK_VERIFIER: VERIFIER_FAIL, LOOP_MOCK_TRIAGE: decision('ESCALATE') });
  assert.equal(triageResults(p, runs(p)[0]).length, 0);
}));

test('a decision outside the menu, a missing evidence path, or no result at all is an ESCALATE — never executed', () => triaged(one, (p) => {
  // 첫 정지: hint 예산 0이라 VERIFY_FAILED가 바로 사다리 끝이다. 메뉴에는 RETRY_WITH_LESSON이 있고 DONE은 없다.
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_VERIFIER: VERIFIER_FAIL, LOOP_MOCK_TRIAGE: JSON.stringify({ decision: 'DONE', reason: 'looks fine', evidence_basis: 'gate', evidence_refs: [] }) });
  assert.notEqual(r.code, 0);
  const [t] = triageResults(p, runs(p)[0]);
  assert.equal(t.valid, false);
  assert.equal(t.normalized.decision, 'ESCALATE');
  assert.match(t.errors.join(' '), /not in the menu/);
  assert.ok(!t.menu.includes('DONE'));
  assert.equal(taskStatus(p, 'TASK-001'), 'REVIEW', 'nothing moved');
  assert.equal(runs(p).length, 1, 'no paid retry happened');
  const report = latestExecution(p);
  assert.equal(report.events.filter((e) => e.stage === 'triage').length, 1);
  assert.match(report.events.at(-1).detail, /triage: triage could not decide/);
}));

test('a missing evidence path invalidates the decision', () => triaged(one, (p) => {
  p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_VERIFIER: VERIFIER_FAIL, LOOP_MOCK_TRIAGE: decision('RETRY_WITH_LESSON', { lesson: 'add the greeting', evidence_refs: ['docs/does-not-exist.md'] }) });
  const [t] = triageResults(p, runs(p)[0]);
  assert.equal(t.valid, false);
  assert.match(t.errors.join(' '), /evidence_ref does not exist/);
  assert.equal(runs(p).length, 1);
}));

test('when the menu is ESCALATE only, no AI call is made and nothing is billed', () => triaged(one, (p) => {
  // 정책 위반은 절대 자동화하지 않는다: Worker가 .loop/KERNEL.md를 건드린다.
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_TOUCH: '.loop/KERNEL.md', LOOP_MOCK_TRIAGE: decision('RETRY_WITH_LESSON', { lesson: 'x' }) });
  assert.notEqual(r.code, 0);
  const results = triageResults(p, runs(p)[0]);
  assert.equal(results.length, 1);
  assert.equal(results[0].skipped, true);
  assert.deepEqual(results[0].menu, ['ESCALATE']);
  assert.ok(!existsSync(join(p.root, '.loop-local/runs', runs(p)[0], 'triage/01/triage-envelope.json')), 'no envelope = no invocation');
}));

// ------------------------------------------------------------------
// 결정별 경로
// ------------------------------------------------------------------

test('RERUN_GATES: an unrelated file written after the gates ran no longer stops the task (OBS-003)', () => triaged(one, (p) => {
  assert.equal(p.run(['run', 'TASK-001'], GOOD).code, 0);
  assert.equal(p.run(['gate', 'TASK-001']).code, 0);
  p.write('notes.txt', 'a human took a note while the runtime was busy');
  const r = p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_TRIAGE: decision('RERUN_GATES', { evidence_refs: ['gate-report.json'] }) });
  assert.equal(r.code, 0, r.out);
  assert.equal(taskStatus(p, 'TASK-001'), 'DONE');
  const report = latestExecution(p);
  const stages = report.events.map((e) => e.stage);
  assert.deepEqual(stages.filter((s) => s === 'triage'), ['triage']);
  assert.ok(report.events.some((e) => e.stage === 'gate' && e.triage === 'RERUN_GATES'));
  assert.ok(report.events.some((e) => e.stage === 'verifier'), 'the verifier still decided completion');
  const [t] = triageResults(p, runs(p)[0]);
  assert.equal(t.valid, true);
  assert.equal(t.normalized.decision, 'RERUN_GATES');
  const ctx = readFileSync(join(p.root, '.loop-local/runs', runs(p)[0], 'triage/01/context.md'), 'utf8');
  assert.match(ctx, /ADDED notes\.txt/, 'triage saw exactly what changed');
}));

test('RERUN_VERIFIER: a verifier that returned nothing is re-run instead of escalated', () => triaged(one, (p) => {
  // adaptive_recovery 없이: 결과 없음 -> SCHEMA_FAILURE(verifier) -> NEEDS_HUMAN -> triage.
  const r = p.run(['execute', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_VERIFIER_SEQ: JSON.stringify(['{not json', VERIFIER]), LOOP_MOCK_TRIAGE: decision('RERUN_VERIFIER', { evidence_refs: [] }) });
  assert.equal(r.code, 0, r.out);
  assert.equal(taskStatus(p, 'TASK-001'), 'DONE');
  assert.ok(latestExecution(p).events.some((e) => e.stage === 'verifier' && e.triage === 'RERUN_VERIFIER'));
}));

test('RETRY_WITH_LESSON: after the deterministic ladder is exhausted, one triage lesson reaches the next worker', () => triaged(one, (p) => {
  const r = p.run(['execute', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_VERIFIER_SEQ: JSON.stringify([VERIFIER_FAIL, VERIFIER]), LOOP_MOCK_TRIAGE: decision('RETRY_WITH_LESSON', { lesson: 'AC1 needs the greeting string in src/greet.ts; the verifier could not find it.', recovery_hint: 'add it, then self-check build', evidence_refs: ['.loop/tasks/TASK-001.yaml'] }) });
  assert.equal(r.code, 0, r.out);
  assert.equal(taskStatus(p, 'TASK-001'), 'DONE');
  assert.equal(runs(p).length, 2);
  const second = runs(p)[1];
  const manifest = runJson(p, second, 'manifest.json');
  assert.equal(manifest.attempt, 2);
  assert.equal(manifest.lineage.retry_action, 'RETRY_WITH_TRIAGE');
  const ctx = readFileSync(join(p.root, '.loop-local/runs', second, 'context.md'), 'utf8');
  assert.match(ctx, /AC1 needs the greeting string/);
  assert.match(ctx, /Stage: triage/);
  assert.match(ctx, /add it, then self-check build/);
}));

test('the triage retry budget is separate from the ladder and runs out on its own', () => triaged(one, (p) => {
  const r = p.run(['execute', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_VERIFIER: VERIFIER_FAIL, LOOP_MOCK_TRIAGE: decision('RETRY_WITH_LESSON', { lesson: 'try again', evidence_refs: ['.loop/tasks/TASK-001.yaml'] }) });
  assert.notEqual(r.code, 0);
  assert.equal(runs(p).length, 2, 'exactly one triage retry');
  const results = [...triageResults(p, runs(p)[0]), ...triageResults(p, runs(p)[1])];
  assert.equal(results.length, 2, 'two decisions = max_decisions_per_task');
  assert.equal(results[0].normalized.decision, 'RETRY_WITH_LESSON');
  assert.ok(!results[1].menu.includes('RETRY_WITH_LESSON'), 'the second menu no longer offers a retry');
  assert.equal(results[1].normalized.decision, 'ESCALATE');
  assert.notEqual(taskStatus(p, 'TASK-001'), 'DONE');
}));

test('UNBLOCK: a worker question answered by the spec sends the task back with a clarification', () => triaged(one, (p) => {
  p.write('docs/PRODUCT-SPEC.md', '# Spec\n\nThe server listens on port 8080.\n');
  p.commitAll('spec');
  const r = p.run(['execute', 'TASK-001'], { LOOP_MOCK_RESULT_SEQ: JSON.stringify([WORKER_BLOCKED, WORKER]), LOOP_MOCK_VERIFIER: VERIFIER, LOOP_MOCK_TRIAGE: decision('UNBLOCK', { lesson: 'The spec fixes the port: 8080 (docs/PRODUCT-SPEC.md).', evidence_basis: 'repository_content', evidence_refs: ['docs/PRODUCT-SPEC.md'] }) });
  assert.equal(r.code, 0, r.out);
  assert.equal(taskStatus(p, 'TASK-001'), 'DONE');
  assert.equal(runs(p).length, 2);
  const clarification = JSON.parse(readFileSync(join(p.root, '.loop-local/triage/TASK-001/clarification.json'), 'utf8'));
  assert.equal(clarification.notes.length, 1);
  const ctx = readFileSync(join(p.root, '.loop-local/runs', runs(p)[1], 'context.md'), 'utf8');
  assert.match(ctx, /TRIAGE CLARIFICATION/);
  assert.match(ctx, /port: 8080/);
  const report = latestExecution(p);
  assert.ok(report.events.some((e) => e.stage === 'recovery' && /BLOCKED -> TODO/.test(e.result)));
  const triageCtx = readFileSync(join(p.root, '.loop-local/runs', runs(p)[0], 'triage/01/context.md'), 'utf8');
  assert.match(triageCtx, /WORKER CLAIM \(not evidence\)/);
  assert.match(triageCtx, /Which port should the server listen on/);
  assert.match(triageCtx, /listens on port 8080/, 'the spec is in the triage context');
}));

// ------------------------------------------------------------------
// Plan 수준: REPLAN · ANSWER
// ------------------------------------------------------------------

test('REPLAN after a failed goal check: remaining work is re-planned under the same start authority', () => triaged({}, (p) => {
  configure(p, '  goal_verification: true');
  p.write('phase.md', 'greet and say farewell');
  const env = {
    LOOP_MOCK_RESULT: WORKER,
    LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }),
    LOOP_MOCK_VERIFIER_SEQ: JSON.stringify([VERIFIER, GOAL_FAIL, VERIFIER, GOAL_PASS]),
    LOOP_MOCK_TRIAGE: decision('REPLAN', { evidence_refs: ['.loop/project.yaml'] }),
  };
  const r = p.run(['start', '--file', 'phase.md'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /\[Triage\/goal\] REPLAN/);
  assert.match(r.stdout, /Replan 1:/);
  assert.equal(p.plans().length, 2);
  assert.equal(taskStatus(p, 'TASK-001'), 'DONE', 'done work is kept');
  assert.equal(taskStatus(p, 'TASK-002'), 'DONE');
  const record = JSON.parse(readFileSync(join(p.root, '.loop-local/workflows', readdirSync(join(p.root, '.loop-local/workflows')).find((f) => f.endsWith('.json'))), 'utf8'));
  assert.equal(record.phases[0].replans, 1);
  assert.equal(record.phases[0].superseded.length, 1);
  assert.equal(record.phases[0].done, true);
  const second = p.plans().sort()[1];
  assert.match(p.planContext(second), /RUNTIME REPLAN CONTEXT/);
  assert.match(p.planContext(second), /Tasks already DONE and still valid: TASK-001/);
}));

test('REPLAN after a task that cannot be fixed drops it and re-plans; the dropped task never blocks the phase', () => triaged({}, (p) => {
  p.write('phase.md', 'do the thing');
  const env = {
    LOOP_MOCK_RESULT: WORKER,
    LOOP_MOCK_EXIT_SEQ: JSON.stringify(['1', '1', '0']),
    LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }),
    LOOP_MOCK_VERIFIER: VERIFIER,
    LOOP_MOCK_TRIAGE: decision('REPLAN', { evidence_refs: ['.loop/project.yaml'] }),
  };
  const r = p.run(['start', '--file', 'phase.md'], env);
  assert.equal(r.code, 0, r.out);
  assert.equal(taskStatus(p, 'TASK-001'), 'DROPPED');
  assert.equal(taskStatus(p, 'TASK-002'), 'DONE');
  assert.equal(p.plans().length, 2);
  const again = p.run(['start', '--file', 'phase.md'], env);
  assert.equal(again.code, 0, again.out);
  assert.equal(p.plans().length, 2, 'a completed phase is not replanned again');
}));

test('REPLAN is not offered to execute-plan alone; only start/quick carry the planning authority', () => triaged({}, (p) => {
  assert.equal(p.run(['plan', 'goal'], ONE_TASK_PLAN).code, 0);
  assert.equal(p.run(['plan-approve', 'latest']).code, 0);
  const r = p.run(['execute-plan', 'latest'], { LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_EXIT: '1', LOOP_MOCK_TRIAGE: decision('REPLAN', { evidence_refs: ['.loop/project.yaml'] }) });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, /Plan Result: REPLAN/);
  const results = runs(p).flatMap((id) => triageResults(p, id));
  assert.ok(results.length >= 1);
  assert.ok(results.every((t) => !t.menu.includes('REPLAN')));
  assert.equal(taskStatus(p, 'TASK-001'), 'IN_PROGRESS');
}));

test('the replan budget is respected: a second failure of the same phase goes to a human', () => triaged({}, (p) => {
  p.write('phase.md', 'do the thing');
  const env = {
    LOOP_MOCK_RESULT: WORKER, LOOP_MOCK_EXIT: '1', LOOP_MOCK_VERIFIER: VERIFIER,
    LOOP_MOCK_PLANNER: plannerResult({ tasks: [proposal('P1')] }),
    LOOP_MOCK_TRIAGE: decision('REPLAN', { evidence_refs: ['.loop/project.yaml'] }),
  };
  const r = p.run(['start', '--file', 'phase.md'], env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /Workflow: NEEDS_HUMAN/);
  assert.match(r.stdout, /replan budget exhausted/);
  assert.equal(p.plans().length, 2, 'one replan, then stop');
}));

test('ANSWER: spec-category planner questions are answered from the spec and planning continues', () => triaged({}, (p) => {
  p.write('docs/PRODUCT-SPEC.md', '# Spec\n\nStorage: local SQLite file at data/app.db.\n');
  p.commitAll('spec');
  p.write('phase.md', 'persist the items');
  const asking = plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['Which storage should be used?'], human_question_categories: ['spec'] });
  const env = {
    ...GOOD,
    LOOP_MOCK_PLANNER_SEQ: JSON.stringify([asking, plannerResult({ tasks: [proposal('P1')] })]),
    LOOP_MOCK_TRIAGE: decision('ANSWER', { evidence_basis: 'repository_content', evidence_refs: ['docs/PRODUCT-SPEC.md'], answers: [{ question: 'Which storage should be used?', answer: 'A local SQLite file at data/app.db, per the spec.', evidence_refs: ['docs/PRODUCT-SPEC.md'] }] }),
  };
  const r = p.run(['start', '--file', 'phase.md'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /\[Triage\/questions\] ANSWER/);
  assert.equal(p.plans().length, 2);
  const second = p.plans().sort()[1];
  const ctx = p.planContext(second);
  assert.match(ctx, /DECISIONS \(answered by runtime triage/);
  assert.match(ctx, /SQLite file at data\/app\.db/);
  assert.match(ctx, /evidence: docs\/PRODUCT-SPEC\.md/);
  assert.equal(taskStatus(p, 'TASK-001'), 'DONE');
}));

test('a security-category question is never answered by triage: no call, straight to the human', () => triaged({}, (p) => {
  p.write('phase.md', 'expose the admin API');
  const asking = plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['Should the admin API be public?'], human_question_categories: ['security'] });
  const r = p.run(['start', '--file', 'phase.md'], { LOOP_MOCK_PLANNER: asking, LOOP_MOCK_TRIAGE: decision('ANSWER', { answers: [{ question: 'x', answer: 'yes', evidence_refs: ['.loop/project.yaml'] }] }) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Should the admin API be public\?/);
  assert.ok(!existsSync(join(p.root, '.loop-local/plans', p.plans()[0], 'triage')), 'no triage artifact at all');
  // 분류가 없는 질문(이전 Planner 출력)도 사람 몫이다.
  p.write('phase2.md', 'another goal');
  const r2 = p.run(['start', '--file', 'phase2.md'], { LOOP_MOCK_PLANNER: plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['Which storage?'] }) });
  assert.equal(r2.code, 1);
}));

test('planner question categories are validated: wrong length or unknown value fails the plan', () => project({}, (p) => {
  const bad = plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['a', 'b'], human_question_categories: ['spec'] });
  const r = p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: bad });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /human_question_categories has 1 entries but human_questions has 2/);
  const unknown = plannerResult({ result: 'NEEDS_HUMAN', tasks: [], human_questions: ['a'], human_question_categories: ['vibes'] });
  assert.match(p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER: unknown }).stdout, /"vibes" is unsupported/);
}));

// ------------------------------------------------------------------
// 관측
// ------------------------------------------------------------------

test('usage --all counts triage decisions and breaks human stops down by reason', () => triaged(one, (p) => {
  p.run(['execute', 'TASK-001'], { ...GOOD, LOOP_MOCK_VERIFIER: VERIFIER_FAIL, LOOP_MOCK_TRIAGE: decision('ESCALATE'), LOOP_MOCK_TRIAGE_COST: '0.02' });
  const r = p.run(['usage', '--all']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /triage: \d+\.\ds/);
  assert.match(r.stdout, /triage decisions: 1/);
  assert.match(r.stdout, /stops by reason:/);
  assert.match(r.stdout, /RETRY_BUDGET_EXHAUSTED/);
  assert.match(r.stdout, /Known cost: \$0\.0200/);
  const s = p.run(['status']);
  assert.match(s.stdout, /\[triage: ESCALATE\]/);
}));

test('doctor lists the triage contract and the triage skill is not a worker role', () => project({}, (p) => {
  const r = p.run(['doctor']);
  assert.match(r.stdout, /OK\s+\.loop\/skills\/triage\.md/);
  assert.match(r.stdout, /execution roles: impl\n/);
}));
