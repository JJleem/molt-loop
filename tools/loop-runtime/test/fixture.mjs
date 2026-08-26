// test/fixture — 격리된 임시 프로젝트에서 Runtime을 돌리기 위한 발판.
//
// Runtime은 모듈 위치에서 ROOT를 유도한다(task-store.mjs). 그래서 테스트는
// tools/ 와 .loop/ 를 임시 디렉터리로 통째로 복사한 뒤 **그쪽 loopctl**을 실행한다.
// 실제 프로젝트의 .loop/tasks/ 는 절대 건드리지 않는다.
//
// 여기서 provider를 부르지 않는다. adapter는 언제나 mock이다.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * 임시 프로젝트를 만든다. git 저장소여야 한다 — subject fingerprint가 git을 요구한다.
 * @param {{ tasks?: Record<string,string>, gates?: string, limits?: string }} [opts]
 */
export function makeProject(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loop-test-'));

  cpSync(join(SOURCE_ROOT, 'tools'), join(root, 'tools'), { recursive: true });
  mkdirSync(join(root, '.loop', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.loop', 'evidence'), { recursive: true });
  mkdirSync(join(root, '.loop', 'policies'), { recursive: true });
  mkdirSync(join(root, '.loop', 'skills'), { recursive: true });
  for (const d of ['runs', 'leases', 'staging', 'plans']) {
    mkdirSync(join(root, '.loop-local', d), { recursive: true });
  }
  for (const f of ['KERNEL.md', 'DESIGN.md']) {
    cpSync(join(SOURCE_ROOT, '.loop', f), join(root, '.loop', f));
  }
  for (const f of readdirSync(join(SOURCE_ROOT, '.loop', 'skills'))) {
    cpSync(join(SOURCE_ROOT, '.loop', 'skills', f), join(root, '.loop', 'skills', f));
  }

  writeFileSync(join(root, '.loop', 'project.yaml'), opts.projectYaml ?? defaultProjectYaml(opts.gates), 'utf8');
  writeFileSync(join(root, '.loop', 'policies', 'limits.yaml'), opts.limits ?? defaultLimits(), 'utf8');
  writeFileSync(join(root, '.gitignore'), '/.loop-local/\n', 'utf8');

  for (const [name, body] of Object.entries(opts.tasks ?? {})) {
    writeFileSync(join(root, '.loop', 'tasks', `${name}.yaml`), body, 'utf8');
  }

  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'loop test'], root);
  git(['add', '-A'], root);
  git(['commit', '-qm', 'fixture'], root);

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    /** loopctl을 하위 프로세스로 실행한다. 실제 CLI 경로를 그대로 쓴다. */
    run(args, env = {}) {
      const r = spawnSyncCapture(process.execPath, [join(root, 'tools', 'loop-runtime', 'loopctl.mjs'), ...args], root, env);
      return r;
    },
    taskPath: (id) => join(root, '.loop', 'tasks', `${id}.yaml`),
    taskText: (id) => readFileSync(join(root, '.loop', 'tasks', `${id}.yaml`), 'utf8'),
    taskFiles: () => readdirSync(join(root, '.loop', 'tasks')).sort(),
    planDir: (planId) => join(root, '.loop-local', 'plans', planId),
    planJson(planId, file) {
      const p = join(root, '.loop-local', 'plans', planId, file);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    },
    planContext: (planId) => readFileSync(join(root, '.loop-local', 'plans', planId, 'context.md'), 'utf8'),
    plans: () => readdirSync(join(root, '.loop-local', 'plans')).filter((f) => f.startsWith('PLAN-')).sort(),
    write: (relPath, body) => {
      mkdirSync(dirname(join(root, relPath)), { recursive: true });
      writeFileSync(join(root, relPath), body, 'utf8');
    },
    commitAll(message = 'change') {
      git(['add', '-A'], root);
      git(['commit', '-qm', message], root);
    },
  };
}

function spawnSyncCapture(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function defaultProjectYaml(gates) {
  return `project:
  name: loop-test
  language: typescript
  package_manager: npm
  vcs: git

runtime:
  max_parallel_workers: 1
  worker_adapter: mock
  worker_timeout_seconds: 60
  worker_model: null
  gate_timeout_seconds: 30
  verifier_adapter: mock
  verifier_timeout_seconds: 60
  verifier_model: null
  planner_adapter: mock
  planner_timeout_seconds: 60
  planner_model: null
  kernel: .loop/KERNEL.md
  skills_dir: .loop/skills
  tasks_dir: .loop/tasks
  evidence_dir: .loop/evidence
  policies_dir: .loop/policies
  local_dir: .loop-local

gates:
${gates ?? `  build:
    enabled: true
    command: "node -e \\"process.exit(0)\\""
  lint:
    enabled: false
    command: null
    reason: "not configured in the fixture"`}

task_states:
  - TODO
  - IN_PROGRESS
  - REVIEW
  - DONE
  - BLOCKED
  - DROPPED

worker_requestable_transitions:
  - REVIEW
  - BLOCKED
`;
}

function defaultLimits() {
  return `stop:
  max_attempts: 3
  max_consecutive_failures: 2

escalation:
  retry_max: 1
  hint_retry_max: 1
  then: needs-human

planning:
  max_tasks_per_plan: 3
`;
}

/** 유효한 Task 파일 한 장. depends_on 은 선택. */
export function taskYaml(id, { status = 'TODO', dependsOn = [], request = 'do the thing' } = {}) {
  return `id: ${id}
status: ${status}

request: |-
  ${request}

execution:
  role: impl
${dependsOn.length > 0 ? `\ndepends_on:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}\n` : ''}
stop_condition:
  gates: []
  requires_verifier: true
  max_consecutive_failures: 2

acceptance_criteria:
  - id: AC1
    description: |-
      the thing is done
    verification:
      type: verifier

evidence: []

failure_memo: []
`;
}

/** 유효한 PROPOSED Planner Result. 개별 필드를 덮어써서 실패 케이스를 만든다. */
export function plannerResult(overrides = {}) {
  return JSON.stringify({
    plan_id: '__PLAN__',
    result: 'PROPOSED',
    goal_summary: 'Implement the goal.',
    assumptions: ['conversion runs locally'],
    risks: ['large assets may need later performance work'],
    human_questions: [],
    tasks: [proposal('P1'), { ...proposal('P2'), depends_on: ['P1'] }],
    ...overrides,
  });
}

export function proposal(id, overrides = {}) {
  return {
    proposal_id: id,
    title: `Task ${id}`,
    request: `Implement part ${id} of the goal.`,
    execution: { role: 'impl' },
    depends_on: [],
    stop_condition: { gates: [], requires_verifier: true, max_consecutive_failures: 2 },
    acceptance_criteria: [
      { id: 'AC1', description: `Part ${id} is implemented.`, verification: { type: 'verifier' } },
    ],
    ...overrides,
  };
}
