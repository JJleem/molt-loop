// planner/context-builder — Planner Snapshot 구성.
//
// Worker Context도 Verifier Context도 재사용하지 않는다. 처음부터 다시 만든다.
// Planner가 보는 것은 **Goal과 Runtime이 확인한 사실**뿐이다.
//
// 포함: Planner Contract · Goal · Project Facts · Available Roles · Available Gates ·
//       Task Contract · Existing Task Summary · Planning Limits · Runtime Facts
// 제외: DESIGN.md · KERNEL · Worker narrative/stdout · Verifier narrative ·
//       Failure Memo · Run 이력 · Gate 로그 · 이전 세션 기록 · 이전 Plan 대화

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, SKILLS_DIR, isExample, dependsOn } from '../task-store.mjs';
import { loadGateConfig } from '../gate/resolver.mjs';
import { VERIFICATION_TYPES } from '../task-store.mjs';
import { createPlanDir, writeJson, relFromRoot } from './store.mjs';

export const PLANNER_CONTRACT_PATH = join(SKILLS_DIR, 'planner.md');
export const ALLOWED_SECTIONS = [
  'PLANNER CONTRACT', 'GOAL', 'PROJECT FACTS', 'AVAILABLE ROLES', 'AVAILABLE GATES',
  'TASK CONTRACT', 'EXISTING TASK SUMMARY', 'PLANNING LIMITS', 'RUNTIME FACTS',
];
// Planner context에 절대 나타나면 안 되는 것들. 테스트가 이 목록을 그대로 검사한다.
export const FORBIDDEN_SECTIONS = [
  'KERNEL', 'DESIGN', 'WORKER SUMMARY', 'WORKER NARRATIVE', 'WORKER STDOUT',
  'FAILURE MEMO', 'VERIFIER', 'CANONICAL DIFF', 'GATE RESULTS', 'EVIDENCE',
];
export const EXCLUDED = [
  'DESIGN.md', 'KERNEL.md', 'worker narrative', 'worker stdout/stderr',
  'verifier narrative', 'failure memo history', 'run history', 'gate logs',
  'execution transcripts', 'previous planner conversations', 'previous session history',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const section = (title, body) => `--- ${title} ---\n${String(body).trim()}\n`;

function renderProjectFacts(config) {
  const p = config.project ?? {};
  return [
    `project root: ${ROOT.split('\\').join('/')}`,
    `project name: ${p.name ?? '(unnamed)'}`,
    `language: ${p.language ?? '(unspecified)'}`,
    `package manager: ${p.package_manager ?? '(unspecified)'}`,
    `vcs: ${p.vcs ?? '(unspecified)'}`,
    '',
    'You may read the repository with Read · Grep · Glob to check what actually exists.',
    'Do not assume a file or command exists because the project config mentions a stack.',
  ].join('\n');
}

function renderRoles(roles) {
  if (roles.length === 0) return '(no execution role is installed — a plan cannot propose executable tasks)';
  const lines = ['These are the only values allowed in execution.role:'];
  for (const r of roles) lines.push(`  ${r}    (.loop/skills/${r}.md)`);
  lines.push('', 'Any other role name invalidates the whole plan.');
  return lines.join('\n');
}

function renderGates(gateConfig, defaultTimeout) {
  const lines = [];
  if (gateConfig.names.length === 0) {
    lines.push('(no gate is configured)');
  }
  for (const name of gateConfig.names) {
    const g = gateConfig.gates[name];
    lines.push(
      `${name}: ${g.enabled ? 'ENABLED' : 'DISABLED'}` +
      `  timeout=${g.timeout_seconds ?? defaultTimeout}s` +
      (g.enabled ? `  command=${g.command}` : `  reason=${g.reason ?? '(none given)'}`)
    );
  }
  const enabled = gateConfig.names.filter((n) => gateConfig.gates[n].enabled);
  lines.push('');
  lines.push(enabled.length === 0
    ? 'No gate is currently runnable. Do not use verification.type: gate in this plan.'
    : `Only these may appear in stop_condition.gates or verification.ref: ${enabled.join(', ')}.`);
  lines.push('Gate commands are runtime-owned. A plan cannot define, change, or enable a gate.');
  return lines.join('\n');
}

function renderTaskContract() {
  return [
    'Every proposed task is materialized into this shape by the runtime:',
    '',
    'proposal_id            P1 · P2 · P3   (plan-local only; the runtime allocates the real task id)',
    'title                  short human label',
    'request                what the worker must do, in one self-contained paragraph',
    'execution.role         one of AVAILABLE ROLES',
    'depends_on             array of proposal ids in this plan (use [] when there is none)',
    'stop_condition.gates                    array of enabled gate names (use [] when none apply)',
    'stop_condition.requires_verifier        boolean',
    'stop_condition.max_consecutive_failures integer >= 1',
    'acceptance_criteria[]  id · description · verification',
    '',
    `verification.type is one of: ${VERIFICATION_TYPES.join(' | ')}`,
    '  gate      -> requires "ref": an ENABLED gate name. Judged deterministically. No "instruction".',
    '  verifier  -> optional "instruction". Judged by an independent read-only verifier. No "ref".',
    '',
    'Fields that do not exist here cannot be proposed: no status, no id, no priority,',
    'no budget, no retry limits, no adapter, no model, no gate commands, no approval.',
  ].join('\n');
}

function renderExistingTasks(tasks) {
  const rows = tasks.filter((t) => !isExample(t));
  if (rows.length === 0) return '(no task exists yet)';
  const lines = ['Existing tasks. Do not duplicate, modify, or replace them — they are runtime state.', ''];
  for (const t of rows) {
    if (!t.data) { lines.push(`${t.id} | INVALID`); continue; }
    const req = t.data.request.length > 70 ? `${t.data.request.slice(0, 67)}...` : t.data.request;
    const deps = dependsOn(t);
    lines.push(`${t.id} | ${t.data.status} | ${req}${deps.length ? `  (depends on: ${deps.join(', ')})` : ''}`);
  }
  return lines.join('\n');
}

function renderPlanningLimits(config) {
  return [
    `max tasks per plan: ${config.limits.max_tasks_per_plan}`,
    `planner timeout: ${config.runtime.planner_timeout_seconds}s`,
    '',
    'Prefer the smallest set of tasks that forms a clear executable plan.',
    'One task = one coherent responsibility, independently executable and independently judgeable.',
    'Exceeding the maximum fails validation. The plan is not truncated for you.',
  ].join('\n');
}

function renderRuntimeFacts({ planId, subject, adapter, roles, config }) {
  return [
    `plan_id: ${planId}`,
    `planner adapter: ${adapter}`,
    `repository subject type: ${subject.type}`,
    `repository subject sha256: ${subject.sha256 ?? '(unavailable)'}`,
    `repository HEAD: ${subject.head ?? '(no commit)'}`,
    `uncommitted/untracked entries: ${subject.dirty_entry_count}`,
    '',
    'The runtime re-checks this fingerprint after planning. If the repository changed',
    'during planning, the plan is a policy violation and cannot be approved.',
    '',
    'This plan creates no task. Task files are written only by `loopctl plan-approve`,',
    'and only after a human approves. Approval performs no AI call.',
    '',
    `installed execution roles: ${roles.join(', ') || 'none'}`,
    `task states: ${(config.project?.task_states ?? []).join(' · ') || 'TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED · DROPPED'}`,
  ].join('\n');
}

/**
 * Planner Snapshot을 .loop-local/plans/PLAN-.../ 에 만든다. AI를 실행하지는 않는다.
 * @returns {{ dir, context, contextPath, manifest }}
 */
export function writePlannerSnapshot({ planId, goal, goalSource, config, tasks, roles, subject, adapter, now = new Date() }) {
  if (!existsSync(PLANNER_CONTRACT_PATH)) {
    throw new Error(`missing planner contract ${relFromRoot(PLANNER_CONTRACT_PATH)}`);
  }
  const dir = createPlanDir(planId);
  const gateConfig = loadGateConfig(config);
  const contract = readFileSync(PLANNER_CONTRACT_PATH, 'utf8');

  const context = [
    section('PLANNER CONTRACT', contract),
    section('GOAL', goal),
    section('PROJECT FACTS', renderProjectFacts(config)),
    section('AVAILABLE ROLES', renderRoles(roles)),
    section('AVAILABLE GATES', renderGates(gateConfig, config.runtime.gate_timeout_seconds)),
    section('TASK CONTRACT', renderTaskContract()),
    section('EXISTING TASK SUMMARY', renderExistingTasks(tasks)),
    section('PLANNING LIMITS', renderPlanningLimits(config)),
    section('RUNTIME FACTS', renderRuntimeFacts({ planId, subject, adapter, roles, config })),
  ].join('\n');

  const contextPath = join(dir, 'context.md');
  writeFileSync(contextPath, context, 'utf8');

  const manifest = {
    plan_id: planId,
    role: 'planner',
    created_at: now.toISOString(),
    goal,
    goal_source: goalSource,
    context_file: 'context.md',
    context_sha256: sha256(context),
    sections: ALLOWED_SECTIONS,
    repository_subject: subject,
    available_roles: roles,
    available_gates: gateConfig.names.map((n) => ({ name: n, enabled: gateConfig.gates[n].enabled })),
    existing_task_ids: tasks.filter((t) => !isExample(t)).map((t) => t.id),
    max_tasks_per_plan: config.limits.max_tasks_per_plan,
    sources: [
      { kind: 'planner_contract', path: relFromRoot(PLANNER_CONTRACT_PATH), sha256: sha256(readFileSync(PLANNER_CONTRACT_PATH)) },
    ],
    excluded: EXCLUDED,
  };
  const manifestPath = writeJson(dir, 'manifest.json', manifest);

  for (const p of [contextPath, manifestPath]) {
    try { chmodSync(p, 0o444); } catch { /* filesystem이 지원하지 않으면 무시 */ }
  }
  return { dir, context, contextPath, manifest };
}
