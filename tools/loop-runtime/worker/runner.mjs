// runner — Worker 한 번 실행. Snapshot을 입력으로 주고, 관찰한 사실을 Runtime Envelope에 남긴다.
//
// 이 파일은 Task 상태를 직접 쓰지 않는다. 전이는 loopctl이 task-store를 통해서만 수행한다.
// Worker의 주장(Worker Result)과 Runtime의 관찰(Runtime Envelope)은 끝까지 분리해서 저장한다.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { ROOT } from '../task-store.mjs';
import { computeSubject, subjectRef } from '../subject.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { validateWorkerResult, OUTCOMES } from './result.mjs';
import { contextMetrics, outputMetrics, normalizeTokens, observeChanges, diffObserved } from './telemetry.mjs';
import {
  PROTECTED_ROOT, EVIDENCE_ROOT, evidenceDirFor, evidencePathFor, protectedExceptionsFor,
  workerDenyRules, workerAllowRules, selfCheckCommand,
} from './policy.mjs';

export { PROTECTED_ROOT };

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, exceptions, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (exceptions.some((ex) => full === ex || full.startsWith(`${ex}/`))) continue;
    if (entry.isDirectory()) walk(full, exceptions, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * 디렉터리 하위 파일들의 해시 지문. 실행 전후로 두 번 찍어서 비교한다.
 * Verifier는 예외 없이 .loop/ 전체를 잠그므로 exceptions를 비워서 호출한다.
 */
export function fingerprintDir(root, exceptions = []) {
  const map = {};
  for (const file of walk(root, exceptions)) map[rel(file)] = sha256(readFileSync(file));
  return map;
}

/**
 * Worker 기준 보호 대상 지문 — **이 Task의 Evidence 디렉터리만** 제외한다.
 * 다른 Task의 Evidence는 예외가 아니다. 손대면 policy violation으로 잡힌다.
 */
export function fingerprintProtected(taskId) {
  return fingerprintDir(PROTECTED_ROOT, protectedExceptionsFor(taskId));
}

export function compareFingerprints(before, after) {
  const modified = [];
  const removed = [];
  const added = [];
  for (const [path, hash] of Object.entries(before)) {
    if (!(path in after)) removed.push(path);
    else if (after[path] !== hash) modified.push(path);
  }
  for (const path of Object.keys(after)) if (!(path in before)) added.push(path);
  const violated = modified.length + removed.length + added.length > 0;
  return { violated, modified: modified.sort(), removed: removed.sort(), added: added.sort() };
}

/** Runtime이 Worker에게 덧붙이는 Result 규약. context.md에는 들어가지 않는다. */
export function resultProtocol({ runId, taskId, resultPath }) {
  const evidencePath = evidencePathFor(taskId);
  return [
    'RUNTIME RESULT PROTOCOL (Runtime이 지정한다. Task 내용이 아니다.)',
    '',
    `이 Run의 run_id는 "${runId}", task_id는 "${taskId}"이다.`,
    `작업을 마치면 아래 JSON을 파일 "${resultPath}" 에 정확히 하나 써라. 이것이 너의 Result다.`,
    '이 파일을 쓰지 않으면 Run은 실패로 처리된다. 대화 출력은 Result로 인정되지 않는다.',
    '',
    '{',
    `  "run_id": "${runId}",`,
    `  "task_id": "${taskId}",`,
    `  "outcome": "${OUTCOMES.join(' | ')}",`,
    '  "summary": "한 줄 요약",',
    '  "changed_files": ["실제로 수정한 파일 경로"],',
    '  "evidence": [{ "kind": "test | build | lint | diff | log", "path": "..." }],',
    '  "requested_transition": "REVIEW | BLOCKED | null"',
    '}',
    '',
    'outcome: success 이면 requested_transition은 "REVIEW"다.',
    'outcome: blocked 이면 "BLOCKED"다. outcome: failed 이면 null이다.',
    'DONE은 어떤 경우에도 요청할 수 없다. 완료 판정은 Runtime과 Verifier의 몫이다.',
    '',
    'RUNTIME CAPABILITIES (이 Run에서 실제로 가능한 것. 하나씩 시도해 보고 알아낼 필요 없다.)',
    `Evidence 쓰기: ${evidencePath}/ 아래에만 쓸 수 있다. 이 디렉터리는 Runtime이 미리 만들어 두었다.`,
    `.loop/ 의 나머지는 전부 읽기 전용이다 — 다른 Task의 ${rel(EVIDENCE_ROOT)}/<TASK-ID>/ 포함. 수정하면 Run이 무효가 된다.`,
    `명령 실행: 아래 self-check 하나만 실행할 수 있다. 다른 Bash 명령은 전부 거부된다.`,
    `  ${selfCheckCommand()} [<gate> ...]`,
    '  이것은 project.yaml에 설정된 Gate 명령만 돌리는 Runtime 소유 진입점이다.',
    '  결과는 참고용이다 — 완료 판정이 아니다. Runtime이 Worker 종료 후 Gate를 독립적으로 다시 돌린다.',
  ].join('\n');
}

/**
 * Worker를 한 번 실행하고 Run 디렉터리에 산출물을 남긴다.
 * Task 상태는 건드리지 않는다. 판단에 필요한 사실만 돌려준다.
 */
export async function runWorkerOnce({ task, snapshot, config, attempt = 1 }) {
  const adapterName = config.runtime.worker_adapter;
  const adapter = getAdapter(adapterName);
  const availability = await adapter.detect();
  if (!availability.available) {
    throw new Error(`worker adapter "${adapterName}" is not available: ${availability.reason}`);
  }

  const runDir = snapshot.runDir;
  const contextPath = join(runDir, 'context.md');
  const context = readFileSync(contextPath, 'utf8');
  const resultPath = join(runDir, 'worker-result.json');
  const timeoutMs = config.runtime.worker_timeout_seconds * 1000;

  // Evidence 디렉터리는 Worker가 쓸 수 있어야 하므로 Runtime이 미리 만들어 둔다.
  // deny 규칙도 fingerprint 예외도 정확히 이 경로 하나만 연다 (worker/policy.mjs).
  mkdirSync(evidenceDirFor(task.id), { recursive: true });

  const protectedBefore = fingerprintProtected(task.id);
  const changesBefore = observeChanges(ROOT, { ignore: ['.loop-local/'] });
  // 이 Run이 어떤 저장소 상태에서 시작해 어떤 상태를 남겼는지. 나중에 retry 안전성 판단에 쓴다.
  const subjectBefore = subjectRef(computeSubject(ROOT));

  const startedAt = new Date();
  const proc = await adapter.runWorker({
    runId: snapshot.runId,
    taskId: task.id,
    context,
    systemPrompt: resultProtocol({ runId: snapshot.runId, taskId: task.id, resultPath: rel(resultPath) }),
    cwd: ROOT,
    timeoutMs,
    model: config.runtime.worker_model,
    resultPath,
    deny: workerDenyRules(task.id),
    allow: workerAllowRules(),
  });
  const finishedAt = new Date();

  const protectedAfter = fingerprintProtected(task.id);
  const subjectAfter = subjectRef(computeSubject(ROOT));
  const integrity = compareFingerprints(protectedBefore, protectedAfter);
  const observed = diffObserved(changesBefore, observeChanges(ROOT, { ignore: ['.loop-local/'] }));

  writeFileSync(join(runDir, 'stdout.log'), proc.stdout ?? '', 'utf8');
  writeFileSync(join(runDir, 'stderr.log'), proc.stderr ?? '', 'utf8');

  // Worker Result 수집 — 대화 출력을 파싱하지 않고, 지정한 결과 파일만 읽는다.
  const failures = [];
  let parsed = null;
  let validation = { valid: false, errors: [], result: null };
  if (proc.launch_error) failures.push(`worker launch failed: ${proc.launch_error}`);
  if (proc.timed_out) failures.push(`worker timed out after ${config.runtime.worker_timeout_seconds}s`);
  if (!proc.timed_out && !proc.launch_error && proc.exit_code !== 0) {
    failures.push(`worker exited with code ${proc.exit_code}`);
  }

  if (!existsSync(resultPath)) {
    failures.push(`worker result file not found: ${rel(resultPath)}`);
  } else {
    try {
      parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch (e) {
      failures.push(`worker result is not valid JSON: ${e.message}`);
    }
    if (parsed !== null) {
      validation = validateWorkerResult(parsed, { runId: snapshot.runId, taskId: task.id });
      if (!validation.valid) failures.push(...validation.errors.map((m) => `worker result: ${m}`));
    }
  }

  if (integrity.violated) {
    const detail = [
      ...integrity.modified.map((p) => `modified ${p}`),
      ...integrity.added.map((p) => `added ${p}`),
      ...integrity.removed.map((p) => `removed ${p}`),
    ].join(', ');
    failures.push(`policy violation: worker mutated runtime-owned files (${detail})`);
  }

  const envelope = {
    run_id: snapshot.runId,
    task_id: task.id,
    adapter: adapterName,
    adapter_version: availability.version ?? null,
    model: proc.model ?? null,
    attempt,
    lineage: snapshot.manifest?.lineage ?? null,

    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,

    process: {
      exit_code: proc.exit_code ?? null,
      signal: proc.signal ?? null,
      timed_out: proc.timed_out,
      timeout_seconds: config.runtime.worker_timeout_seconds,
      launch_error: proc.launch_error ?? null,
    },

    worker_result_valid: validation.valid,
    worker_result_errors: validation.errors,
    worker_requested_transition: validation.valid ? validation.result.requested_transition : null,

    policy_violation: integrity.violated,
    protected_paths: {
      root: rel(PROTECTED_ROOT),
      exceptions: protectedExceptionsFor(task.id).map(rel),
      file_count: Object.keys(protectedBefore).length,
      ...integrity,
    },

    verification_subject_before: subjectBefore,
    verification_subject_after: subjectAfter,

    observed_changes: {
      source: observed.source,
      files: observed.files,
      count: observed.count,
      pre_existing_count: changesBefore.count,
    },

    usage: {
      context: contextMetrics(context),
      process_output: outputMetrics(proc.stdout, proc.stderr),
      tokens: normalizeTokens(proc.provider_usage),
      observed_changed_files: observed.count,
      worker_attempt_number: attempt,
      adapter: adapterName,
      model: proc.model ?? null,
      provider_cost_usd: proc.adapter_meta?.provider_cost_usd ?? null,
    },

    adapter_meta: proc.adapter_meta ?? null,
    failures,
  };

  writeFileSync(join(runDir, 'runtime-envelope.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  return { envelope, workerResult: validation.result, failures, integrity, observed };
}
