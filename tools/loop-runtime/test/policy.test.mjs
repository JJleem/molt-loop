// policy.test — Worker 권한 경계와 self-check.
//
// 대응 Field Note: OBS-002 후속(evidence 경로 쓰기 거부, Phase 1 8 Task / 9 Run 전부 재현),
//                  OBS-007(Gate 실행 불가로 Attempt 1 폐기), OBS-008.
//
// 전부 mock adapter다. 토큰을 쓰지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, taskYaml } from './fixture.mjs';
import {
  workerDenyRules, workerAllowRules, protectedPathPatterns, evidencePathFor, selfCheckCommand,
  EVIDENCE_ROOT,
} from '../worker/policy.mjs';

const withProject = (opts, fn) => {
  const p = makeProject(opts);
  try { return fn(p); } finally { p.cleanup(); }
};

const WORKER_OK = JSON.stringify({
  run_id: '__RUN__', task_id: '__TASK__', outcome: 'success',
  summary: 'done', changed_files: [], evidence: [], requested_transition: 'REVIEW',
});

const twoTasks = {
  'TASK-001': taskYaml('TASK-001'),
  'TASK-002': taskYaml('TASK-002'),
};

// ------------------------------------------------------------------
// 1. Evidence 쓰기 정책 — fingerprint 예외와 deny 규칙이 같은 경계를 쓴다
// ------------------------------------------------------------------

test('the deny rules open exactly the task\'s own evidence directory and nothing else', () => {
  const patterns = protectedPathPatterns('TASK-001');
  const own = evidencePathFor('TASK-001');

  // 자기 Evidence 디렉터리는 거부 목록에 없다 — 이것이 OBS-002가 기록한 모순의 핵심이다.
  assert.ok(!patterns.includes(`${own}/**`), `own evidence dir must not be denied: ${patterns.join(', ')}`);
  assert.ok(!patterns.some((p) => p === own), 'own evidence dir must not be denied');

  // 나머지 control plane은 전부 거부된다.
  for (const expected of ['.loop/tasks/**', '.loop/skills/**', '.loop/policies/**', '.loop/KERNEL.md']) {
    assert.ok(patterns.includes(expected), `expected ${expected} in ${patterns.join(', ')}`);
  }

  // `.loop/**` 를 통째로 막는 옛 규칙은 남아 있으면 안 된다 — 그러면 자기 Evidence도 막힌다.
  const rules = workerDenyRules('TASK-001');
  assert.ok(!rules.includes('Edit(.loop/**)'), 'the blanket .loop deny rule must be gone');
  assert.ok(!rules.includes('Write(.loop/**)'), 'the blanket .loop deny rule must be gone');
  assert.ok(rules.includes('Edit(.loop/tasks/**)') && rules.includes('Write(.loop/tasks/**)'));
});

test('an existing sibling evidence directory is denied to a different task', () => {
  // 이 저장소의 실제 .loop/evidence/ 를 대상으로 확인한다 (policy는 ROOT에서 유도된다).
  const sibling = join(EVIDENCE_ROOT, 'TASK-POLICY-PROBE');
  const created = !existsSync(sibling);
  if (created) mkdirSync(sibling, { recursive: true });
  try {
    const mine = protectedPathPatterns('TASK-001');
    const theirs = protectedPathPatterns('TASK-POLICY-PROBE');
    assert.ok(mine.includes('.loop/evidence/TASK-POLICY-PROBE/**'),
      'a sibling evidence directory must be denied to other tasks');
    assert.ok(!theirs.includes('.loop/evidence/TASK-POLICY-PROBE/**'),
      'a task must keep write access to its own evidence directory');
  } finally {
    if (created) rmSync(sibling, { recursive: true, force: true });
  }
});

test('a worker writing into its own evidence directory is not a policy violation', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const r = p.run(['run', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK,
      LOOP_MOCK_WRITE_PATH: '.loop/evidence/TASK-001/notes.md',
      LOOP_MOCK_WRITE_BODY: '# evidence the worker produced\n',
    });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /policy violation/i);

    const written = join(p.root, '.loop/evidence/TASK-001/notes.md');
    assert.ok(existsSync(written), 'the evidence file should still be there');

    const env = JSON.parse(readFileSync(
      join(p.root, '.loop-local/runs', latestRun(p, 'TASK-001'), 'runtime-envelope.json'), 'utf8'
    ));
    assert.equal(env.policy_violation, false);
    assert.deepEqual(env.protected_paths.exceptions, ['.loop/evidence/TASK-001']);
  });
});

test('a worker writing into another task\'s evidence directory is a policy violation', () => {
  withProject({ tasks: twoTasks }, (p) => {
    // 남의 Evidence 디렉터리가 이미 존재하는 상태를 만든다.
    p.write('.loop/evidence/TASK-002/existing.md', 'belongs to TASK-002\n');
    p.commitAll('seed other evidence');

    const r = p.run(['run', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK,
      LOOP_MOCK_WRITE_PATH: '.loop/evidence/TASK-002/leaked.md',
      LOOP_MOCK_WRITE_BODY: 'written by the wrong task\n',
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /policy violation/i);
    assert.match(r.out, /TASK-002/);
  });
});

test('runtime-owned files outside evidence remain a policy violation', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const r = p.run(['run', 'TASK-001'], {
      LOOP_MOCK_RESULT: WORKER_OK,
      LOOP_MOCK_TOUCH: `${p.root}/.loop/KERNEL.md`,
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /policy violation/i);
  });
});

test('the result protocol tells the worker where evidence goes instead of making it guess', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const r = p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK });
    assert.equal(r.code, 0, r.out);
    // Runtime이 Run 시작 전에 만들어 둔다 — Worker가 mkdir을 시도하다 거부당하지 않도록.
    assert.ok(existsSync(join(p.root, '.loop/evidence/TASK-001')));
  });
});

// ------------------------------------------------------------------
// 2. Self-check — Gate 명령만, 임의 명령은 여전히 거부
// ------------------------------------------------------------------

test('the worker allow list contains exactly one rule: the runtime self-check entry point', () => {
  const allow = workerAllowRules();
  assert.equal(allow.length, 1, `expected a single allow rule, got ${JSON.stringify(allow)}`);
  assert.equal(allow[0], `Bash(${selfCheckCommand()}:*)`);
  // 프로젝트 명령을 직접 여는 규칙이 있으면 Gate 설정을 우회하는 두 번째 출처가 된다.
  for (const forbidden of [/Bash\(npm/, /Bash\(npx/, /Bash\(node -e/, /^Bash\(\*/, /^Bash$/]) {
    assert.ok(!allow.some((a) => forbidden.test(a)), `allow list must not contain ${forbidden}`);
  }
});

test('self-check runs a configured gate and reports its deterministic result', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const r = p.run(['self-check', 'build']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /build: PASS/);
    // 정본 Gate 실행과 혼동되지 않아야 한다.
    assert.match(r.stdout, /advisory/i);
  });
});

test('self-check refuses a gate name that is not configured and executes nothing', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const r = p.run(['self-check', 'rm-rf']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /unknown gate "rm-rf"/);
    assert.ok(!existsSync(join(p.root, '.loop-local/self-check')), 'nothing should have been executed');
  });
});

test('self-check treats its arguments as gate names, never as command strings', () => {
  withProject({ tasks: twoTasks }, (p) => {
    // 명령 주입 시도. 이름으로 해석되지 않으므로 아무것도 실행되지 않는다.
    for (const injected of ['build; touch pwned', 'build && touch pwned', '$(touch pwned)', '../../etc/passwd']) {
      const r = p.run(['self-check', injected]);
      assert.equal(r.code, 2, `${injected}: ${r.out}`);
      assert.match(r.out, /unknown gate/);
    }
    assert.ok(!existsSync(join(p.root, 'pwned')), 'no injected command may run');
  });
});

test('self-check refuses a disabled gate rather than inventing a PASS', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const r = p.run(['self-check', 'lint']);   // fixture: lint is enabled: false
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /disabled/);
  });
});

test('self-check writes no gate report and changes no task state', () => {
  withProject({ tasks: twoTasks }, (p) => {
    const before = p.taskText('TASK-001');
    const r = p.run(['self-check']);
    assert.equal(r.code, 0, r.out);
    assert.equal(p.taskText('TASK-001'), before, 'task state must not move');

    // Gate Report는 Runtime 소유 산출물이다. self-check는 만들지 않는다.
    assert.ok(!existsSync(join(p.root, '.loop-local/self-check/gate-report.json')),
      'self-check must not produce a gate report');
    const runs = join(p.root, '.loop-local/runs');
    const runDirs = existsSync(runs) ? readdirSync(runs).filter((d) => d.startsWith('RUN-')) : [];
    assert.deepEqual(runDirs, [], 'self-check must not create a run');
  });
});

test('gate still runs independently after a worker that could self-check', () => {
  withProject({ tasks: { 'TASK-001': taskYaml('TASK-001') } }, (p) => {
    // Worker가 self-check를 돌렸든 아니든, Runtime은 Gate를 자기 손으로 다시 돌린다.
    const r = p.run(['run', 'TASK-001'], { LOOP_MOCK_RESULT: WORKER_OK });
    assert.equal(r.code, 0, r.out);
    const g = p.run(['gate', 'TASK-001']);
    assert.equal(g.code, 0, g.out);
    const runDir = join(p.root, '.loop-local/runs', latestRun(p, 'TASK-001'));
    assert.ok(existsSync(join(runDir, 'gate-report.json')), 'the authoritative gate report is the runtime\'s');
  });
});

/** 이 Task의 최신 Run 디렉터리 이름. */
function latestRun(p, taskId) {
  return readdirSync(join(p.root, '.loop-local/runs'))
    .filter((d) => d.startsWith('RUN-') && d.includes(`-${taskId}`))
    .sort()
    .pop();
}
