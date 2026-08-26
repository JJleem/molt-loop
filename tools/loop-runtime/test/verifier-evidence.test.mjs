// verifier-evidence.test — 증거 없는 PASS는 통과하지 못한다.
//
// 대응 Field Note: OBS-009 (Verifier가 "사람이 dev server로 수동 확인했다"는
// 근거 없는 주장을 PASS시켰다).
//
// 핵심 규칙 두 가지를 결정론적으로 확인한다.
//   1. 수동·브라우저·네트워크·외부·실물 실행을 요구하는 AC는 PASS할 수 없다.
//   2. PASS의 근거로 지목한 것이 실제로 존재해야 한다. 서술은 근거가 아니다.
//
// 전부 mock adapter다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml } from './fixture.mjs';
import { validateVerifierResult, EVIDENCE_BASES, UNWITNESSED_KINDS } from '../verifier/result.mjs';

const withProject = (opts, fn) => {
  const p = makeProject(opts);
  try { return fn(p); } finally { p.cleanup(); }
};

const WORKER_OK = JSON.stringify({
  run_id: '__RUN__', task_id: '__TASK__', outcome: 'success',
  summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW',
});

const oneTask = { 'TASK-001': taskYaml('TASK-001') };

/** Verifier Result 한 장. criteria[0]만 바꿔 가며 쓴다. */
const verifierResult = (criterion, overrides = {}) => JSON.stringify({
  run_id: '__RUN__',
  task_id: '__TASK__',
  verification_subject_sha256: '__SUBJECT__',
  result: criterion.status === 'PASS' ? 'PASS' : 'FAIL',
  criteria: [{ id: 'AC1', ...criterion }],
  failed_criteria: criterion.status === 'PASS' ? [] : ['AC1'],
  reason: 'judged',
  ...overrides,
});

/** run -> gate -> verify 를 돌리고 verify 결과를 돌려준다. */
function verifyWith(p, mockVerifier) {
  const r = p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK });
  assert.equal(r.code, 0, r.out);
  const g = p.run(['gate', 'TASK-001']);
  assert.equal(g.code, 0, g.out);
  return p.run(['verify', 'TASK-001'], { LOOP_MOCK_VERIFIER: mockVerifier });
}

// ------------------------------------------------------------------
// 1. 목격되지 않은 실행 — PASS 불가
// ------------------------------------------------------------------

test('a PASS backed by an unwitnessed claim is refused and the task stays in REVIEW', () => {
  withProject({ tasks: oneTask }, (p) => {
    const v = verifyWith(p, verifierResult({
      status: 'PASS',
      reason: 'the document says the app was exercised manually in a dev server',
      evidence_basis: 'unwitnessed_claim',
      unwitnessed_kind: 'browser_session',
      evidence_refs: [],
    }));
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /unwitnessed_claim/);
    assert.match(v.out, /cannot PASS|manual, browser, network/i);
    assert.match(p.taskText('TASK-001'), /^status: REVIEW$/m);
  });
});

test('every unwitnessed kind is refused when attached to a PASS', () => {
  for (const kind of UNWITNESSED_KINDS) {
    const out = validateVerifierResult(judgement({
      status: 'PASS', evidence_basis: 'unwitnessed_claim', unwitnessed_kind: kind,
    }), baseOpts());
    assert.equal(out.valid, false, `${kind} should not be able to PASS`);
    assert.ok(out.errors.some((e) => e.includes('unwitnessed_claim')), out.errors.join('; '));
  }
});

test('an unwitnessed claim reported as FAIL is a valid, expected result', () => {
  withProject({ tasks: oneTask }, (p) => {
    const v = verifyWith(p, verifierResult({
      status: 'FAIL',
      reason: 'AC1 needs a real browser render; the runtime witnessed no such execution',
      evidence_basis: 'unwitnessed_claim',
      unwitnessed_kind: 'real_world_execution',
      evidence_refs: [],
    }));
    // 판정 자체는 유효하다. 결과가 FAIL이라 Task가 DONE이 되지 않을 뿐이다.
    assert.equal(v.code, 1, v.out);
    assert.doesNotMatch(v.out, /verifier result: .*is unsupported/);
    assert.match(v.out, /FAIL/);
    assert.match(p.taskText('TASK-001'), /^status: REVIEW$/m);
  });
});

test('the runtime records which criteria were declared unwitnessed', () => {
  const out = validateVerifierResult(judgement({
    status: 'FAIL', evidence_basis: 'unwitnessed_claim', unwitnessed_kind: 'network_access',
  }), baseOpts());
  assert.equal(out.valid, true, out.errors.join('; '));
  assert.deepEqual(out.result.unwitnessed_criteria, ['AC1']);
  assert.equal(out.result.criteria[0].unwitnessed_kind, 'network_access');
});

// ------------------------------------------------------------------
// 2. 근거 존재 확인 — 서술은 근거가 아니다
// ------------------------------------------------------------------

test('evidence_basis is required on every criterion', () => {
  const raw = judgement({ status: 'PASS' });
  delete raw.criteria[0].evidence_basis;
  const out = validateVerifierResult(raw, baseOpts());
  assert.equal(out.valid, false);
  assert.ok(out.errors.some((e) => /evidence_basis is required/.test(e)), out.errors.join('; '));
});

test('there is no evidence basis that means "the worker said so"', () => {
  for (const invented of ['worker_narrative', 'worker_summary', 'self_report', 'assertion']) {
    assert.ok(!EVIDENCE_BASES.includes(invented), `${invented} must not be an accepted basis`);
    const out = validateVerifierResult(judgement({ status: 'PASS', evidence_basis: invented }), baseOpts());
    assert.equal(out.valid, false, `${invented} should be rejected`);
  }
});

test('a PASS citing a runtime artifact that does not exist is refused', () => {
  withProject({ tasks: oneTask }, (p) => {
    const v = verifyWith(p, verifierResult({
      status: 'PASS',
      reason: 'the gate log proves it',
      evidence_basis: 'runtime_artifact',
      evidence_refs: ['gates/build/stdout.log', 'gates/nonexistent/stdout.log'],
    }));
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /cites evidence that does not exist/);
    assert.match(v.out, /gates\/nonexistent\/stdout\.log/);
  });
});

test('a PASS citing a repository file that does exist is accepted', () => {
  withProject({ tasks: oneTask }, (p) => {
    const v = verifyWith(p, verifierResult({
      status: 'PASS',
      reason: 'the task file itself carries the contract this AC describes',
      evidence_basis: 'repository_content',
      evidence_refs: ['.loop/tasks/TASK-001.yaml'],
    }));
    assert.equal(v.code, 0, v.out);
    assert.match(p.taskText('TASK-001'), /^status: DONE$/m);
  });
});

test('a PASS claiming a gate basis is refused when this run executed no gate', () => {
  withProject({ tasks: oneTask }, (p) => {
    // fixture 기본 Task는 stop_condition.gates가 비어 있다 — 실행된 Gate가 없다.
    const v = verifyWith(p, verifierResult({
      status: 'PASS',
      reason: 'the build gate passed',
      evidence_basis: 'gate',
      evidence_refs: [],
    }));
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /claims a gate basis but this run executed no gate/);
  });
});

test('a PASS claiming a canonical_diff basis is refused when the diff is empty', () => {
  withProject({ tasks: oneTask }, (p) => {
    const v = verifyWith(p, verifierResult({
      status: 'PASS',
      reason: 'the diff implements it',
      evidence_basis: 'canonical_diff',
      evidence_refs: [],
    }));
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /canonical_diff basis but the canonical diff is empty/);
  });
});

test('a PASS with a refs-requiring basis but no refs is refused', () => {
  const out = validateVerifierResult(
    judgement({ status: 'PASS', evidence_basis: 'repository_content', evidence_refs: [] }),
    baseOpts({ refExists: () => true })
  );
  assert.equal(out.valid, false);
  assert.ok(out.errors.some((e) => /lists no evidence_refs/.test(e)), out.errors.join('; '));
});

test('independent verification isolation is untouched: the verifier still gets no worker narrative', () => {
  withProject({ tasks: oneTask }, (p) => {
    const v = verifyWith(p, verifierResult({
      status: 'PASS',
      reason: 'the task file carries it',
      evidence_basis: 'repository_content',
      evidence_refs: ['.loop/tasks/TASK-001.yaml'],
    }));
    assert.equal(v.code, 0, v.out);
    const ctx = readVerifierContext(p, 'TASK-001');
    for (const forbidden of ['WORKER SUMMARY', 'WORKER NARRATIVE', 'WORKER STDOUT']) {
      assert.ok(!ctx.includes(`--- ${forbidden} ---`), `${forbidden} must not reach the verifier`);
    }
    // 새로 추가한 사실은 Runtime 소유 사실이다 — Worker의 주장이 아니다.
    assert.match(ctx, /WITNESSED EXECUTION/);
    assert.match(ctx, /NOT WITNESSED BY THE RUNTIME/);
  });
});

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

const TASK = {
  id: 'TASK-001',
  data: {
    acceptance_criteria: [
      { id: 'AC1', description: 'the thing is done', verification: { type: 'verifier' } },
    ],
  },
};

function judgement(criterion) {
  const status = criterion.status ?? 'PASS';
  return {
    run_id: 'RUN-X', task_id: 'TASK-001', verification_subject_sha256: 'abc',
    result: status === 'PASS' ? 'PASS' : 'FAIL',
    criteria: [{ id: 'AC1', reason: 'because', evidence_refs: [], ...criterion, status }],
    failed_criteria: status === 'PASS' ? [] : ['AC1'],
    reason: 'judged',
  };
}

function baseOpts(factOverrides = {}) {
  return {
    runId: 'RUN-X',
    taskId: 'TASK-001',
    subjectSha256: 'abc',
    task: TASK,
    evidenceFacts: {
      gateReport: { gates: [{ name: 'build', status: 'PASS' }] },
      diffFileCount: 1,
      refExists: () => true,
      ...factOverrides,
    },
  };
}

function readVerifierContext(p, taskId) {
  const runs = join(p.root, '.loop-local', 'runs');
  const dir = readdirSync(runs).filter((d) => d.startsWith('RUN-') && d.includes(`-${taskId}`)).sort().pop();
  return readFileSync(join(runs, dir, 'verification', 'context.md'), 'utf8');
}
