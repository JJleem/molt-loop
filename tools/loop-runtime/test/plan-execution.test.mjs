// plan-execution.test — 승인된 Plan의 순차 실행.
//
// 확인하는 계약:
//   - 승인된 Plan에만 동작한다
//   - READY는 Runtime 의존성 규칙으로 계산한다
//   - 한 번에 Task 하나 (shared working tree)
//   - DONE이면 다음 Task로, 사람이 필요한 정지에서는 즉시 멈춘다
//   - Plan 실행 보고서를 남긴다
//   - 다시 실행하면 남은 Task부터 이어간다
//   - 오케스트레이션에 추가 LLM 호출이 없다
//
// 전부 mock adapter다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml, plannerResult } from './fixture.mjs';
import { selectNextPlanTask } from '../loop/plan-executor.mjs';

const withProject = (opts, fn) => {
  const p = makeProject(opts);
  try { return fn(p); } finally { p.cleanup(); }
};

const WORKER_OK = JSON.stringify({
  run_id: '__RUN__', task_id: '__TASK__', outcome: 'success',
  summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW',
});
const VERIFIER_PASS = JSON.stringify({
  run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__',
  result: 'PASS', criteria: [{
    id: 'AC1', status: 'PASS', reason: 'the repository already contains it',
    evidence_basis: 'repository_content', evidence_refs: ['.loop/tasks/__TASK__.yaml'],
  }],
  failed_criteria: [], reason: 'all criteria hold',
});
const VERIFIER_FAIL = JSON.stringify({
  run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__',
  result: 'FAIL', criteria: [{
    id: 'AC1', status: 'FAIL', reason: 'nothing implements it',
    evidence_basis: 'canonical_diff', evidence_refs: [],
  }],
  failed_criteria: ['AC1'], reason: 'AC1 is not implemented',
});

const GOOD = { LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_PASS };

/** Plan을 만들고 승인한다. 기본 fixture Plan은 P1 -> P2 (P2가 P1에 의존). */
function approvedPlan(p) {
  const planned = p.run(['plan', 'build the thing'], { LOOP_MOCK_PLANNER: plannerResult() });
  assert.equal(planned.code, 0, planned.out);
  const planId = p.plans()[p.plans().length - 1];
  const approved = p.run(['plan-approve', planId]);
  assert.equal(approved.code, 0, approved.out);
  return planId;
}

const planExecutions = (p, planId) => {
  const dir = join(p.planDir(planId), 'executions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('PLANEXEC-') && f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
    .map((id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
};

// ------------------------------------------------------------------
// 승인 경계
// ------------------------------------------------------------------

test('execute-plan refuses a plan that has not been approved', () => {
  withProject({}, (p) => {
    const planned = p.run(['plan', 'build the thing'], { LOOP_MOCK_PLANNER: plannerResult() });
    assert.equal(planned.code, 0, planned.out);
    const planId = p.plans()[p.plans().length - 1];

    const r = p.run(['execute-plan', planId], GOOD);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not approved/);
    // 아무 Task도 만들어지지 않았고, 실행도 없었다.
    assert.deepEqual(p.taskFiles().filter((f) => f.startsWith('TASK-')), []);
  });
});

test('execute-plan refuses an unknown plan reference', () => {
  withProject({}, (p) => {
    const r = p.run(['execute-plan', 'PLAN-19700101T000000Z'], GOOD);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Plan not found/);
  });
});

test('execute-plan does not approve anything by itself', () => {
  withProject({}, (p) => {
    const planned = p.run(['plan', 'build the thing'], { LOOP_MOCK_PLANNER: plannerResult() });
    assert.equal(planned.code, 0, planned.out);
    const planId = p.plans()[p.plans().length - 1];
    p.run(['execute-plan', planId], GOOD);
    assert.equal(p.planJson(planId, 'approval.json'), null, 'execute-plan must never approve a plan');
  });
});

// ------------------------------------------------------------------
// 순차 실행
// ------------------------------------------------------------------

test('execute-plan drives every task to DONE in dependency order', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    const r = p.run(['execute-plan', planId], GOOD);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Plan Result: DONE/);
    assert.match(r.stdout, /stop_reason: PLAN_COMPLETE/);

    for (const id of ['TASK-001', 'TASK-002']) {
      assert.match(p.taskText(id), /^status: DONE$/m, `${id} should be DONE`);
    }

    const [report] = planExecutions(p, planId);
    assert.equal(report.result, 'DONE');
    assert.deepEqual(report.executions.map((e) => e.task_id), ['TASK-001', 'TASK-002']);
    // 선행 Task가 먼저 끝나야 다음이 시작된다.
    assert.ok(report.executions.every((e) => e.result === 'DONE'));
  });
});

test('plan-level orchestration makes no additional llm call', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    assert.equal(p.run(['execute-plan', planId], GOOD).code, 0);
    const [report] = planExecutions(p, planId);
    assert.equal(report.orchestration_llm_calls, 0);
    // 호출은 전부 Task 실행에 귀속된다: Task 2개 x (worker 1 + verifier 1).
    assert.equal(report.usage_summary.llm_invocations, 4);
    assert.equal(report.usage_summary.task_executions, 2);
  });
});

test('tasks never run concurrently: each execution starts after the previous one ends', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    assert.equal(p.run(['execute-plan', planId], GOOD).code, 0);
    const [report] = planExecutions(p, planId);
    const execs = report.executions.map((e) => readExecution(p, e.execution_id));
    for (let i = 1; i < execs.length; i += 1) {
      assert.ok(Date.parse(execs[i].started_at) >= Date.parse(execs[i - 1].finished_at),
        `${execs[i].task_id} started before ${execs[i - 1].task_id} finished`);
    }
    // 활성 표식이 남지 않는다.
    const activeDir = join(p.root, '.loop-local', 'executions', 'active');
    const leftovers = existsSync(activeDir) ? readdirSync(activeDir) : [];
    assert.deepEqual(leftovers, []);
  });
});

// ------------------------------------------------------------------
// 정지와 재개
// ------------------------------------------------------------------

test('a task that stops for a human stops the whole plan immediately', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    const r = p.run(['execute-plan', planId], {
      LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_FAIL,
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.stdout, /stop_reason: TASK_STOPPED/);
    assert.match(r.stdout, /TASK-001 stopped with/);

    // 뒤 Task는 손대지 않는다.
    assert.match(p.taskText('TASK-002'), /^status: TODO$/m);
    const [report] = planExecutions(p, planId);
    assert.deepEqual(report.executions.map((e) => e.task_id), ['TASK-001']);
    assert.notEqual(report.result, 'DONE');
  });
});

test('PAUSE stops the plan before it starts another task', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    p.write('.loop-local/PAUSE', '');
    const r = p.run(['execute-plan', planId], GOOD);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /PAUSE is active/);
    assert.match(p.taskText('TASK-001'), /^status: TODO$/m);
  });
});

test('re-running the plan resumes from the remaining tasks', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);

    // 1회차: 첫 Task에서 멈춘다.
    const first = p.run(['execute-plan', planId], {
      LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_FAIL,
    });
    assert.equal(first.code, 1, first.out);
    assert.match(first.stdout, /resumes from the remaining tasks/);

    // 사람이 그 Task를 손으로 끝낸다.
    assert.equal(p.run(['verify', 'TASK-001', '--rerun'], { LOOP_MOCK_VERIFIER: VERIFIER_PASS }).code, 0);
    assert.match(p.taskText('TASK-001'), /^status: DONE$/m);

    // 2회차: 남은 Task만 실행한다.
    const second = p.run(['execute-plan', planId], GOOD);
    assert.equal(second.code, 0, second.out);
    const reports = planExecutions(p, planId);
    assert.equal(reports.length, 2, 'each plan run writes its own report');
    assert.deepEqual(reports[1].executions.map((e) => e.task_id), ['TASK-002'],
      'the second run must not re-execute the finished task');
    assert.equal(reports[1].result, 'DONE');
  });
});

test('a completed plan is a no-op on the next run', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    assert.equal(p.run(['execute-plan', planId], GOOD).code, 0);
    const again = p.run(['execute-plan', planId], GOOD);
    assert.equal(again.code, 0, again.out);
    assert.match(again.stdout, /Plan Result: DONE/);
    const reports = planExecutions(p, planId);
    assert.deepEqual(reports[reports.length - 1].executions, [], 'nothing left to execute');
  });
});

// ------------------------------------------------------------------
// 선택 로직 (결정론적, 프로세스 없이)
// ------------------------------------------------------------------

test('the next-task selection reports why it cannot proceed instead of guessing', () => {
  withProject({
    tasks: {
      'TASK-001': taskYaml('TASK-001', { status: 'BLOCKED' }),
      'TASK-002': taskYaml('TASK-002', { dependsOn: ['TASK-001'] }),
    },
  }, () => {
    // selectNextPlanTask는 실제 프로젝트 ROOT에서 Task를 읽으므로,
    // 여기서는 존재하지 않는 Task를 가리켰을 때의 결정론적 거부만 확인한다.
    const out = selectNextPlanTask(['TASK-DOES-NOT-EXIST']);
    assert.equal(out.stop, 'PLAN_TASK_MISSING');
    assert.match(out.reason, /TASK-DOES-NOT-EXIST/);
  });
});

test('a blocked plan task stops the plan with a human-required reason', () => {
  withProject({}, (p) => {
    const planId = approvedPlan(p);
    // Worker가 blocked를 요청하면 Task는 BLOCKED가 된다.
    const r = p.run(['execute-plan', planId], {
      LOOP_MOCK_RESULT: JSON.stringify({
        run_id: '__RUN__', task_id: '__TASK__', outcome: 'blocked',
        summary: 'cannot proceed', changed_files: [], evidence: [], requested_transition: 'BLOCKED',
      }),
    });
    assert.equal(r.code, 1, r.out);
    assert.match(p.taskText('TASK-001'), /^status: BLOCKED$/m);
    assert.match(p.taskText('TASK-002'), /^status: TODO$/m);
    const [report] = planExecutions(p, planId);
    assert.notEqual(report.result, 'DONE');
  });
});

function readExecution(p, execId) {
  return JSON.parse(readFileSync(
    join(p.root, '.loop-local', 'executions', execId, 'execution-report.json'), 'utf8'
  ));
}
