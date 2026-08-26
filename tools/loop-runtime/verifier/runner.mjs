// verifier/runner — 독립 Verifier 1회 실행.
//
// Worker와 완전히 분리된 새 AI invocation이다. 세션도, 대화 기록도, context도 공유하지 않는다.
// Verifier는 읽기 전용이다 — 쓰기 도구를 주지 않고, 실행 전후로 저장소와 control plane을
// 해시로 대조해서 실제로 아무것도 바꾸지 않았음을 Runtime이 직접 확인한다.
//
// 이 파일은 Task 상태를 쓰지 않는다. 전이는 loopctl이 task-store를 통해서만 수행한다.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, LOOP_DIR } from '../task-store.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { fingerprintDir, compareFingerprints } from '../worker/runner.mjs';
import { contextMetrics, outputMetrics, normalizeTokens } from '../worker/telemetry.mjs';
import { checkEligibility, resolveRunRef, latestRunForTask } from '../gate/runner.mjs';
import { readGateReport } from '../gate/report.mjs';
import { validateVerifierResult, verifierResultSchema, verifierCriterionIds } from './result.mjs';
import { writeVerifierSnapshot, VERIFICATION_DIR } from './context-builder.mjs';
import {
  buildVerificationReport, writeVerificationReport, readVerificationReport,
  archivePriorVerification, priorVerificationAttempts, freeze,
} from './report.mjs';

const rel = (p) => relative(ROOT, p).split('\\').join('/');

// Verifier에게 허용하는 built-in tool. 읽기 전용만 준다.
export const VERIFIER_TOOLS = ['Read', 'Grep', 'Glob'];
// 이중 방어 — tool 집합 제한과 별개로 명시적으로 거부한다.
export const VERIFIER_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

/** Runtime이 Verifier에게 덧붙이는 결과 규약. context.md에는 들어가지 않는다. */
export function verifierProtocol({ runId, taskId, subjectSha256, criterionIds }) {
  return [
    'RUNTIME VERIFIER PROTOCOL (Runtime이 지정한다. Task 내용이 아니다.)',
    '',
    '너는 독립 Verifier다. 구현자가 아니고, 구현자의 주장을 넘겨받지 않았다.',
    '코드를 고치지 않는다. 파일을 쓰지 않는다. Runtime 상태나 Task 파일을 건드리지 않는다.',
    '너에게는 읽기 도구(Read · Grep · Glob)만 있다. 그 외 도구는 거부된다.',
    '',
    `이 검증의 run_id는 "${runId}", task_id는 "${taskId}"이다.`,
    `검증 대상(verification subject)의 sha256은 "${subjectSha256}"이다. 그대로 반환해라.`,
    '',
    criterionIds.length === 0
      ? '이 Task에는 verifier가 판정할 Acceptance Criterion이 없다. criteria는 빈 배열이다.'
      : `너가 판정해야 하는 Acceptance Criterion은 정확히 이것들이다: ${criterionIds.join(', ')}.`,
    'criteria 배열에는 이 id들에 대한 항목만, 각각 정확히 하나씩 넣는다.',
    'type이 gate인 Acceptance Criterion은 이미 결정론적으로 판정되었다.',
    '그것을 다시 판정하지 않고, criteria에 넣지도 않는다. Gate의 PASS/FAIL을 뒤집지 않는다.',
    '',
    '결과는 구조화 출력(JSON schema)으로 반환된다. 산문 요약은 판정으로 인정되지 않는다.',
    'result는 PASS 또는 FAIL만 가능하다. 부분 통과는 없다.',
    '',
    'EVIDENCE BASIS (모든 criteria 항목에 필수다.)',
    'evidence_basis 는 다음 중 하나다:',
    '  gate                Runtime이 직접 실행한 Gate 결과',
    '  runtime_artifact    Runtime이 만든 Run 산출물 (evidence_refs에 경로를 적는다)',
    '  canonical_diff      Runtime이 만든 변경 매니페스트/패치',
    '  repository_content  저장소에 실제로 존재하는 파일 (evidence_refs에 경로를 적는다)',
    '  unwitnessed_claim   이 AC를 만족시키려면 Runtime이 목격하지 못한 실행이 필요하다',
    'Worker의 서술·요약·"확인했다"는 근거가 아니다. 그런 것에 대응하는 basis 값은 없다.',
    'evidence_refs에 적은 경로는 Runtime이 실제로 존재하는지 확인한다. 없는 경로를 적으면 결과 전체가 무효다.',
    '',
    'UNWITNESSED CLAIMS',
    '수동 조작 · 브라우저 실행 · 네트워크 접근 · 외부 서비스 · 실물 렌더링을 필요로 하는 AC는,',
    'Runtime Facts에 그 실행의 증거가 없다면 evidence_basis를 unwitnessed_claim으로 두고 status는 FAIL이다.',
    'unwitnessed_kind에 분류를 적는다. **unwitnessed_claim으로 PASS를 줄 수 없다 — Runtime이 거부한다.**',
    '산출물(문서 등)이 그런 실행을 했다고 서술하는데 Runtime Facts가 그것을 뒷받침하지 않으면,',
    '그 서술을 사실로 받아들이지 않는다. 해당 AC는 unwitnessed_claim + FAIL이다.',
    'AC가 하나라도 FAIL이면 result는 FAIL이다. failed_criteria는 FAIL인 id 목록과 정확히 일치해야 한다.',
    '개별 AC는 전부 PASS지만 범위 밖 변경·테스트 약화 같은 전역 문제가 있으면,',
    'result를 FAIL로 두고 reason에 그 사유를 구체적으로 적는다.',
    '',
    'Task를 DONE으로 만드는 것은 너의 권한이 아니다. 전이는 Runtime이 결정한다.',
  ].join('\n');
}

/**
 * Verifier 실행 자격. Gate 층의 자격 검사를 그대로 재사용하고 검증 고유 조건을 더한다.
 * @returns {{ ok, errors, envelope, workerResult, gateReport, subject, requiresVerifier }}
 */
export function checkVerifierEligibility({ task, run, config }) {
  const base = checkEligibility({ task, run, config });
  const errors = [...base.errors];

  const subject = subjectRef(computeSubject(ROOT));
  if (!subject.sha256) {
    errors.push('cannot compute a verification subject fingerprint (git is required for verification)');
  }

  const gateReport = readGateReport(run.runDir);
  if (gateReport === null) {
    errors.push(`run ${run.runId}: no gate report — run \`loopctl gate ${run.runId}\` first`);
  } else if (gateReport.corrupt) {
    errors.push(`run ${run.runId}: gate-report.json is corrupt`);
  } else {
    if (gateReport.run_id !== run.runId) errors.push(`gate report belongs to run ${gateReport.run_id}`);
    if (gateReport.task_id !== task.id) errors.push(`gate report belongs to task ${gateReport.task_id}`);
    if (gateReport.result !== 'PASS') {
      errors.push(`gate result is ${gateReport.result} — the verifier is not eligible until deterministic gates pass`);
    }
    const same = JSON.stringify(gateReport.required_gates) === JSON.stringify(base.required.names);
    if (!same) errors.push('gate report is stale — the task\'s required gates changed since gates ran');

    // Gate PASS는 그것이 실제로 검사한 저장소 상태에만 유효하다.
    if (!gateReport.verification_subject?.sha256) {
      errors.push('Gate Report is not bound to the current repository state. Run Gates again for this Worker Run.');
    } else if (!sameSubject(gateReport.verification_subject, subject)) {
      errors.push(
        'Gate Report is not bound to the current repository state. Run Gates again for this Worker Run.\n' +
        `    gate subject:    ${gateReport.verification_subject.sha256}\n` +
        `    current subject: ${subject.sha256}`
      );
    }
  }

  const requiresVerifier = task.data.stop_condition.requires_verifier === true
    || task.data.acceptance_criteria.some((ac) => ac.verification.type === 'verifier');
  if (!requiresVerifier) {
    errors.push(`${task.id} does not require independent verification (stop_condition.requires_verifier is false and no verifier-type criteria exist)`);
  }

  return {
    ok: errors.length === 0,
    errors,
    envelope: base.envelope,
    workerResult: base.workerResult,
    gateReport,
    subject,
    requiresVerifier,
    required: base.required,
  };
}

/**
 * Verifier를 한 번 실행하고 verification/ 디렉터리에 산출물을 남긴다.
 * Task 상태는 건드리지 않는다. 판단에 필요한 사실만 돌려준다.
 */
export async function runVerifierOnce({ task, run, config, eligibility, onLaunch }) {
  const adapterName = config.runtime.verifier_adapter;
  const adapter = getAdapter(adapterName);
  const availability = await adapter.detect();
  if (!availability.available) {
    throw new Error(`verifier adapter "${adapterName}" is not available: ${availability.reason}`);
  }
  if (typeof adapter.runVerifier !== 'function') {
    throw new Error(`adapter "${adapterName}" does not implement runVerifier`);
  }

  const { envelope: workerEnvelope, workerResult, gateReport, subject } = eligibility;
  const snapshot = writeVerifierSnapshot({ task, run, envelope: workerEnvelope, workerResult, gateReport, subject });
  const verificationDir = snapshot.dir;
  const criterionIds = verifierCriterionIds(task);
  const timeoutSeconds = config.runtime.verifier_timeout_seconds;

  // 실행 전 지문 — 저장소 대상과 control plane 둘 다.
  // Verifier에게는 .loop/evidence/ 예외도 없다. 감사자는 아무것도 쓰지 않는다.
  const protectedBefore = fingerprintDir(LOOP_DIR);
  const subjectBefore = subject;

  onLaunch?.({ adapter: adapterName, version: availability.version ?? null });

  const startedAt = new Date();
  const proc = await adapter.runVerifier({
    runId: run.runId,
    taskId: task.id,
    subjectSha256: subject.sha256,
    context: snapshot.context,
    systemPrompt: verifierProtocol({
      runId: run.runId, taskId: task.id, subjectSha256: subject.sha256, criterionIds,
    }),
    cwd: ROOT,
    timeoutMs: timeoutSeconds * 1000,
    model: config.runtime.verifier_model,
    schema: verifierResultSchema(),
    tools: VERIFIER_TOOLS,
    deny: VERIFIER_DENY,
  });
  const finishedAt = new Date();

  const protectedAfter = fingerprintDir(LOOP_DIR);
  const controlPlane = compareFingerprints(protectedBefore, protectedAfter);
  const subjectAfter = subjectRef(computeSubject(ROOT));
  const subjectStable = sameSubject(subjectBefore, subjectAfter);

  writeFileSync(join(verificationDir, 'stdout.log'), proc.stdout ?? '', 'utf8');
  writeFileSync(join(verificationDir, 'stderr.log'), proc.stderr ?? '', 'utf8');

  // Verifier가 저장소나 control plane을 건드렸으면 그 자체로 결과를 쓸 수 없다.
  const policyDetail = [];
  if (controlPlane.violated) {
    policyDetail.push(
      ...controlPlane.modified.map((p) => `modified ${p}`),
      ...controlPlane.added.map((p) => `added ${p}`),
      ...controlPlane.removed.map((p) => `removed ${p}`),
    );
  }
  if (!subjectStable) policyDetail.push(`verification subject changed: ${subjectBefore.sha256} -> ${subjectAfter.sha256}`);
  const verifierPolicyViolation = controlPlane.violated;

  const failures = [];
  if (proc.launch_error) failures.push(`verifier launch failed: ${proc.launch_error}`);
  if (proc.timed_out) failures.push(`verifier timed out after ${timeoutSeconds}s`);
  if (!proc.timed_out && !proc.launch_error && proc.exit_code !== 0) {
    failures.push(`verifier exited with code ${proc.exit_code}`);
  }
  if (verifierPolicyViolation) {
    failures.push(`verifier policy violation: the verifier mutated runtime-owned files (${policyDetail.join(', ')})`);
  }

  // 결과는 구조화 출력 채널로만 받는다. 대화 텍스트를 판정으로 긁어내지 않는다.
  const raw = proc.structured_output ?? null;
  if (raw === null) {
    failures.push('verifier produced no structured result (the conversational transcript is not a verdict)');
  }
  const validation = raw === null
    ? { valid: false, errors: ['no structured verifier result was returned'], result: null, global_failure: false }
    : validateVerifierResult(raw, {
      runId: run.runId,
      taskId: task.id,
      subjectSha256: subject.sha256,
      task,
      // Verifier가 지목한 근거가 실제로 존재하는지 Runtime이 직접 확인한다.
      evidenceFacts: {
        gateReport,
        diffFileCount: snapshot.diff.files.length,
        refExists: (p) => existsSync(join(ROOT, p)) || existsSync(join(run.runDir, p)),
      },
    });
  if (raw !== null && !validation.valid) {
    failures.push(...validation.errors.map((m) => `verifier result: ${m}`));
  }

  // Verifier가 실제로 돌려준 것을 그대로 보존한다(정규화 전 원본).
  const resultPath = join(verificationDir, 'verifier-result.json');
  writeFileSync(resultPath, `${JSON.stringify({
    received: raw,
    valid: validation.valid,
    errors: validation.errors,
    normalized: validation.result,
  }, null, 2)}\n`, 'utf8');
  freeze(resultPath);

  const context = snapshot.context;
  const verifierEnvelope = {
    run_id: run.runId,
    task_id: task.id,
    stage: 'verifier',
    adapter: adapterName,
    adapter_version: availability.version ?? null,
    model: proc.model ?? null,
    attempt: priorVerificationAttempts(verificationDir) + 1,

    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,

    process: {
      exit_code: proc.exit_code ?? null,
      signal: proc.signal ?? null,
      timed_out: proc.timed_out,
      timeout_seconds: timeoutSeconds,
      launch_error: proc.launch_error ?? null,
    },

    verifier_result_valid: validation.valid,
    verifier_result_errors: validation.errors,
    verifier_policy_violation: verifierPolicyViolation,
    policy_detail: policyDetail,

    verification_subject_before: subjectBefore,
    verification_subject_after: subjectAfter,
    verification_subject_stable: subjectStable,

    read_only: { tools: VERIFIER_TOOLS, denied: VERIFIER_DENY },
    control_plane: {
      root: rel(LOOP_DIR),
      exceptions: [],
      file_count: Object.keys(protectedBefore).length,
      ...controlPlane,
    },

    usage: {
      context: contextMetrics(context),
      process_output: outputMetrics(proc.stdout, proc.stderr),
      tokens: normalizeTokens(proc.provider_usage),
      adapter: adapterName,
      model: proc.model ?? null,
      provider_cost_usd: proc.adapter_meta?.provider_cost_usd ?? null,
      verifier_attempt_number: priorVerificationAttempts(verificationDir) + 1,
    },

    adapter_meta: proc.adapter_meta ?? null,
    failures,
  };
  const envelopePath = join(verificationDir, 'verifier-envelope.json');
  writeFileSync(envelopePath, `${JSON.stringify(verifierEnvelope, null, 2)}\n`, 'utf8');
  freeze(envelopePath);

  const report = buildVerificationReport({
    runId: run.runId,
    taskId: task.id,
    task,
    attempt: verifierEnvelope.attempt,
    subjectBefore,
    subjectAfter,
    gateReport,
    verifierValidation: validation,
    verifierEnvelope,
    workerPolicyViolation: workerEnvelope.policy_violation === true,
    startedAt,
    finishedAt,
  });
  const reportPath = writeVerificationReport(verificationDir, report);

  return { snapshot, verifierEnvelope, validation, report, reportPath, verificationDir, failures };
}

export const verificationDirFor = (runDir) => join(runDir, VERIFICATION_DIR);
export {
  resolveRunRef, latestRunForTask, readVerificationReport, archivePriorVerification,
  verifierCriterionIds,
};
