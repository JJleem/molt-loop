// dependencies.test — depends_on 도입 이후의 파생 READY와 실행 거부.
//
// 새 저장 상태를 만들지 않았다는 것을 함께 검사한다: 선행 Task를 기다리는 Task는
// TODO 그대로이며 BLOCKED가 되지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, taskYaml } from './fixture.mjs';

const withProject = (opts, fn) => {
  const p = makeProject(opts);
  try { return fn(p); } finally { p.cleanup(); }
};

const chain = (firstStatus = 'TODO') => ({
  'TASK-001': taskYaml('TASK-001', { status: firstStatus, request: 'first' }),
  'TASK-002': taskYaml('TASK-002', { dependsOn: ['TASK-001'], request: 'second' }),
});

test('a dependency-free legacy task without depends_on is still READY', () => {
  withProject({ tasks: { 'TASK-001': taskYaml('TASK-001') } }, (p) => {
    const r = p.run(['ready']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /TASK-001\s+TODO/);
    assert.equal(p.run(['validate']).code, 0);
  });
});

test('a TODO task waiting on a dependency is not READY and stays TODO', () => {
  withProject({ tasks: chain() }, (p) => {
    const ready = p.run(['ready']);
    assert.match(ready.stdout, /TASK-001/);
    assert.doesNotMatch(ready.stdout.split('Waiting on dependencies:')[0], /TASK-002/);
    assert.match(ready.stdout, /Waiting on dependencies:\n\s*TASK-002\s+waiting on: TASK-001/);

    const show = p.run(['show', 'TASK-002']);
    assert.match(show.stdout, /^status:\s+TODO$/m);
    assert.match(show.stdout, /^ready:\s+false$/m);
    assert.match(show.stdout, /^depends_on: TASK-001$/m);
    // BLOCKED 같은 새 저장 상태를 만들지 않는다.
    assert.doesNotMatch(p.taskText('TASK-002'), /status: BLOCKED/);
  });
});

test('a task becomes READY once its prerequisite is DONE', () => {
  withProject({ tasks: chain('DONE') }, (p) => {
    const r = p.run(['ready']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /TASK-002\s+TODO/);
    assert.doesNotMatch(r.stdout, /Waiting on dependencies/);
  });
});

test('run refuses a task with an unmet dependency and does not claim it', () => {
  withProject({ tasks: chain() }, (p) => {
    const r = p.run(['run', 'TASK-002'], { LOOP_MOCK_RESULT: '{}' });
    assert.equal(r.code, 1);
    assert.match(r.out, /TASK-002 is not ready\./);
    assert.match(r.out, /Waiting on:\n\s*TASK-001/);
    // 거부는 상태를 바꾸지 않는다.
    assert.match(p.taskText('TASK-002'), /^status: TODO$/m);
  });
});

test('execute refuses a task with an unmet dependency', () => {
  withProject({ tasks: chain() }, (p) => {
    const r = p.run(['execute', 'TASK-002']);
    assert.equal(r.code, 1);
    assert.match(r.out, /TASK-002 is not ready\.|WORKER_NOT_DISPATCHABLE/);
    assert.match(r.out, /TASK-001/);
    assert.match(p.taskText('TASK-002'), /^status: TODO$/m);
  });
});

test('run proceeds for a task whose dependency is DONE', () => {
  withProject({ tasks: chain('DONE') }, (p) => {
    const r = p.run(['run', 'TASK-002'], {
      LOOP_MOCK_RESULT: JSON.stringify({
        run_id: '__RUN__', task_id: '__TASK__', outcome: 'success',
        summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW',
      }),
    });
    assert.equal(r.code, 0, r.out);
    assert.match(p.taskText('TASK-002'), /^status: REVIEW$/m);
  });
});

test('a missing dependency task is detected by validate and doctor', () => {
  withProject({ tasks: { 'TASK-002': taskYaml('TASK-002', { dependsOn: ['TASK-001'] }) } }, (p) => {
    const v = p.run(['validate']);
    assert.equal(v.code, 1);
    assert.match(v.out, /depends_on references unknown task "TASK-001"/);
    assert.equal(p.run(['doctor']).code, 1);
  });
});

test('a persisted dependency cycle is detected deterministically', () => {
  withProject({
    tasks: {
      'TASK-001': taskYaml('TASK-001', { dependsOn: ['TASK-002'] }),
      'TASK-002': taskYaml('TASK-002', { dependsOn: ['TASK-001'] }),
    },
  }, (p) => {
    const v = p.run(['validate']);
    assert.equal(v.code, 1);
    assert.match(v.out, /dependency cycle detected among: TASK-001, TASK-002/);
    // 순환에 걸린 Task는 READY가 아니다 (선행이 DONE이 아니므로).
    assert.match(p.run(['ready']).stdout, /No ready tasks|Waiting on dependencies/);
  });
});

test('self-dependency is rejected by task validation', () => {
  withProject({ tasks: { 'TASK-001': taskYaml('TASK-001', { dependsOn: ['TASK-001'] }) } }, (p) => {
    const v = p.run(['validate']);
    assert.equal(v.code, 1);
    assert.match(v.out, /depends on itself/);
  });
});

test('duplicate dependency is rejected by task validation', () => {
  withProject({
    tasks: {
      'TASK-001': taskYaml('TASK-001', { status: 'DONE' }),
      'TASK-002': taskYaml('TASK-002', { dependsOn: ['TASK-001', 'TASK-001'] }),
    },
  }, (p) => {
    const v = p.run(['validate']);
    assert.equal(v.code, 1);
    assert.match(v.out, /duplicate dependency "TASK-001"/);
  });
});

test('status shows why a TODO task is not dispatchable without inventing a state', () => {
  withProject({ tasks: chain() }, (p) => {
    const r = p.run(['status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /TODO \(not dispatchable\)/);
    assert.match(r.stdout, /TASK-002.*\[waiting on: TASK-001\]/s);
  });
});

test('existing runtime behaviour is unchanged for dependency-free tasks', () => {
  withProject({ tasks: { 'TASK-001': taskYaml('TASK-001') } }, (p) => {
    const run = p.run(['run', 'TASK-001'], {
      LOOP_MOCK_RESULT: JSON.stringify({
        run_id: '__RUN__', task_id: '__TASK__', outcome: 'success',
        summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW',
      }),
    });
    assert.equal(run.code, 0, run.out);
    const gate = p.run(['gate', 'TASK-001']);
    assert.equal(gate.code, 0, gate.out);
    const verify = p.run(['verify', 'TASK-001'], {
      LOOP_MOCK_VERIFIER: JSON.stringify({
        run_id: '__RUN__', task_id: '__TASK__', verification_subject_sha256: '__SUBJECT__',
        result: 'PASS', criteria: [{
          id: 'AC1', status: 'PASS', reason: 'the repository already contains it',
          evidence_basis: 'repository_content', evidence_refs: ['.loop/tasks/__TASK__.yaml'],
        }],
        failed_criteria: [], reason: 'all criteria hold',
      }),
    });
    assert.equal(verify.code, 0, verify.out);
    assert.match(p.taskText('TASK-001'), /^status: DONE$/m);
  });
});
