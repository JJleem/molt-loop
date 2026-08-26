// verifier/context-builder — Verifier Snapshot 구성.
//
// 독립성은 Session 분리가 아니라 **Input 분리**에서 나온다.
// 그래서 이 파일은 Worker의 context.md를 재사용하지 않고 처음부터 다시 만든다.
//
// 포함: Verifier Contract · Task Contract · Acceptance Criteria · Canonical Diff ·
//       Gate Results · Evidence · Runtime Facts
// 제외: Worker summary · self-evaluation · progress narrative · stdout · 대화 기록 ·
//       requested_transition · DESIGN.md · 다른 Task
//
// 아래 ALLOWED_SECTIONS 밖의 섹션은 만들지 않는다. 새 섹션을 추가하기 전에
// "이것이 Worker의 주장인가, Runtime/Gate의 사실인가"를 먼저 답해야 한다.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { ROOT, SKILLS_DIR } from '../task-store.mjs';
import { buildCanonicalDiff } from './canonical-diff.mjs';
import { verifierCriterionIds } from './result.mjs';

export const VERIFICATION_DIR = 'verification';
export const ALLOWED_SECTIONS = [
  'VERIFIER CONTRACT', 'TASK', 'ACCEPTANCE CRITERIA', 'CANONICAL DIFF',
  'GATE RESULTS', 'EVIDENCE', 'RUNTIME FACTS',
];
// Verifier context에 절대 나타나면 안 되는 것들. 테스트가 이 목록을 그대로 검사한다.
export const FORBIDDEN_SECTIONS = ['WORKER SUMMARY', 'WORKER NARRATIVE', 'WORKER STDOUT', 'KERNEL', 'ROLE'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const section = (title, body) => `--- ${title} ---\n${String(body).trim()}\n`;

/** Gate가 판정한 AC는 사실로 제시하고, Verifier가 판정할 AC만 판정을 요구한다. */
function renderCriteria(task, gateReport) {
  const gateStatus = new Map(
    (gateReport?.acceptance_criteria ?? []).map((a) => [a.id, a.status])
  );
  return task.data.acceptance_criteria.map((ac) => {
    const lines = [`${ac.id}  [${ac.verification.type}]`, `Description: ${ac.description}`];
    if (ac.verification.type === 'gate') {
      lines.push(`Gate: ${ac.verification.ref}`);
      lines.push(`Deterministic status: ${gateStatus.get(ac.id) ?? 'UNKNOWN'}  (authoritative — do not re-judge)`);
    } else {
      if (ac.verification.instruction) lines.push(`Instruction: ${ac.verification.instruction.trim()}`);
      lines.push('You must judge this criterion and return an entry for it.');
    }
    return lines.join('\n');
  }).join('\n\n');
}

function renderGateResults(gateReport) {
  const lines = [
    `Overall gate result: ${gateReport.result}`,
    `Required gates: ${gateReport.required_gates.join(', ') || '(none required by this task)'}`,
    `Gate report attempt: ${gateReport.attempt}`,
    '',
  ];
  for (const g of gateReport.gates) {
    lines.push(
      `${g.name}: ${g.status}  exit=${g.exit_code ?? 'none'}  timed_out=${g.timed_out}  ${g.duration_ms}ms`,
      `  command: ${g.command}`,
      `  stdout: ${g.stdout_bytes} bytes  sha256=${g.stdout_sha256 ?? 'n/a'}`,
      `  stderr: ${g.stderr_bytes} bytes  sha256=${g.stderr_sha256 ?? 'n/a'}`,
    );
    if (g.error) lines.push(`  error: ${g.error}`);
  }
  if (gateReport.gates.length === 0) lines.push('(this task declares no deterministic gate)');
  return lines.join('\n');
}

/**
 * Evidence는 출처에 따라 신뢰도가 다르다. 그 차이를 문서 안에서 지운 채로 넘기지 않는다.
 * Gate artifact = Runtime이 만든 정본. Worker evidence = 검증되지 않은 주장.
 */
function renderEvidence({ runId, gateReport, workerResult, runDir }) {
  const lines = ['AUTHORITATIVE RUNTIME EVIDENCE (produced by the runtime itself):'];
  if (gateReport.gates.length === 0) {
    lines.push('  (no gate artifacts — this task requires no deterministic gate)');
  }
  for (const g of gateReport.gates) {
    lines.push(`  [${g.status}] ${g.name}`);
    lines.push(`    ${rel(join(runDir, g.stdout_file))}  sha256=${g.stdout_sha256 ?? 'n/a'}`);
    lines.push(`    ${rel(join(runDir, g.stderr_file))}  sha256=${g.stderr_sha256 ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('WORKER-SUBMITTED EVIDENCE REFERENCES (UNVERIFIED CLAIMS — a path existing is not proof):');
  const claims = workerResult?.evidence ?? [];
  if (claims.length === 0) {
    lines.push('  (none submitted)');
  } else {
    for (const e of claims) {
      const abs = join(ROOT, e.path);
      const present = existsSync(abs);
      lines.push(`  ${e.kind}: ${e.path}  [runtime check: ${present ? 'file exists' : 'FILE DOES NOT EXIST'}]`);
    }
  }
  lines.push('');
  lines.push('You may read the files above. They are read-only. Judge what they actually show.');
  return lines.join('\n');
}

/** 결정론적 Runtime 사실만. Worker의 자기평가·요약·요청 전이는 포함하지 않는다. */
function renderRuntimeFacts({ runId, task, envelope, subject, diff, gateReport }) {
  const lines = [
    `run_id: ${runId}`,
    `task_id: ${task.id}`,
    `task status (persisted): ${task.data.status}`,
    `worker adapter: ${envelope.adapter}${envelope.model ? `  model: ${envelope.model}` : ''}`,
    `worker attempt: ${envelope.attempt}`,
    `worker process exit code: ${envelope.process.exit_code ?? 'none'}  timed_out: ${envelope.process.timed_out}`,
    `worker result structurally valid: ${envelope.worker_result_valid}`,
    `worker policy violation: ${envelope.policy_violation}`,
    '',
    `verification subject type: ${subject.type}`,
    `verification subject sha256: ${subject.sha256}`,
    `repository HEAD: ${subject.head ?? '(no commit)'}`,
    '',
    `runtime-observed changed files (${envelope.observed_changes.count}):`,
  ];
  for (const f of envelope.observed_changes.files) lines.push(`  ${f}`);
  if (envelope.observed_changes.count === 0) lines.push('  (none — the runtime observed no new file changes for this run)');
  lines.push('');
  lines.push(`gate result: ${gateReport.result}`);
  lines.push(`canonical diff files: ${diff.files.length}${diff.truncated ? ' (some content omitted — see notes)' : ''}`);
  for (const n of diff.notes) lines.push(`  note: ${n}`);

  // Runtime이 이 Run에서 **실제로 목격한 실행**. 여기 없는 실행은 일어나지 않은 것으로 다룬다.
  // 산출물이 그런 실행을 했다고 서술하더라도 그것은 서술일 뿐 증거가 아니다.
  lines.push('');
  lines.push('WITNESSED EXECUTION (the runtime ran exactly these commands for this run):');
  if (gateReport.gates.length === 0) {
    lines.push('  (none — this task requires no deterministic gate)');
  }
  for (const g of gateReport.gates) {
    lines.push(`  ${g.command}   -> ${g.status} (exit ${g.exit_code ?? 'none'})`);
  }
  lines.push('');
  lines.push('NOT WITNESSED BY THE RUNTIME for this run:');
  lines.push('  manual operation by a person · a browser session · a dev server · network access ·');
  lines.push('  any external service call · rendering or measuring a real asset.');
  lines.push('  The worker could execute nothing except the runtime self-check entry point,');
  lines.push('  which runs only the gate commands listed above.');
  lines.push('  Any acceptance criterion that needs one of these, and any claim in a changed file');
  lines.push('  that one of these happened, is unsupported by runtime evidence.');
  return lines.join('\n');
}

function renderCanonicalDiff(diff) {
  const lines = ['CHANGED FILE MANIFEST (deterministic, runtime-generated):'];
  if (diff.files.length === 0) {
    lines.push('  (no changed files were observed for this run)');
  }
  for (const f of diff.files) {
    lines.push(
      `  ${f.change.padEnd(18)} ${f.path}` +
      `  size=${f.size ?? 'n/a'} sha256=${f.sha256 ? f.sha256.slice(0, 16) : 'n/a'}` +
      `  [${f.provenance}]${f.binary ? ' binary' : ''}${f.patch_included ? '' : ' (content not inlined)'}`
    );
    if (f.note) lines.push(`      ${f.note}`);
  }
  lines.push('');
  lines.push('UNIFIED PATCH:');
  lines.push(diff.patch.trim() === '' ? '(empty — no textual patch content was inlined)' : diff.patch);
  return lines.join('\n');
}

/**
 * Verifier Snapshot을 .loop-local/runs/RUN-.../verification/ 에 만든다.
 * AI를 실행하지는 않는다.
 */
export function writeVerifierSnapshot({ task, run, envelope, workerResult, gateReport, subject, now = new Date() }) {
  const skillPath = join(SKILLS_DIR, 'verifier.md');
  if (!existsSync(skillPath)) throw new Error(`missing verifier role skill ${rel(skillPath)}`);

  const dir = join(run.runDir, VERIFICATION_DIR);
  mkdirSync(dir, { recursive: true });

  const diff = buildCanonicalDiff({ envelope, workerResult });
  const contract = readFileSync(skillPath, 'utf8');

  const taskLines = [
    `id: ${task.id}`,
    `request: ${task.data.request}`,
    '',
    'stop_condition:',
    `  gates: ${task.data.stop_condition.gates.join(', ') || '(none)'}`,
    `  requires_verifier: ${task.data.stop_condition.requires_verifier}`,
  ];

  const context = [
    section('VERIFIER CONTRACT', contract),
    section('TASK', taskLines.join('\n')),
    section('ACCEPTANCE CRITERIA', renderCriteria(task, gateReport)),
    section('CANONICAL DIFF', renderCanonicalDiff(diff)),
    section('GATE RESULTS', renderGateResults(gateReport)),
    section('EVIDENCE', renderEvidence({ runId: run.runId, gateReport, workerResult, runDir: run.runDir })),
    section('RUNTIME FACTS', renderRuntimeFacts({ runId: run.runId, task, envelope, subject, diff, gateReport })),
  ].join('\n');

  const patchPath = join(dir, 'canonical-diff.patch');
  const subjectPath = join(dir, 'subject.json');
  const contextPath = join(dir, 'context.md');

  writeFileSync(patchPath, diff.patch, 'utf8');
  writeFileSync(subjectPath, `${JSON.stringify({
    verification_subject: subject,
    canonical_diff: {
      file_count: diff.files.length,
      truncated: diff.truncated,
      notes: diff.notes,
      files: diff.files,
    },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(contextPath, context, 'utf8');

  const manifest = {
    run_id: run.runId,
    task_id: task.id,
    role: 'verifier',
    created_at: now.toISOString(),
    context_file: 'context.md',
    context_sha256: sha256(context),
    sections: ALLOWED_SECTIONS,
    verification_subject: subject,
    verifier_criteria: verifierCriterionIds(task),
    sources: [
      { kind: 'verifier_contract', path: rel(skillPath), sha256: sha256(readFileSync(skillPath)) },
      { kind: 'task', path: rel(task.file), sha256: sha256(readFileSync(task.file)) },
      { kind: 'gate_report', path: rel(join(run.runDir, 'gate-report.json')), sha256: sha256(readFileSync(join(run.runDir, 'gate-report.json'))) },
      { kind: 'canonical_diff', path: `${VERIFICATION_DIR}/canonical-diff.patch`, sha256: sha256(diff.patch) },
    ],
    excluded: [
      'worker summary', 'worker self-evaluation', 'worker progress narrative',
      'worker stdout/stderr', 'worker requested_transition', 'previous session history',
      'DESIGN.md', 'unrelated tasks',
    ],
  };
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  for (const p of [contextPath, manifestPath, subjectPath, patchPath]) {
    try { chmodSync(p, 0o444); } catch { /* filesystem이 지원하지 않으면 무시 */ }
  }

  return { dir, context, contextPath, manifest, diff };
}

