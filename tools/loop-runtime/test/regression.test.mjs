// regression.test — Planner 도입 전에 이미 있던 동작이 그대로인지 확인한다.
//
// Worker · Gate · Verifier · Diagnose · Retry · execute · 읽기 전용 CLI.
// 전부 mock adapter로 돌린다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, taskYaml } from './fixture.mjs';

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

const oneTask = { 'TASK-001': taskYaml('TASK-001') };

test('read-only commands make no AI call and stay at exit 0', () => {
  withProject({ tasks: oneTask }, (p) => {
    for (const cmd of [['status'], ['doctor'], ['tasks'], ['show', 'TASK-001'], ['ready'],
      ['verify-ready'], ['gates'], ['validate'], ['version'], ['help'], ['plans']]) {
      const r = p.run(cmd);
      assert.equal(r.code, 0, `${cmd.join(' ')}: ${r.out}`);
    }
  });
});

test('unknown command is a usage error', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.out, /unknown command: nope/);
  });
});

test('transition is the only state-change path and honours the transition table', () => {
  withProject({ tasks: oneTask }, (p) => {
    assert.equal(p.run(['transition', 'TASK-001', 'DONE']).code, 1, 'TODO -> DONE must be denied');
    const ok = p.run(['transition', 'TASK-001', 'IN_PROGRESS']);
    assert.equal(ok.code, 0, ok.out);
    assert.match(p.taskText('TASK-001'), /^status: IN_PROGRESS$/m);
  });
});

test('worker -> gate -> verifier PASS reaches DONE', () => {
  withProject({ tasks: oneTask }, (p) => {
    assert.equal(p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK }).code, 0);
    assert.match(p.taskText('TASK-001'), /^status: REVIEW$/m);
    assert.equal(p.run(['gate', 'TASK-001']).code, 0);
    assert.equal(p.run(['verify', 'TASK-001'], { LOOP_MOCK_VERIFIER: VERIFIER_PASS }).code, 0);
    assert.match(p.taskText('TASK-001'), /^status: DONE$/m);
  });
});

test('verifier FAIL does not reach DONE', () => {
  withProject({ tasks: oneTask }, (p) => {
    p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK });
    p.run(['gate', 'TASK-001']);
    const v = p.run(['verify', 'TASK-001'], { LOOP_MOCK_VERIFIER: VERIFIER_FAIL });
    assert.equal(v.code, 1);
    assert.match(p.taskText('TASK-001'), /^status: REVIEW$/m);
  });
});

test('a worker that mutates .loop is a policy violation', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['run', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK,
      LOOP_MOCK_TOUCH: `${p.root}/.loop/KERNEL.md`,
    });
    assert.equal(r.code, 1);
    assert.match(r.out, /policy violation/i);
  });
});

test('a missing worker result file fails the run and can be diagnosed without an AI call', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['run', 'TASK-001']);
    assert.equal(r.code, 1);
    const d = p.run(['diagnose', 'TASK-001']);
    assert.equal(d.code, 0, d.out);
    assert.match(d.stdout, /Recommended action|recovery/i);
  });
});

test('execute drives the whole loop to DONE', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['execute', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK,
      LOOP_MOCK_VERIFIER: VERIFIER_PASS,
    });
    assert.equal(r.code, 0, r.out);
    assert.match(p.taskText('TASK-001'), /^status: DONE$/m);
    const ex = p.run(['execution', 'TASK-001']);
    assert.equal(ex.code, 0, ex.out);
  });
});

test('PAUSE empties the ready queue and refuses execution', () => {
  withProject({ tasks: oneTask }, (p) => {
    p.write('.loop-local/PAUSE', '');
    assert.match(p.run(['ready']).stdout, /No ready tasks/);
    assert.equal(p.run(['execute', 'TASK-001']).code, 1);
  });
});

test('the example task is never dispatched', () => {
  withProject({}, (p) => {
    p.write('.loop/tasks/TASK-EXAMPLE.yaml', taskYaml('TASK-EXAMPLE', { status: 'DROPPED' }).replace('status: DROPPED', 'status: DROPPED\nexample: true'));
    assert.match(p.run(['ready']).stdout, /No ready tasks/);
    assert.equal(p.run(['run', 'TASK-EXAMPLE']).code, 1);
  });
});

test('worker telemetry is recorded and reported without a second AI call', () => {
  withProject({ tasks: oneTask }, (p) => {
    p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_USAGE: JSON.stringify({ input: 10, output: 2 }) });
    const u = p.run(['usage', 'TASK-001']);
    assert.equal(u.code, 0, u.out);
    assert.match(u.stdout, /tokens: input=10 output=2 \(provider\)/);
  });
});
