// recovery/triage — 정지 지점에서 사람 대신 **먼저** 보는 판단 역할.
//
// Runtime은 지금까지 두 층뿐이었다: 결정론적 자동 처리와 사람. 판단이 조금이라도 필요하면
// 전부 사람에게 갔다(OBS-003: 빌드와 무관한 파일 하나 때문에 $2.75짜리 Run이 사람을 기다렸다).
// Triage는 그 사이의 층이다. Planner · Worker · Verifier와 같은 격리된 읽기 전용 호출이며,
//
//   - Runtime이 준 **메뉴에서만** 고른다. 메뉴는 사람이 CLI로 할 수 있는 복구 행동과 같다.
//   - **DONE 전이는 메뉴에 없다.** 어떤 경우에도 완료를 선언하지 못한다.
//   - 모든 결정에 Verifier와 같은 evidence_basis / evidence_refs가 필요하다. 근거 경로는 Runtime이
//     존재를 확인한다. 근거가 없으면 ESCALATE(사람)만 가능하다.
//   - 결과는 구조화 출력으로만 받는다. 산문은 결정이 아니다.
//   - 호출 수 · 재시도 수 · replan 수는 limits.yaml의 triage 절이 잡는다. 판단 예산은 결정론적
//     재시도 사다리와 별개로 센다.
//
// Triage의 결정은 Evidence가 아니다. "다음 행동의 선택"일 뿐이고, 완료는 여전히 Gate와 Verifier가 정한다.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ROOT, LOOP_DIR, LOCAL_DIR, SKILLS_DIR } from '../task-store.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { assertBudget } from '../usage-ledger.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { fingerprintDir, compareFingerprints } from '../worker/runner.mjs';
import { contextMetrics, outputMetrics, normalizeTokens } from '../worker/telemetry.mjs';
import { VERIFIER_TOOLS, VERIFIER_DENY, verificationDirFor } from '../verifier/runner.mjs';
import { readVerificationReport } from '../verifier/report.mjs';
import { readGateReport } from '../gate/report.mjs';
import { listRuns } from '../gate/runner.mjs';
import { readDiagnosis } from './diagnose.mjs';
import { collectMemoChain } from './retry.mjs';
import { boundedExcerpt } from './failure-memo.mjs';
import { assessResume } from './resume.mjs';
import { planDir } from '../planner/store.mjs';

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const freeze = (p) => { try { chmodSync(p, 0o444); } catch { /* filesystem이 지원하지 않으면 무시 */ } };

export const TRIAGE_DECISIONS = ['ESCALATE', 'RERUN_GATES', 'RERUN_VERIFIER', 'RETRY_WITH_LESSON', 'UNBLOCK', 'REPLAN', 'ANSWER'];
export const TRIAGE_EVIDENCE = ['runtime_artifact', 'repository_content', 'gate', 'canonical_diff', 'none'];
export const TRIAGE_DIR = 'triage';
export const CLARIFICATION_DIR = join(LOCAL_DIR, 'triage');
export const TRIAGE_CONTRACT_PATH = join(SKILLS_DIR, 'triage.md');

/** 재시도가 의미 있는 실패 종류. 정책 위반 · 권한 위반 · 환경 오류는 여기 없다. */
export const TRIAGE_RETRYABLE_CLASSES = ['GATE_FAILURE', 'VERIFY_FAILED', 'TIMEOUT', 'SCHEMA_FAILURE', 'PROCESS_CRASH'];

/** Planner 질문 중 Triage가 스펙·저장소만 보고 답해도 되는 분류. 보안 · 비가역 · 제품 갈림길은 사람이다. */
export const QUESTION_CATEGORIES = ['spec', 'implementation', 'security', 'irreversible', 'product', 'other'];
export const ANSWERABLE_CATEGORIES = new Set(['spec', 'implementation']);

const MEANING = {
  ESCALATE: 'Stop and ask a human. Always allowed. Use it whenever the evidence does not clearly support another option.',
  RERUN_GATES: 'Re-run the deterministic gates on the current repository state (and then the verifier). Choose only when the recorded change is unrelated to the product or the gate failure was environmental. Never to "try again" after a real gate FAIL.',
  RERUN_VERIFIER: 'Re-run the independent verifier once more on the same implementation. Choose only when the verifier itself failed (timeout, crash, unusable result), not when it rejected the work.',
  RETRY_WITH_LESSON: 'Run the worker again with one lesson you write (field "lesson", optional "recovery_hint"). Choose only when the recorded failure points to a concrete, fixable cause. The lesson must cite evidence.',
  UNBLOCK: 'Send the blocked task back to TODO with a clarification you write in "lesson". Choose only when the worker\'s blocking question is answered by the spec, the goal, or the repository.',
  REPLAN: 'Drop the remaining tasks of this plan and let the planner re-plan the rest of the goal with the failure context. Bounded per plan. Choose when the task decomposition itself is wrong, not when one attempt failed.',
  ANSWER: 'Answer the planner\'s questions from the product spec / goal / repository ("answers" array, one per question, each with evidence_refs). Choose only when every answer is actually written down somewhere you can cite.',
};

export function triageEnabled(config) {
  return config.limits?.triage?.enabled === true;
}

/** 실제 AI 호출로 내린 결정만 센다. 메뉴가 ESCALATE뿐이라 건너뛴 것은 세지 않는다. */
function decisionsUnder(base) {
  const root = join(base, TRIAGE_DIR);
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name, 'triage-result.json');
    if (!existsSync(p)) continue;
    try {
      const r = JSON.parse(readFileSync(p, 'utf8'));
      if (!r.skipped) out.push({ dir: join(root, name), decision: r.normalized?.decision ?? 'ESCALATE', valid: r.valid === true, kind: r.kind ?? null });
    } catch { out.push({ dir: join(root, name), decision: 'ESCALATE', valid: false, corrupt: true }); }
  }
  return out;
}

export function triageDecisionsForTask(taskId) {
  return listRuns().filter((r) => r.taskId === taskId).flatMap((r) => decisionsUnder(r.runDir));
}

export function triageDecisionsForPlan(planId) {
  return decisionsUnder(planDir(planId));
}

export function triageUsage({ taskId = null, planId = null, config }) {
  const limits = config.limits.triage;
  const task = taskId ? triageDecisionsForTask(taskId) : [];
  const plan = planId ? triageDecisionsForPlan(planId) : [];
  const taskRetries = task.filter((d) => d.decision === 'RETRY_WITH_LESSON' && d.valid).length;
  return {
    decisions: task.length,
    decisionsRemaining: Math.max(0, limits.max_decisions_per_task - task.length),
    retriesRemaining: Math.max(0, limits.max_retries_per_task - taskRetries),
    replans: plan.filter((d) => d.decision === 'REPLAN' && d.valid).length + task.filter((d) => d.decision === 'REPLAN' && d.valid).length,
    answers: plan.filter((d) => d.decision === 'ANSWER' && d.valid).length,
    limits,
  };
}

/**
 * 정지 사유에서 메뉴를 만든다. 결정론적이며 AI를 부르지 않는다.
 * 여기 없는 것은 Triage가 고를 수 없다.
 */
export function triageMenu({ kind, next = null, stop = null, usage, replanCapable = false, questions = [], categories = [] }) {
  const menu = new Set(['ESCALATE']);
  const why = [];
  if (kind === 'questions') {
    const answerable = questions.length > 0 && questions.every((_, i) => ANSWERABLE_CATEGORIES.has(categories[i]));
    if (answerable && usage.answers < usage.limits.max_answers_per_plan) menu.add('ANSWER');
    else why.push(answerable ? 'answer budget exhausted' : 'a question is not in an answerable category');
    return { menu: [...menu], why };
  }
  if (kind === 'goal') {
    if (replanCapable && usage.replans < usage.limits.max_replans_per_plan) menu.add('REPLAN');
    else why.push(replanCapable ? 'replan budget exhausted' : 'replan is only available under start/quick');
    return { menu: [...menu], why };
  }
  // kind === 'task'
  const d = next?.assessment?.diagnosis ?? null;
  const reason = String(next?.reason ?? '');
  if (next?.action === 'STOP_BLOCKED') menu.add('UNBLOCK');
  const subjectMoved = next?.recovery !== undefined || d?.recommended_action === 'RERUN_GATES' || /repository changed after gates|subject moved/.test(reason);
  if (subjectMoved) menu.add('RERUN_GATES');
  if (d?.stage === 'gate' && d.failure_class === 'TIMEOUT') menu.add('RERUN_GATES');
  if (d?.stage === 'verifier' && ['TIMEOUT', 'PROCESS_CRASH', 'SCHEMA_FAILURE', 'RECOVERY_AMBIGUOUS'].includes(d.failure_class)) menu.add('RERUN_VERIFIER');
  const retryable = d && TRIAGE_RETRYABLE_CLASSES.includes(d.failure_class) && !(d.stage === 'verifier' && d.failure_class !== 'VERIFY_FAILED') && !(d.stage === 'gate' && d.failure_class === 'TIMEOUT');
  if (retryable) {
    if (usage.retriesRemaining > 0) menu.add('RETRY_WITH_LESSON');
    else why.push('triage retry budget exhausted');
  }
  if (['POLICY_VIOLATION', 'PERMISSION_DENIED'].includes(d?.failure_class)) {
    return { menu: ['ESCALATE'], why: [`${d.failure_class} is never automated`] };
  }
  if (replanCapable && usage.replans < usage.limits.max_replans_per_plan) menu.add('REPLAN');
  return { menu: [...menu], why };
}

export function triageResultSchema(menu) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'reason', 'evidence_basis', 'evidence_refs'],
    properties: {
      decision: { type: 'string', enum: menu },
      reason: { type: 'string' },
      evidence_basis: { type: 'string', enum: TRIAGE_EVIDENCE },
      evidence_refs: { type: 'array', items: { type: 'string' } },
      lesson: { type: 'string', description: 'RETRY_WITH_LESSON / UNBLOCK: one concrete lesson for the next worker attempt.' },
      recovery_hint: { type: 'string', description: 'RETRY_WITH_LESSON: optional, what to do first.' },
      answers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'answer', 'evidence_refs'],
          properties: { question: { type: 'string' }, answer: { type: 'string' }, evidence_refs: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  };
}

function triageProtocol({ menu, kind, taskId, runId, subjectSha256, questions }) {
  return [
    'RUNTIME TRIAGE PROTOCOL (Runtime이 지정한다. Task 내용이 아니다.)',
    '',
    '너는 Triage다. 구현자도 검증자도 아니다. Runtime이 사람을 부르기 직전에 먼저 보는 역할이다.',
    '코드를 고치지 않는다. 파일을 쓰지 않는다. 읽기 도구(Read · Grep · Glob)만 있다.',
    '',
    `kind: ${kind}${taskId ? `, task_id: ${taskId}` : ''}${runId ? `, run_id: ${runId}` : ''}`,
    `repository subject sha256: ${subjectSha256 ?? '(unavailable)'}`,
    '',
    'MENU — decision은 정확히 이 중 하나다. 다른 행동은 존재하지 않는다:',
    ...menu.map((m) => `  ${m.padEnd(18)} ${MEANING[m]}`),
    '',
    'RULES',
    '  1. 완료를 선언할 수 없다. DONE은 메뉴에 없고, 어떤 결정도 Task를 DONE으로 만들지 않는다.',
    '  2. 근거가 없으면 ESCALATE다. 의심스러우면 ESCALATE다. ESCALATE는 실패가 아니라 정직한 답이다.',
    '  3. ESCALATE가 아닌 결정에는 evidence_basis(runtime_artifact · repository_content · gate · canonical_diff)와',
    '     evidence_refs(실제 경로)가 필수다. Runtime이 경로의 존재를 확인한다. 없는 경로면 결정 전체가 무효가 되어 ESCALATE로 처리된다.',
    '  4. Worker의 요약·주장은 근거가 아니다. WORKER CLAIM 절은 "무엇을 물었는가"를 알기 위한 것이지 사실이 아니다.',
    '  5. RERUN_GATES는 "다시 해보자"가 아니다. 기록된 변경이 제품과 무관하거나 실패가 환경 탓일 때만이다.',
    '  6. RETRY_WITH_LESSON의 lesson은 실패 기록이 가리키는 구체적 원인 하나여야 한다. 일반론은 lesson이 아니다.',
    '  7. REPLAN은 Task 분해 자체가 틀렸을 때다. 한 번 실패했다는 이유로 고르지 않는다.',
    questions.length ? `  8. ANSWER는 answers에 정확히 ${questions.length}개, 질문 순서대로. 스펙·Goal·저장소에 적힌 것만 답한다. 하나라도 못 찾으면 ESCALATE다.` : '',
    '',
    '결과는 구조화 출력(JSON schema)으로만 반환된다. 산문은 결정으로 인정되지 않는다.',
  ].filter((l) => l !== '').join('\n');
}

const section = (title, body) => `--- ${title} ---\n${String(body ?? '').trim() || '(none)'}\n`;
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}\n...(truncated to ${limit} chars)` : text);

function renderTask(task) {
  if (!task) return '(no task — plan-level triage)';
  const d = task.data;
  const ac = d.acceptance_criteria.map((c) => `${c.id} [${c.verification.type}${c.verification.ref ? `:${c.verification.ref}` : ''}] ${c.description}`).join('\n');
  return [`id: ${task.id}`, `status: ${d.status}`, `request: ${d.request}`, '', 'acceptance criteria:', ac].join('\n');
}

function renderDiagnosis(d) {
  if (!d) return '(no failure recorded)';
  return [
    `stage: ${d.stage}`, `failure_class: ${d.failure_class}`, `recommended_action (deterministic): ${d.recommended_action}`,
    `attempt: ${d.attempt}`, `reason: ${d.reason}`,
    d.subject_check ? `subject_check: ${JSON.stringify(d.subject_check)}` : '',
    d.source_artifacts?.length ? `artifacts: ${d.source_artifacts.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function renderGateReport(run) {
  if (!run) return '(no run)';
  const g = readGateReport(run.runDir);
  if (!g || g.corrupt) return g?.corrupt ? '(gate report corrupt)' : '(gates not run)';
  const lines = [`result: ${g.result}`, `subject at gate time: ${g.verification_subject?.sha256 ?? '(unknown)'}`];
  for (const x of g.gates ?? []) {
    lines.push(`${x.name}: ${x.status}${x.exit_code === null || x.exit_code === undefined ? '' : ` (exit ${x.exit_code})`}${x.error ? ` ${x.error}` : ''}`);
    const excerpt = boundedExcerpt(join(run.runDir, 'gates', x.name, 'stderr.log')) ?? boundedExcerpt(join(run.runDir, 'gates', x.name, 'stdout.log'));
    if (excerpt && x.status !== 'PASS') for (const l of excerpt.split('\n')) lines.push(`    ${l}`);
  }
  return lines.join('\n');
}

function renderVerification(run) {
  if (!run) return '(no run)';
  const vr = readVerificationReport(verificationDirFor(run.runDir));
  if (!vr || vr.corrupt) return vr?.corrupt ? '(verification report corrupt)' : '(verifier not run)';
  const lines = [`result: ${vr.result}`, `verifier_result: ${vr.verifier_result ?? 'INVALID'}`, `subject_stable: ${vr.verification_subject_stable}`, `reason: ${vr.verifier_reason ?? vr.reason ?? ''}`];
  for (const c of vr.acceptance_criteria ?? []) lines.push(`${c.id}: ${c.status}${c.evidence_basis ? ` [${c.evidence_basis}]` : ''} ${c.reason ?? ''}`);
  const diff = join(verificationDirFor(run.runDir), 'canonical-diff.patch');
  if (existsSync(diff)) lines.push('', `canonical diff: ${rel(diff)} (read it if the criteria above need it)`);
  return lines.join('\n');
}

function renderSubjectChanges(run, config) {
  if (!run) return '(no run)';
  const g = readGateReport(run.runDir);
  if (!g || g.corrupt) return '(no gate subject to compare with)';
  const r = assessResume(g, config);
  if (!r.diff.known) return 'per-file history unavailable; the runtime cannot list what changed.';
  if (r.diff.changes.length === 0 && !r.diff.head_changed) return 'no file-level change since the gates ran.';
  return [
    r.diff.head_changed ? 'HEAD changed.' : '',
    r.protectedChange ? 'A control-plane path changed (never automated).' : '',
    ...r.diff.changes.map((c) => `${c.kind} ${c.path}`),
  ].filter(Boolean).join('\n');
}

function renderWorkerClaim(run) {
  if (!run) return '(no run)';
  const p = join(run.runDir, 'worker-result.json');
  if (!existsSync(p)) return '(no worker result)';
  try {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    return [`outcome: ${r.outcome}`, `requested_transition: ${r.requested_transition}`, `summary (claim, not evidence): ${clip(String(r.summary ?? ''), 1500)}`, r.blocked_reason ? `blocked_reason (claim): ${clip(String(r.blocked_reason), 1500)}` : '', r.notes ? `notes (claim): ${clip(String(r.notes), 1000)}` : ''].filter(Boolean).join('\n');
  } catch { return '(worker result unreadable)'; }
}

function renderSpec() {
  const p = join(ROOT, 'docs', 'PRODUCT-SPEC.md');
  if (!existsSync(p)) return '(docs/PRODUCT-SPEC.md does not exist)';
  return `path: docs/PRODUCT-SPEC.md\n\n${clip(readFileSync(p, 'utf8'), 12000)}`;
}

function refExists(p, run, planId) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const abs = resolve(ROOT, p);
  if (!abs.startsWith(resolve(ROOT) + sep) && abs !== resolve(ROOT)) return false;
  if (existsSync(abs)) return true;
  if (run && existsSync(join(run.runDir, p))) return true;
  if (planId && existsSync(join(planDir(planId), p))) return true;
  return false;
}

function validateTriageResult(raw, { menu, questions, run, planId }) {
  const errors = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { valid: false, errors: ['structured output is not an object'], result: null };
  const decision = raw.decision;
  if (!menu.includes(decision)) errors.push(`decision "${decision}" is not in the menu (${menu.join(', ')})`);
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) errors.push('reason is required');
  const refs = Array.isArray(raw.evidence_refs) ? raw.evidence_refs : null;
  if (refs === null) errors.push('evidence_refs must be an array');
  if (decision !== 'ESCALATE') {
    if (!TRIAGE_EVIDENCE.includes(raw.evidence_basis) || raw.evidence_basis === 'none') errors.push('a non-ESCALATE decision needs evidence_basis other than none');
    if (refs && refs.length === 0 && decision !== 'RERUN_VERIFIER' && decision !== 'RERUN_GATES') errors.push('a non-ESCALATE decision needs at least one evidence_ref');
    for (const r of refs ?? []) if (!refExists(r, run, planId)) errors.push(`evidence_ref does not exist: ${r}`);
  }
  if (['RETRY_WITH_LESSON', 'UNBLOCK'].includes(decision) && (typeof raw.lesson !== 'string' || !raw.lesson.trim())) errors.push(`${decision} requires a lesson`);
  if (decision === 'ANSWER') {
    const answers = Array.isArray(raw.answers) ? raw.answers : [];
    if (answers.length !== questions.length) errors.push(`ANSWER needs exactly ${questions.length} answers, got ${answers.length}`);
    answers.forEach((a, i) => {
      if (typeof a?.answer !== 'string' || !a.answer.trim()) errors.push(`answers[${i}].answer is required`);
      if (!Array.isArray(a?.evidence_refs) || a.evidence_refs.length === 0) errors.push(`answers[${i}] needs evidence_refs`);
      else for (const r of a.evidence_refs) if (!refExists(r, run, planId)) errors.push(`answers[${i}] evidence_ref does not exist: ${r}`);
    });
  }
  if (errors.length) return { valid: false, errors, result: null };
  return {
    valid: true, errors: [],
    result: {
      decision, reason: raw.reason.trim(), evidence_basis: raw.evidence_basis ?? 'none', evidence_refs: refs ?? [],
      lesson: typeof raw.lesson === 'string' ? raw.lesson.trim() : null,
      recovery_hint: typeof raw.recovery_hint === 'string' ? raw.recovery_hint.trim() : null,
      answers: decision === 'ANSWER' ? raw.answers.map((a, i) => ({ question: questions[i], answer: a.answer.trim(), evidence_refs: a.evidence_refs })) : null,
    },
  };
}

function allocateDir(base) {
  const root = join(base, TRIAGE_DIR);
  mkdirSync(root, { recursive: true });
  let n = 1;
  while (existsSync(join(root, String(n).padStart(2, '0')))) n += 1;
  const dir = join(root, String(n).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Triage 1회. 메뉴가 ESCALATE뿐이면 AI를 부르지 않고 그대로 ESCALATE를 돌려준다(비용 0).
 *
 * @param {{ kind: 'task'|'questions'|'goal', config, task?, run?, next?, stop?, planId?, goal?,
 *           questions?: string[], categories?: string[], goalCheck?, replanCapable?: boolean }} opts
 * @returns {Promise<{ decision, reason, lesson, recovery_hint, answers, evidence_basis, evidence_refs, menu, skipped, valid, dir }>}
 */
export async function runTriageOnce(opts) {
  const { kind, config, task = null, run = null, next = null, stop = null, planId = null, goal = null, questions = [], categories = [], goalCheck = null, replanCapable = false } = opts;
  const usage = triageUsage({ taskId: task?.id ?? null, planId, config });
  const base = kind === 'task' ? run?.runDir : planDir(planId);
  if (!base) return { decision: 'ESCALATE', reason: 'triage has no artifact location for this stop', skipped: true, valid: false, menu: ['ESCALATE'], dir: null };
  if (kind === 'task' && usage.decisionsRemaining <= 0) {
    return { decision: 'ESCALATE', reason: `triage decision budget for ${task.id} is exhausted (${usage.decisions}/${usage.limits.max_decisions_per_task})`, skipped: true, valid: false, menu: ['ESCALATE'], dir: null };
  }
  const { menu, why } = triageMenu({ kind, next, stop, usage, replanCapable, questions, categories });
  const dir = allocateDir(base);
  const writeJson = (name, v) => { const p = join(dir, name); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8'); return p; };
  if (menu.length === 1) {
    writeJson('triage-result.json', { kind, skipped: true, menu, why, valid: false, normalized: { decision: 'ESCALATE', reason: `nothing to decide: ${why.join('; ') || 'no automatable option for this stop'}` } });
    return { decision: 'ESCALATE', reason: `no automatable option (${why.join('; ') || 'menu is ESCALATE only'})`, skipped: true, valid: false, menu, dir };
  }

  assertBudget(config, task?.id ?? null);
  const adapterName = config.runtime.triage_adapter ?? config.runtime.verifier_adapter;
  const adapter = getAdapter(adapterName);
  const availability = await adapter.detect();
  if (!availability.available) throw new Error(`triage adapter "${adapterName}" is not available: ${availability.reason}`);
  const invoke = typeof adapter.runTriage === 'function' ? adapter.runTriage : adapter.runVerifier;
  if (typeof invoke !== 'function') throw new Error(`triage adapter "${adapterName}" cannot run a read-only invocation`);

  if (!existsSync(TRIAGE_CONTRACT_PATH)) throw new Error(`missing triage contract ${rel(TRIAGE_CONTRACT_PATH)}`);
  const contract = readFileSync(TRIAGE_CONTRACT_PATH, 'utf8');
  const subjectBefore = subjectRef(computeSubject(ROOT));
  const memos = kind === 'task' && run ? collectMemoChain(task.id, run.runId) : [];
  const d = next?.assessment?.diagnosis ?? (run ? readDiagnosis(run.runDir) : null);

  const context = [
    section('TRIAGE CONTRACT', contract),
    section('STOP', [`kind: ${kind}`, stop ? `result: ${stop.result}` : '', stop ? `stop_reason: ${stop.reason}` : '', `detail: ${stop?.detail ?? next?.reason ?? ''}`, next ? `runtime next-action: ${next.action}` : ''].filter(Boolean).join('\n')),
    section('MENU', menu.map((m) => `${m}: ${MEANING[m]}`).join('\n') + (why.length ? `\n\nnot offered: ${why.join('; ')}` : '')),
    section('TASK', renderTask(task)),
    section('GOAL', goal ? clip(goal, 6000) : '(no goal available for this stop)'),
    ...(kind === 'task' ? [
      section('DIAGNOSIS (deterministic)', renderDiagnosis(d && !d.corrupt ? d : null)),
      section('FAILURE MEMO CHAIN', memos.map((m) => `attempt ${m.attempt} [${m.failure_class}]: ${m.lesson}`).join('\n')),
      section('GATE REPORT', renderGateReport(run)),
      section('VERIFICATION REPORT', renderVerification(run)),
      section('REPOSITORY CHANGES SINCE GATES', renderSubjectChanges(run, config)),
      section('WORKER CLAIM (not evidence)', renderWorkerClaim(run)),
    ] : []),
    ...(kind === 'questions' ? [section('PLANNER QUESTIONS', questions.map((q, i) => `${i + 1}. [${categories[i] ?? 'other'}] ${q}`).join('\n'))] : []),
    ...(kind === 'goal' ? [section('GOAL CHECK', [`result: ${goalCheck?.result}`, `reason: ${goalCheck?.reason ?? ''}`].join('\n'))] : []),
    section('PRODUCT SPEC', renderSpec()),
    section('RUNTIME FACTS', [
      `triage decisions used for this task: ${usage.decisions}/${usage.limits.max_decisions_per_task}`,
      `triage retries remaining: ${usage.retriesRemaining}`,
      `replans used for this plan: ${usage.replans}/${usage.limits.max_replans_per_plan}`,
      run ? `run: ${run.runId} (${rel(run.runDir)})` : '',
      planId ? `plan: ${planId}` : '',
      `repository subject sha256: ${subjectBefore.sha256 ?? '(unavailable)'}`,
    ].filter(Boolean).join('\n')),
  ].join('\n');
  const contextPath = join(dir, 'context.md');
  writeFileSync(contextPath, context, 'utf8');
  const protectedBefore = fingerprintDir(LOOP_DIR);
  const startedAt = new Date();
  writeFileSync(join(dir, 'triage-started.json'), JSON.stringify({ started_at: startedAt.toISOString(), kind, task_id: task?.id ?? null, run_id: run?.runId ?? null, plan_id: planId }));

  const proc = await invoke({
    runId: run?.runId ?? planId ?? 'PLAN',
    taskId: task?.id ?? 'PLAN',
    subjectSha256: subjectBefore.sha256,
    context,
    systemPrompt: triageProtocol({ menu, kind, taskId: task?.id, runId: run?.runId, subjectSha256: subjectBefore.sha256, questions }),
    cwd: ROOT,
    timeoutMs: config.runtime.triage_timeout_seconds * 1000,
    model: config.runtime.triage_model ?? config.runtime.verifier_model,
    effort: config.runtime.triage_effort ?? config.runtime.verifier_effort ?? null,
    maxBudgetUsd: config.runtime.max_call_budget_usd ?? null,
    schema: triageResultSchema(menu),
    tools: VERIFIER_TOOLS,
    deny: VERIFIER_DENY,
  });
  const finishedAt = new Date();
  const controlPlane = compareFingerprints(protectedBefore, fingerprintDir(LOOP_DIR));
  const subjectStable = sameSubject(subjectBefore, subjectRef(computeSubject(ROOT)));
  writeFileSync(join(dir, 'stdout.log'), proc.stdout ?? '', 'utf8');
  writeFileSync(join(dir, 'stderr.log'), proc.stderr ?? '', 'utf8');

  const failures = [];
  if (proc.launch_error) failures.push(`triage launch failed: ${proc.launch_error}`);
  if (proc.timed_out) failures.push(`triage timed out after ${config.runtime.triage_timeout_seconds}s`);
  if (!proc.timed_out && !proc.launch_error && proc.exit_code !== 0) failures.push(`triage exited with code ${proc.exit_code}`);
  if (controlPlane.violated || !subjectStable) failures.push('triage policy violation: files changed during a read-only triage call');
  const raw = proc.structured_output ?? null;
  const validation = raw === null ? { valid: false, errors: ['no structured triage result was returned'], result: null } : validateTriageResult(raw, { menu, questions, run, planId });
  if (!validation.valid) failures.push(...validation.errors.map((m) => `triage result: ${m}`));

  // 실패한 Triage는 ESCALATE다. 무효한 결정을 실행하지 않는다.
  const normalized = failures.length === 0 ? validation.result : { decision: 'ESCALATE', reason: `triage could not decide: ${failures.join('; ')}`, evidence_basis: 'none', evidence_refs: [], lesson: null, recovery_hint: null, answers: null };
  const resultPath = writeJson('triage-result.json', { kind, skipped: false, menu, why, received: raw, valid: failures.length === 0, errors: failures, normalized });
  freeze(resultPath);
  const envelope = {
    stage: 'triage', kind, task_id: task?.id ?? null, run_id: run?.runId ?? null, plan_id: planId,
    adapter: adapterName, adapter_version: availability.version ?? null, model: proc.model ?? null,
    effort_requested: config.runtime.triage_effort ?? config.runtime.verifier_effort ?? null,
    max_call_budget_usd: config.runtime.max_call_budget_usd ?? null, profile: config.profile ?? null,
    started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(), duration_ms: finishedAt - startedAt,
    process: { exit_code: proc.exit_code ?? null, signal: proc.signal ?? null, timed_out: proc.timed_out, launch_error: proc.launch_error ?? null },
    policy_violation: controlPlane.violated || !subjectStable, control_plane: controlPlane,
    decision: normalized.decision, menu,
    usage: { context: contextMetrics(context), process_output: outputMetrics(proc.stdout, proc.stderr), tokens: normalizeTokens(proc.provider_usage), adapter: adapterName, model: proc.model ?? null, provider_cost_usd: proc.adapter_meta?.provider_cost_usd ?? null },
    adapter_meta: proc.adapter_meta ?? null, failures,
  };
  const envelopePath = writeJson('triage-envelope.json', envelope);
  freeze(envelopePath);
  return { ...normalized, menu, skipped: false, valid: failures.length === 0, dir, envelope };
}

/** UNBLOCK가 남기는 설명. 다음 Worker Context에 TRIAGE CLARIFICATION 절로 들어간다. */
export function writeClarification(taskId, note) {
  const dir = join(CLARIFICATION_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'clarification.json');
  const existing = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { task_id: taskId, notes: [] };
  existing.notes.push({ ...note, at: new Date().toISOString() });
  writeFileSync(p, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return p;
}

export function readClarification(taskId) {
  const p = join(CLARIFICATION_DIR, taskId, 'clarification.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Replan 시 Planner에게 덧붙이는 컨텍스트. Goal 원문은 그대로 두고 아래에 붙인다. */
export function renderReplanGoal({ goal, planId, detail, attempt, dropped, done }) {
  return [
    goal.trim(), '',
    `--- RUNTIME REPLAN CONTEXT (replan ${attempt}, generated by the runtime) ---`,
    `The previous plan ${planId} for the goal above stopped: ${detail}`,
    done.length ? `Tasks already DONE and still valid: ${done.join(', ')}.` : 'No task of the previous plan reached DONE.',
    dropped.length ? `Tasks superseded by this replan (now DROPPED): ${dropped.join(', ')}.` : '',
    'Plan only the remaining work needed to satisfy the goal above. Do not repeat DONE work. Do not modify or recreate DROPPED tasks.',
    'Prefer smaller tasks with deterministic gate criteria where possible.',
  ].filter((l) => l !== '').join('\n');
}

/** ANSWER 시 Goal에 덧붙이는 결정 절. 답의 출처가 함께 남는다. */
export function renderAnsweredGoal({ goal, answers }) {
  return [
    goal.trim(), '',
    '--- DECISIONS (answered by runtime triage from repository evidence) ---',
    ...answers.map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}\n   evidence: ${a.evidence_refs.join(', ')}`),
    'Treat these as the human\'s decisions for this plan. Do not ask them again.',
  ].join('\n');
}
