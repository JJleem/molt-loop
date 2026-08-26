// operability.test — 진행 중인 실행의 가시성과 수동 복구 조정.
//
// 대응 Field Note:
//   OBS-006 — 진행 중인 Run이 status에 보이지 않아 사람이 `ps`로 판단해야 했다.
//             좀비 wrapper 프로세스 때문에 PID 생존 폴링이 8분간 오판했다.
//   OBS-004 — 수동 gate/verify 복구로 Task가 DONE이 돼도 Execution Report는
//             NEEDS_HUMAN으로 남았다.
//
// 전부 mock adapter다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml } from './fixture.mjs';
import { classifyActiveMarker, HEARTBEAT_STALE_MS } from '../loop/execution-report.mjs';

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

const oneTask = { 'TASK-001': taskYaml('TASK-001') };

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function writeMarker(p, taskId, marker) {
  const dir = join(p.root, '.loop-local', 'executions', 'active');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.json`), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

// ------------------------------------------------------------------
// 4. 진행 중인 실행의 가시성
// ------------------------------------------------------------------

test('a fresh heartbeat is RUNNING and a stale one is STALE, regardless of the pid', () => {
  // 좀비 프로세스가 있는 상황을 재현한다: PID는 살아 있지만(자기 자신) heartbeat는 끊겼다.
  const zombie = { execution_id: 'EXEC-X', pid: process.pid, started_at: iso(-HEARTBEAT_STALE_MS * 2), heartbeat_at: iso(-HEARTBEAT_STALE_MS * 2) };
  const stale = classifyActiveMarker(zombie);
  assert.equal(stale.state, 'STALE', 'a live pid must not make a dead execution look alive');
  assert.match(stale.reason, /no heartbeat/);

  const alive = classifyActiveMarker({ execution_id: 'EXEC-Y', pid: 999999, heartbeat_at: iso(-1000) });
  assert.equal(alive.state, 'RUNNING', 'a fresh heartbeat is what makes an execution live');

  assert.equal(classifyActiveMarker(null).state, 'STALE');
  assert.equal(classifyActiveMarker({ corrupt: true }).state, 'STALE');
  assert.equal(classifyActiveMarker({ execution_id: 'EXEC-Z' }).state, 'STALE');
});

test('status shows a running execution with its stage instead of "latest run: (none)"', () => {
  withProject({ tasks: oneTask }, (p) => {
    writeMarker(p, 'TASK-001', {
      task_id: 'TASK-001',
      execution_id: 'EXEC-20260826T064141Z-TASK-001',
      pid: 999999,
      started_at: iso(-60_000),
      heartbeat_at: iso(-2_000),
      stage: 'worker',
      run_id: 'RUN-20260826T064142Z-TASK-001',
      attempt: 1,
    });
    const r = p.run(['status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /ACTIVE EXECUTION/);
    assert.match(r.stdout, /TASK-001\s+RUNNING/);
    assert.match(r.stdout, /EXEC-20260826T064141Z-TASK-001/);
    assert.match(r.stdout, /stage: worker/);
    assert.match(r.stdout, /run: RUN-20260826T064142Z-TASK-001/);
    // 생존 판정 근거를 명시한다 — 사람이 ps로 확인할 필요가 없어야 한다.
    assert.match(r.stdout, /heartbeat/);
  });
});

test('status marks an abandoned execution STALE and says how to reclaim it', () => {
  withProject({ tasks: oneTask }, (p) => {
    writeMarker(p, 'TASK-001', {
      task_id: 'TASK-001',
      execution_id: 'EXEC-OLD',
      pid: process.pid,                       // 살아 있는 PID — 그럼에도 STALE이어야 한다
      started_at: iso(-HEARTBEAT_STALE_MS * 3),
      heartbeat_at: iso(-HEARTBEAT_STALE_MS * 3),
      stage: 'gate',
    });
    const r = p.run(['status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /TASK-001\s+STALE/);
    assert.match(r.stdout, /will reclaim it/);
  });
});

test('execute reclaims a stale marker but refuses a live one', () => {
  withProject({ tasks: oneTask }, (p) => {
    writeMarker(p, 'TASK-001', {
      task_id: 'TASK-001', execution_id: 'EXEC-LIVE', pid: process.pid,
      started_at: iso(-1_000), heartbeat_at: iso(-1_000), stage: 'worker',
    });
    const refused = p.run(['execute', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK });
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /already being executed by EXEC-LIVE/);

    // heartbeat만 과거로 돌리면 회수 가능해야 한다. PID는 그대로 살아 있다.
    writeMarker(p, 'TASK-001', {
      task_id: 'TASK-001', execution_id: 'EXEC-ZOMBIE', pid: process.pid,
      started_at: iso(-HEARTBEAT_STALE_MS * 2), heartbeat_at: iso(-HEARTBEAT_STALE_MS * 2), stage: 'worker',
    });
    const reclaimed = p.run(['execute', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_PASS,
    });
    assert.equal(reclaimed.code, 0, reclaimed.out);
    assert.match(reclaimed.out, /reclaimed a stale execution marker from EXEC-ZOMBIE/);
  });
});

test('the marker is written before any stage and removed when the execution ends', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['execute', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_PASS,
    });
    assert.equal(r.code, 0, r.out);
    const marker = join(p.root, '.loop-local', 'executions', 'active', 'TASK-001.json');
    assert.ok(!existsSync(marker), 'a finished execution must not leave an active marker behind');
    const s = p.run(['status']);
    assert.doesNotMatch(s.stdout, /ACTIVE EXECUTION/);
  });
});

// ------------------------------------------------------------------
// 5. 수동 복구 조정
// ------------------------------------------------------------------

test('a manual gate+verify recovery is recorded as its own execution', () => {
  withProject({ tasks: oneTask }, (p) => {
    assert.equal(p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK }).code, 0);
    assert.equal(p.run(['gate', 'TASK-001']).code, 0);
    const v = p.run(['verify', 'TASK-001'], { LOOP_MOCK_VERIFIER: VERIFIER_PASS });
    assert.equal(v.code, 0, v.out);
    assert.match(v.stdout, /Recorded this manual recovery as EXEC-/);

    const ex = p.run(['execution', 'TASK-001']);
    assert.equal(ex.code, 0, ex.out);
    assert.match(ex.stdout, /origin: manual recovery/);
    assert.match(ex.stdout, /result: DONE/);
    assert.match(ex.stdout, /manual stages: gate -> verify/);
  });
});

/**
 * OBS-004가 관찰한 상황을 그대로 만든다.
 * execute가 Verifier 단계에서 멈춰 Task는 REVIEW로 남고, 사람이 verify로 이어받는다.
 */
function stalledAtVerify(p) {
  assert.equal(p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK }).code, 0);
  const e = p.run(['execute', 'TASK-001'], {
    LOOP_MOCK_RESULT: WORKER_OK,
    LOOP_MOCK_VERIFIER_RAW: 'not a verdict',   // 구조화 출력 없음 -> 판정 불가
  });
  assert.equal(e.code, 1, e.out);
  assert.match(p.taskText('TASK-001'), /^status: REVIEW$/m);
  return latestExecutionId(p);
}

test('status stops reporting a stalled execution once the task has moved past it', () => {
  withProject({ tasks: oneTask }, (p) => {
    stalledAtVerify(p);
    const first = readLatestExecution(p, 'TASK-001');
    assert.notEqual(first.result, 'DONE');
    assert.equal(first.final_task_status, 'REVIEW');

    // 사람이 손으로 이어받아 끝낸다.
    assert.equal(p.run(['verify', 'TASK-001', '--rerun'], { LOOP_MOCK_VERIFIER: VERIFIER_PASS }).code, 0);
    assert.match(p.taskText('TASK-001'), /^status: DONE$/m);

    const s = p.run(['status']);
    assert.equal(s.code, 0, s.out);
    assert.match(s.stdout, /latest execution: DONE.*manual recovery/);
    assert.doesNotMatch(s.stdout, /latest execution: NEEDS_HUMAN/);
    assert.doesNotMatch(s.stdout, /latest execution: STALLED/);
  });
});

test('a report whose task later moved on is marked superseded rather than rewritten', () => {
  withProject({ tasks: oneTask }, (p) => {
    const firstId = stalledAtVerify(p);
    const before = readFileSync(executionReportPath(p, firstId), 'utf8');

    assert.equal(p.run(['verify', 'TASK-001', '--rerun'], { LOOP_MOCK_VERIFIER: VERIFIER_PASS }).code, 0);

    assert.equal(readFileSync(executionReportPath(p, firstId), 'utf8'), before,
      'the earlier execution report must never be rewritten');

    const manual = readLatestExecution(p, 'TASK-001');
    assert.equal(manual.origin, 'manual');
    assert.equal(manual.supersedes, firstId);
    assert.deepEqual(manual.manual_stages, ['gate', 'verify']);

    const ex = p.run(['execution', firstId]);
    assert.equal(ex.code, 0, ex.out);
    assert.match(ex.stdout, /result: (STALLED|NEEDS_HUMAN|FAILED)/);
  });
});

test('a still-relevant report is not marked superseded', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['execute', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_PASS,
    });
    assert.equal(r.code, 0, r.out);
    const s = p.run(['status']);
    assert.doesNotMatch(s.stdout, /superseded/);
  });
});

test('an orchestrated execution does not also write a manual record', () => {
  withProject({ tasks: oneTask }, (p) => {
    const r = p.run(['execute', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK, LOOP_MOCK_VERIFIER: VERIFIER_PASS,
    });
    assert.equal(r.code, 0, r.out);
    const reports = listExecutions(p).map((id) => readExecution(p, id));
    assert.equal(reports.filter((x) => x.origin === 'manual').length, 0,
      'execute owns its own report; it must not also produce a manual one');
    assert.equal(reports.filter((x) => x.result === 'DONE').length, 1);
  });
});

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

const executionsDir = (p) => join(p.root, '.loop-local', 'executions');
const executionReportPath = (p, execId) => join(executionsDir(p), execId, 'execution-report.json');

function listExecutions(p) {
  const dir = executionsDir(p);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => d.startsWith('EXEC-')).sort();
}

const readExecution = (p, execId) => JSON.parse(readFileSync(executionReportPath(p, execId), 'utf8'));

function latestExecutionId(p) {
  const ids = listExecutions(p);
  return ids[ids.length - 1];
}

function readLatestExecution(p, taskId) {
  const ids = listExecutions(p).filter((id) => id.includes(`-${taskId}`));
  return readExecution(p, ids[ids.length - 1]);
}
