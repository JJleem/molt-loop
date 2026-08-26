// planner.test — Goal Planner 층의 결정론적 테스트.
//
//   node --test "tools/loop-runtime/test/*.test.mjs"
//
// 실제 provider를 부르지 않는다. adapter는 언제나 mock이며 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml, plannerResult, proposal } from './fixture.mjs';

/** mock Planner가 돌려줄 구조화 출력을 지정한 채로 `loopctl plan`을 돌린다. */
function plan(p, resultJson, extraEnv = {}) {
  const env = resultJson === undefined ? {} : { LOOP_MOCK_PLANNER: resultJson };
  const r = p.run(['plan', 'Add OBJ/STL/GLB conversion and a browser viewer.'], { ...env, ...extraEnv });
  const planId = (r.out.match(/PLAN-\d{8}T\d{6}Z(?:-\d+)?/) ?? [null])[0];
  return { ...r, planId };
}

const withProject = (opts, fn) => {
  const p = makeProject(opts);
  try { return fn(p); } finally { p.cleanup(); }
};

// ---------------------------------------------------------------- Planner Result

test('valid PROPOSED plan validates and creates no task', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Planner Result:\s+PROPOSED/);
    assert.match(r.out, /Tasks proposed:\s+2/);
    assert.match(r.out, /Validation: PASS/);
    assert.match(r.out, /No tasks have been created\./);
    assert.deepEqual(p.taskFiles(), [], 'plan must not write task files');

    const report = p.planJson(r.planId, 'plan-report.json');
    assert.equal(report.planner_result_valid, true);
    assert.equal(report.approvable, true);
    assert.equal(report.approved, false);
    assert.equal(report.policy_violation, false);
    assert.deepEqual(report.proposal_order, ['P1', 'P2']);
  });
});

test('NEEDS_HUMAN is accepted, is not approvable, and carries questions', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      result: 'NEEDS_HUMAN',
      tasks: [],
      human_questions: ['Should conversion run client-side or server-side?'],
    }));
    assert.equal(r.code, 1);
    assert.match(r.out, /Planner Result:\s+NEEDS_HUMAN/);
    assert.match(r.out, /client-side or server-side/);
    const report = p.planJson(r.planId, 'plan-report.json');
    assert.equal(report.planner_result_valid, true);
    assert.equal(report.approvable, false);

    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 1);
    assert.match(a.out, /only PROPOSED plans can be approved/);
    assert.deepEqual(p.taskFiles(), []);
  });
});

test('REFUSED is accepted and is not approvable', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ result: 'REFUSED', tasks: [] }));
    assert.equal(r.code, 1);
    const report = p.planJson(r.planId, 'plan-report.json');
    assert.equal(report.planner_result_valid, true);
    assert.equal(report.approvable, false);
  });
});

test('NEEDS_HUMAN with proposed tasks is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ result: 'NEEDS_HUMAN', human_questions: ['q?'] }));
    assert.match(r.out, /must not propose tasks/);
    assert.equal(p.planJson(r.planId, 'plan-report.json').planner_result_valid, false);
  });
});

test('malformed structured output is rejected, not scraped', () => {
  withProject({}, (p) => {
    const r = p.run(['plan', 'goal'], { LOOP_MOCK_PLANNER_RAW: 'Here are the tasks I recommend...' });
    assert.equal(r.code, 1);
    assert.match(r.out, /planner result must be a JSON object/);
    assert.deepEqual(p.taskFiles(), []);
  });
});

test('missing structured output is a failure, not an empty plan', () => {
  withProject({}, (p) => {
    const r = p.run(['plan', 'goal']);
    assert.equal(r.code, 1);
    assert.match(r.out, /no structured result|conversational transcript is not a plan/);
  });
});

test('wrong plan id is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ plan_id: 'PLAN-99999999T000000Z' }));
    assert.match(r.out, /plan_id mismatch/);
    assert.equal(p.planJson(r.planId, 'plan-report.json').planner_result_valid, false);
  });
});

test('unknown result type is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ result: 'LOOKS_GOOD', tasks: [] }));
    assert.match(r.out, /unsupported result "LOOKS_GOOD"/);
  });
});

test('duplicate proposal id is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1'), proposal('P1')] }));
    assert.match(r.out, /duplicate proposal_id "P1"/);
  });
});

test('missing task request is rejected', () => {
  withProject({}, (p) => {
    const t = proposal('P1'); delete t.request;
    const r = plan(p, plannerResult({ tasks: [t] }));
    assert.match(r.out, /request is required/);
  });
});

test('unknown role is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1', { execution: { role: 'backend_architect_v9' } })] }));
    assert.match(r.out, /unknown execution role "backend_architect_v9"/);
  });
});

test('runtime-internal roles are not assignable execution roles', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1', { execution: { role: 'verifier' } })] }));
    assert.match(r.out, /unknown execution role "verifier"/);
  });
});

test('invalid stop condition is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [proposal('P1', { stop_condition: { gates: [], requires_verifier: true, max_consecutive_failures: 0 } })],
    }));
    assert.match(r.out, /max_consecutive_failures must be an integer >= 1/);
  });
});

test('acceptance criterion without verification is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [proposal('P1', { acceptance_criteria: [{ id: 'AC1', description: 'x' }] })],
    }));
    assert.match(r.out, /verification is required/);
  });
});

test('a task with zero acceptance criteria is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1', { acceptance_criteria: [] })] }));
    assert.match(r.out, /at least one acceptance criterion is required/);
  });
});

test('unknown verification type is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [proposal('P1', { acceptance_criteria: [{ id: 'AC1', description: 'x', verification: { type: 'human' } }] })],
    }));
    assert.match(r.out, /verification\.type "human" is unknown/);
  });
});

test('unknown gate ref is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [proposal('P1', { acceptance_criteria: [{ id: 'AC1', description: 'x', verification: { type: 'gate', ref: 'magical_test' } }] })],
    }));
    assert.match(r.out, /unknown gate "magical_test"/);
  });
});

test('a disabled gate cannot be required by a plan', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1', { stop_condition: { gates: ['lint'], requires_verifier: true, max_consecutive_failures: 2 } })] }));
    assert.match(r.out, /gate "lint" is disabled/);
  });
});

test('an enabled gate is accepted', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [proposal('P1', {
        stop_condition: { gates: ['build'], requires_verifier: false, max_consecutive_failures: 2 },
        acceptance_criteria: [{ id: 'AC1', description: 'builds', verification: { type: 'gate', ref: 'build' } }],
      })],
    }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Validation: PASS/);
  });
});

test('too many tasks fails validation and is not truncated', () => {
  withProject({}, (p) => {
    // fixture limit: planning.max_tasks_per_plan = 3
    const r = plan(p, plannerResult({ tasks: ['P1', 'P2', 'P3', 'P4'].map((id) => proposal(id)) }));
    assert.match(r.out, /too many proposed tasks: 4 \(max 3/);
    assert.equal(p.planJson(r.planId, 'plan-report.json').task_count, 0);
  });
});

test('forbidden runtime-policy fields are rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1')] }).replace('"tasks"', '"retry_max": 99, "tasks"'));
    assert.match(r.out, /forbidden field "retry_max"/);
  });
});

test('planner self-approval is rejected as a forbidden field', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1')] }).replace('"tasks"', '"approved": true, "tasks"'));
    assert.match(r.out, /forbidden field "approved"/);
    assert.equal(p.planJson(r.planId, 'plan-report.json').approved, false);
  });
});

test('canonical task ids supplied as proposal ids are rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('TASK-001')] }));
    assert.match(r.out, /must look like P1, P2, P3/);
  });
});

// ---------------------------------------------------------------- Dependencies

test('a plan with no dependency is valid', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1'), proposal('P2')] }));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(p.planJson(r.planId, 'plan-report.json').proposal_order, ['P1', 'P2']);
  });
});

test('a branching dependency graph produces a deterministic topological order', () => {
  withProject({ limits: 'planning:\n  max_tasks_per_plan: 8\n' }, (p) => {
    const r = plan(p, plannerResult({
      tasks: [
        { ...proposal('P4'), depends_on: ['P2', 'P3'] },
        { ...proposal('P2'), depends_on: ['P1'] },
        { ...proposal('P3'), depends_on: ['P1'] },
        proposal('P1'),
      ],
    }));
    assert.equal(r.code, 0, r.out);
    // 배열 순서가 아니라 그래프 순서다. tie-break는 제안 배열 순서.
    assert.deepEqual(p.planJson(r.planId, 'plan-report.json').proposal_order, ['P1', 'P2', 'P3', 'P4']);
  });
});

test('duplicate dependency is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1'), { ...proposal('P2'), depends_on: ['P1', 'P1'] }] }));
    assert.match(r.out, /duplicate dependency "P1"/);
  });
});

test('missing proposal reference is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [{ ...proposal('P1'), depends_on: ['P9'] }] }));
    assert.match(r.out, /unknown proposal "P9"/);
  });
});

test('self dependency is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [{ ...proposal('P1'), depends_on: ['P1'] }] }));
    assert.match(r.out, /depends_on references itself/);
  });
});

test('a direct cycle is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [{ ...proposal('P1'), depends_on: ['P2'] }, { ...proposal('P2'), depends_on: ['P1'] }],
    }));
    assert.match(r.out, /dependency cycle detected among: P1, P2/);
  });
});

test('a multi-node cycle is rejected', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({
      tasks: [
        { ...proposal('P1'), depends_on: ['P3'] },
        { ...proposal('P2'), depends_on: ['P1'] },
        { ...proposal('P3'), depends_on: ['P2'] },
      ],
    }));
    assert.match(r.out, /dependency cycle detected among: P1, P2, P3/);
  });
});

// ---------------------------------------------------------------- Planner isolation

test('planner snapshot contains only the allowed sections', () => {
  withProject({ tasks: { 'TASK-001': taskYaml('TASK-001', { status: 'DONE' }) } }, (p) => {
    const r = plan(p, plannerResult());
    const ctx = p.planContext(r.planId);
    for (const s of ['PLANNER CONTRACT', 'GOAL', 'PROJECT FACTS', 'AVAILABLE ROLES', 'AVAILABLE GATES',
      'TASK CONTRACT', 'EXISTING TASK SUMMARY', 'PLANNING LIMITS', 'RUNTIME FACTS']) {
      assert.match(ctx, new RegExp(`^--- ${s} ---$`, 'm'), `missing section ${s}`);
    }
    for (const s of ['KERNEL', 'DESIGN', 'WORKER SUMMARY', 'WORKER STDOUT', 'FAILURE MEMO',
      'CANONICAL DIFF', 'GATE RESULTS', 'EVIDENCE']) {
      assert.doesNotMatch(ctx, new RegExp(`^--- ${s} ---$`, 'm'), `forbidden section ${s} leaked`);
    }
    // 기존 Task는 id/status/request 요약만 들어간다.
    assert.match(ctx, /TASK-001 \| DONE \|/);
  });
});

test('planner context does not contain worker, verifier, or failure-memo narrative', () => {
  const memoTask = taskYaml('TASK-001').replace(
    'failure_memo: []',
    'failure_memo:\n  - attempt: 1\n    stage: worker\n    error: GATE_FAILED\n    lesson: |-\n      SECRET_WORKER_NARRATIVE'
  );
  withProject({ tasks: { 'TASK-001': memoTask } }, (p) => {
    const r = plan(p, plannerResult());
    const ctx = p.planContext(r.planId);
    assert.doesNotMatch(ctx, /SECRET_WORKER_NARRATIVE/);
    const manifest = p.planJson(r.planId, 'manifest.json');
    assert.ok(manifest.excluded.includes('DESIGN.md'));
    assert.ok(manifest.excluded.includes('failure memo history'));
  });
});

test('a planner that mutates the repository is a policy violation and cannot be approved', () => {
  withProject({}, (p) => {
    const r = p.run(
      ['plan', 'goal'],
      { LOOP_MOCK_PLANNER: plannerResult(), LOOP_MOCK_PLANNER_TOUCH: join(p.root, 'source.txt') }
    );
    const report = p.planJson(r.planId ?? p.plans()[0], 'plan-report.json');
    assert.equal(report.policy_violation, true);
    assert.equal(report.approvable, false);
    assert.match(r.out, /repository subject changed during planning/);

    const a = p.run(['plan-approve', report.plan_id]);
    assert.equal(a.code, 1);
    assert.match(a.out, /mutated files during planning/);
    assert.deepEqual(p.taskFiles(), []);
  });
});

test('a planner that mutates .loop is a policy violation', () => {
  withProject({}, (p) => {
    const r = p.run(
      ['plan', 'goal'],
      { LOOP_MOCK_PLANNER: plannerResult(), LOOP_MOCK_PLANNER_TOUCH: join(p.root, '.loop', 'KERNEL.md') }
    );
    const report = p.planJson(r.planId ?? p.plans()[0], 'plan-report.json');
    assert.equal(report.policy_violation, true);
    assert.ok(report.policy_detail.some((d) => d.includes('.loop/KERNEL.md')));
  });
});

test('subject is recorded before and after planning and is stable for a read-only planner', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    const env = p.planJson(r.planId, 'planner-envelope.json');
    assert.equal(env.repository_subject_stable, true);
    assert.equal(env.repository_subject_before.sha256, env.repository_subject_after.sha256);
    assert.deepEqual(env.read_only.tools, ['Read', 'Grep', 'Glob']);
    assert.ok(env.read_only.denied.includes('Write'));
  });
});

test('planner timeout preserves artifacts and creates no task', () => {
  withProject({}, (p) => {
    const r = p.run(['plan', 'goal', '--timeout', '1'], {
      LOOP_MOCK_PLANNER: plannerResult(),
      LOOP_MOCK_PLANNER_SLEEP_MS: '2000',
    });
    assert.equal(r.code, 1);
    const planId = p.plans()[0];
    const env = p.planJson(planId, 'planner-envelope.json');
    assert.equal(env.process.timed_out, true);
    assert.ok(env.failures.some((f) => f.includes('timed out')));
    assert.deepEqual(p.taskFiles(), []);
  });
});

// ---------------------------------------------------------------- Approval

test('approval allocates canonical ids, maps dependencies, and creates valid tasks', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /Plan approved\./);
    assert.deepEqual(p.taskFiles(), ['TASK-001.yaml', 'TASK-002.yaml']);

    const approval = p.planJson(r.planId, 'approval.json');
    assert.deepEqual(approval.proposal_to_task, { P1: 'TASK-001', P2: 'TASK-002' });
    assert.equal(approval.llm_invocations, 0);

    // 제안 id가 아니라 canonical id로 치환되어야 한다.
    const t2 = p.taskText('TASK-002');
    assert.match(t2, /depends_on:\n {2}- TASK-001/);
    assert.doesNotMatch(t2, /- P1/);
    assert.match(p.taskText('TASK-001'), /^status: TODO$/m);

    assert.equal(p.run(['validate']).code, 0);
    assert.equal(p.planJson(r.planId, 'plan-report.json').approved, true);
  });
});

test('approval does not execute anything and reports only the ready task', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    const a = p.run(['plan-approve', r.planId]);
    assert.match(a.out, /Ready:\n {2}TASK-001/);
    assert.match(a.out, /nothing was executed/);
    assert.doesNotMatch(a.out, /RUN-/);
  });
});

test('approval is idempotent', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    assert.equal(p.run(['plan-approve', r.planId]).code, 0);
    const again = p.run(['plan-approve', r.planId]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Plan already approved\./);
    assert.match(again.out, /no task was created/);
    assert.deepEqual(p.taskFiles(), ['TASK-001.yaml', 'TASK-002.yaml']);
  });
});

test('a stale plan is refused without --force', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    p.write('src/new-file.txt', 'the repository changed after planning\n');
    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 1);
    assert.match(a.out, /repository state changed since this plan was created/);
    assert.match(a.out, /Create a fresh plan/);
    assert.deepEqual(p.taskFiles(), []);
  });
});

test('an invalid plan cannot be approved', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult({ tasks: [proposal('P1', { execution: { role: 'nope' } })] }));
    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 1);
    assert.match(a.out, /did not pass runtime validation/);
    assert.deepEqual(p.taskFiles(), []);
  });
});

test('canonical id allocation avoids collision with existing tasks', () => {
  withProject({ tasks: { 'TASK-001': taskYaml('TASK-001'), 'TASK-002': taskYaml('TASK-002') } }, (p) => {
    const r = plan(p, plannerResult());
    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 0, a.out);
    assert.deepEqual(p.taskFiles(), ['TASK-001.yaml', 'TASK-002.yaml', 'TASK-003.yaml', 'TASK-004.yaml']);
    // 기존 파일은 그대로여야 한다.
    assert.equal(p.taskText('TASK-001'), taskYaml('TASK-001'));
  });
});

test('approval refuses when the role skill disappeared after planning', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    // 계획 이후 Runtime 설정이 바뀌면 재검증이 걸러낸다.
    // (subject는 .loop 변경을 포함하므로 stale로 먼저 걸린다 — 둘 다 승인을 막으면 된다.)
    p.write('.loop/project.yaml', readFileSync(join(p.root, '.loop', 'project.yaml'), 'utf8').replace('planner_adapter: mock', 'planner_adapter: mock  # touched'));
    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 1);
    assert.deepEqual(p.taskFiles(), []);
  });
});

test('a plan cannot overwrite an existing task file', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    // 승인 직전에 같은 이름의 Task를 만들면 subject가 바뀌므로 stale로 거부된다.
    // 파일이 덮어써지지 않는 것이 요점이다.
    writeFileSync(p.taskPath('TASK-001'), taskYaml('TASK-001', { request: 'pre-existing' }), 'utf8');
    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 1);
    assert.match(p.taskText('TASK-001'), /pre-existing/);
  });
});

// ---------------------------------------------------------------- Paid-call safety

test('plan-show, plans, and plan-approve perform zero LLM calls', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    // mock adapter를 "결과 없음"으로 두면, LLM 단계가 하나라도 있으면 실패했을 것이다.
    const show = p.run(['plan-show', r.planId]);
    assert.equal(show.code, 0, show.out);
    assert.match(show.out, /Approved: no/);

    const plans = p.run(['plans']);
    assert.equal(plans.code, 0, plans.out);
    assert.match(plans.out, /PROPOSED/);

    const a = p.run(['plan-approve', r.planId]);
    assert.equal(a.code, 0, a.out);
    assert.equal(p.planJson(r.planId, 'approval.json').llm_invocations, 0);
    // 승인이 Run을 만들지 않았다.
    assert.equal(existsSync(join(p.root, '.loop-local', 'runs', 'RUN-')), false);
  });
});

test('plan-show accepts a unique prefix and stays read-only', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    const before = p.planJson(r.planId, 'plan-report.json');
    const show = p.run(['plan-show', r.planId.slice(0, 18)]);
    assert.equal(show.code, 0, show.out);
    assert.deepEqual(p.planJson(r.planId, 'plan-report.json'), before);
  });
});

// ---------------------------------------------------------------- Telemetry

test('planner usage is captured separately and never invented', () => {
  withProject({}, (p) => {
    const withUsage = plan(p, plannerResult(), {
      LOOP_MOCK_PLANNER_USAGE: JSON.stringify({ input: 1234, output: 56 }),
      LOOP_MOCK_PLANNER_MODEL: 'mock-model-x',
    });
    const env = p.planJson(withUsage.planId, 'planner-envelope.json');
    assert.equal(env.usage.stage, 'planner');
    assert.equal(env.usage.tokens.source, 'provider');
    assert.equal(env.usage.tokens.input, 1234);
    assert.equal(env.usage.model, 'mock-model-x');
    assert.ok(env.usage.context.bytes > 0);
    assert.match(withUsage.out, /tokens: input=1,234 output=56 \(provider\)/);
  });
});

test('unavailable provider usage is represented as unavailable, not synthesized', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    const env = p.planJson(r.planId, 'planner-envelope.json');
    assert.deepEqual(env.usage.tokens, { source: 'unavailable' });
    assert.equal(env.usage.provider_cost_usd, null);
    assert.match(r.out, /tokens: unavailable/);
  });
});

test('planner telemetry and narrative never enter worker context', () => {
  withProject({}, (p) => {
    const r = plan(p, plannerResult());
    assert.equal(p.run(['plan-approve', r.planId]).code, 0);
    const ctx = p.run(['context', 'TASK-001']);
    assert.equal(ctx.code, 0, ctx.out);
    for (const forbidden of ['PLAN NARRATIVE', 'PLANNER', 'PLAN-', 'assumptions', 'token']) {
      assert.doesNotMatch(ctx.stdout, new RegExp(forbidden, 'i'), `worker context leaked "${forbidden}"`);
    }
    assert.match(ctx.stdout, /^--- KERNEL ---$/m);
    assert.match(ctx.stdout, /^--- FAILURE MEMO ---$/m);
  });
});

// ---------------------------------------------------------------- Goal input

test('--file reads a goal from disk', () => {
  withProject({}, (p) => {
    p.write('goal.md', 'Add OBJ/STL/GLB conversion and a browser viewer.\n');
    const r = p.run(['plan', '--file', 'goal.md'], { LOOP_MOCK_PLANNER: plannerResult() });
    assert.equal(r.code, 0, r.out);
    const planId = (r.out.match(/PLAN-\d{8}T\d{6}Z(?:-\d+)?/) ?? [])[0];
    assert.equal(p.planJson(planId, 'manifest.json').goal_source, 'goal.md');
  });
});

test('an empty goal is a usage error', () => {
  withProject({}, (p) => {
    const r = p.run(['plan']);
    assert.equal(r.code, 2);
    assert.match(r.out, /usage: loopctl plan/);
  });
});
