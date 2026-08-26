// context-builder — Worker Run에 들어갈 Context를 구성하고 Run snapshot을 만든다.
//
// 포함: KERNEL · Role Skill · 배정된 Task · Acceptance Criteria · Failure Memo
// 제외: DESIGN.md · 다른 Task · 무관한 Evidence · 이전 세션 기록 · Runtime 소스 · 저장소 전체
//
// Failure Memo는 Runtime이 증류한 lesson만 담는다. 이전 Attempt의 stdout · Worker 요약 ·
// Gate 로그 전문 · Verifier transcript · 대화 기록은 절대 들어가지 않는다.
//
// KERNEL이 커지면 모든 Run의 고정비가 커진다. 여기에 내용을 더하기 전에 그 비용을 먼저 생각한다.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { ROOT, LOCAL_DIR, KERNEL_PATH, SKILLS_DIR } from './task-store.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => relative(ROOT, p).split('\\').join('/');

function section(title, body) {
  return `--- ${title} ---\n${body.trim()}\n`;
}

/** AC 하나를 판정 방법까지 그대로 보존해서 렌더링한다. Context의 다른 곳에서 반복하지 않는다. */
function renderCriterion(c) {
  const lines = [c.id, `Description: ${c.description}`, `Verification: ${c.verification.type}`];
  if (c.verification.type === 'gate') {
    lines.push(`Ref: ${c.verification.ref}`);
  } else if (c.verification.instruction) {
    lines.push(`Instruction: ${c.verification.instruction.trim()}`);
  }
  return lines.join('\n');
}

/** @returns {{ context: string, sources: {role: string, kernel: string, skill: string, task: string} }} */
/** Runtime이 만든 Failure Memo 한 건을 Worker가 읽을 형태로 렌더링한다. 유계로 유지한다. */
function renderFailureMemo(m) {
  const lines = [
    `Attempt ${m.attempt}`,
    `Stage: ${m.stage}`,
    `Failure: ${m.failure_class}`,
    '',
    'Lesson:',
    m.lesson,
  ];
  if (m.failed_gates?.length > 0) {
    lines.push('', 'Failed gates:');
    for (const g of m.failed_gates) {
      lines.push(`  ${g.name}: ${g.status}${g.exit_code === null || g.exit_code === undefined ? '' : ` (exit ${g.exit_code})`}`);
      if (g.stderr_excerpt) {
        lines.push('    stderr (bounded excerpt):');
        for (const l of g.stderr_excerpt.split('\n')) lines.push(`      ${l}`);
      }
    }
  }
  if (m.failed_criteria?.length > 0) {
    lines.push('', 'Failed acceptance criteria:');
    for (const c of m.failed_criteria) lines.push(`  ${c.id}: ${c.reason}`);
  }
  if (m.recovery_hint) lines.push('', 'Recovery Hint:', m.recovery_hint);
  return lines.join('\n');
}

/**
 * @param {object} task
 * @param {{ failureMemos?: object[] }} [opts] Runtime이 lineage에서 뽑아 준 증류된 Failure Memo
 */
export function buildContext(task, { failureMemos = [] } = {}) {
  const role = task.data.execution.role;
  const skillPath = join(SKILLS_DIR, `${role}.md`);
  if (!existsSync(skillPath)) throw new Error(`${task.id}: missing role skill ${rel(skillPath)}`);

  const kernel = readFileSync(KERNEL_PATH, 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  const d = task.data;

  const taskLines = [
    `id: ${d.id}`,
    `status: ${d.status}`,
    `role: ${role}`,
    `request: ${d.request}`,
    '',
    'stop_condition:',
    `  gates: ${d.stop_condition.gates.length ? d.stop_condition.gates.join(', ') : '(none enabled)'}`,
    `  requires_verifier: ${d.stop_condition.requires_verifier}`,
    `  max_consecutive_failures: ${d.stop_condition.max_consecutive_failures}`,
  ];
  if (d.evidence.length > 0) {
    taskLines.push('', 'existing evidence (paths only):');
    for (const e of d.evidence) taskLines.push(`  - ${e.kind}: ${e.path}`);
  }

  const ac = d.acceptance_criteria.length === 0
    ? '(none defined — 이 Task는 판정 가능한 완료 조건이 없다. 임의로 만들지 말고 blocked로 반환한다.)'
    : d.acceptance_criteria.map(renderCriterion).join('\n\n');

  // Runtime이 lineage에서 만든 memo가 먼저, Task 파일에 사람이 적어 둔 memo가 그 다음이다.
  const parts = failureMemos.map(renderFailureMemo);
  if (d.failure_memo.length > 0) {
    parts.push(d.failure_memo
      .map((m) => `Attempt ${m.attempt}\nStage: ${m.stage}\nFailure: ${m.error}\n\nLesson:\n${m.lesson}`)
      .join('\n\n'));
  }
  const memo = parts.length === 0 ? '(none — 첫 시도다.)' : parts.join('\n\n----\n\n');

  const context = [
    section('KERNEL', kernel),
    section('ROLE', skill),
    section('TASK', taskLines.join('\n')),
    section('ACCEPTANCE CRITERIA', ac),
    section('FAILURE MEMO', memo),
  ].join('\n');

  return { context, sources: { role, kernel: KERNEL_PATH, skill: skillPath, task: task.file } };
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Run snapshot을 .loop-local/runs/ 아래에 만든다. Worker를 실행하지는 않는다.
 * @param {object} task
 * @param {{ now?: Date, attempt?: number, lineage?: object|null, failureMemos?: object[] }} [opts]
 */
export function writeSnapshot(task, opts = {}) {
  // 이전 시그니처(writeSnapshot(task, date))도 계속 받는다.
  const o = opts instanceof Date ? { now: opts } : opts;
  const now = o.now ?? new Date();
  const attempt = o.attempt ?? 1;
  const lineage = o.lineage ?? null;
  const { context, sources } = buildContext(task, { failureMemos: o.failureMemos ?? [] });
  // run_id는 초 단위 timestamp라 같은 초에 두 번 실행하면 겹친다. 겹치면 순번을 붙인다.
  const base = `RUN-${stamp(now)}-${task.id}`;
  let runId = base;
  for (let n = 2; existsSync(join(LOCAL_DIR, 'runs', runId)); n += 1) {
    if (n > 99) throw new Error(`cannot allocate a run id for ${base}`);
    runId = `${base}-${n}`;
  }
  const runDir = join(LOCAL_DIR, 'runs', runId);
  mkdirSync(runDir, { recursive: true });

  const contextPath = join(runDir, 'context.md');
  writeFileSync(contextPath, context, 'utf8');

  const manifest = {
    run_id: runId,
    task_id: task.id,
    role: sources.role,
    attempt,
    // 어디서 온 Attempt인가. Runtime Run ID만 쓴다 — provider session id는 lineage가 아니다.
    lineage,
    created_at: now.toISOString(),
    context_file: 'context.md',
    context_sha256: sha256(context),
    sources: [
      { kind: 'kernel', path: rel(sources.kernel), sha256: sha256(readFileSync(sources.kernel)) },
      { kind: 'role_skill', path: rel(sources.skill), sha256: sha256(readFileSync(sources.skill)) },
      { kind: 'task', path: rel(sources.task), sha256: sha256(readFileSync(sources.task)) },
    ],
    worker: null, // Worker 실행은 아직 구현되지 않았다.
  };
  const manifestPath = join(runDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // snapshot은 불변이어야 한다. 파일시스템이 허용하면 read-only로 잠근다.
  for (const p of [contextPath, manifestPath]) {
    try { chmodSync(p, 0o444); } catch { /* filesystem이 지원하지 않으면 무시 */ }
  }

  return { runId, runDir, manifest };
}
