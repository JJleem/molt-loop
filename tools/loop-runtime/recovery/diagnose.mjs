// recovery/diagnose — 결정론적 실패 진단. LLM을 호출하지 않는다.
//
// "왜 실패했는가"를 모델에게 묻지 않는다. Runtime이 이미 기록해 둔 사실
// (Runtime Envelope · Gate Report · Verification Report)만으로 분류한다.
//
// 안전을 모를 때는 추측하지 않고 fail-closed 한다: RECOVERY_AMBIGUOUS + NEEDS_HUMAN.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../task-store.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { readGateReport } from '../gate/report.mjs';
import { readVerificationReport } from '../verifier/report.mjs';
import { verificationDirFor } from '../verifier/runner.mjs';

export const RECOVERY_DIR = 'recovery';
export const DIAGNOSIS_FILE = 'diagnosis.json';
export const DIAGNOSIS_SCHEMA = 1;
export const HISTORY_DIR = 'history';

/** 현재 구현이 실제로 관찰할 수 있는 실패만 분류한다. 종류를 늘리지 않는다. */
export const FAILURE_CLASSES = [
  'PROCESS_CRASH', 'TIMEOUT', 'SCHEMA_FAILURE', 'GATE_FAILURE', 'VERIFY_FAILED',
  'PERMISSION_DENIED', 'POLICY_VIOLATION', 'STALE_VERIFICATION_SUBJECT', 'RECOVERY_AMBIGUOUS',
];

/** V0에서 실제 Worker 재시도로 이어지는 것은 RETRY와 RETRY_WITH_HINT뿐이다. */
export const ACTIONS = ['RETRY', 'RETRY_WITH_HINT', 'RERUN_GATES', 'REPLAN_REQUIRED', 'NEEDS_HUMAN', 'NO_ACTION'];
export const RETRYABLE_ACTIONS = ['RETRY', 'RETRY_WITH_HINT'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const recoveryDir = (runDir) => join(runDir, RECOVERY_DIR);
const diagnosisPath = (runDir) => join(recoveryDir(runDir), DIAGNOSIS_FILE);

const freeze = (p) => { try { chmodSync(p, 0o444); } catch { /* 지원 안 하면 무시 */ } };

export function readDiagnosis(runDir) {
  const p = diagnosisPath(runDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { corrupt: true }; }
}

/** 진단이 근거로 삼은 artifact들의 지문. 증거가 그대로면 진단을 다시 만들지 않는다. */
function evidenceFingerprint(runDir) {
  const parts = [];
  for (const f of ['runtime-envelope.json', 'gate-report.json', 'verification/verification-report.json']) {
    const p = join(runDir, f);
    parts.push(`${f}:${existsSync(p) ? sha256(readFileSync(p, 'utf8')) : 'absent'}`);
  }
  return sha256(parts.join('\n'));
}

/**
 * 같은 실패를 여러 Attempt에서 알아볼 수 있게 하는 지문.
 * timestamp·LLM이 쓴 문장처럼 흔들리는 값은 넣지 않는다.
 */
function failureFingerprint({ stage, failureClass, failedGates, failedCriteria, normalizedReason }) {
  return sha256(JSON.stringify({
    stage,
    failure_class: failureClass,
    gates: failedGates.map((g) => [g.name, g.status, g.exit_code ?? null]),
    criteria: [...failedCriteria].sort(),
    reason: normalizedReason,
  }));
}

const D = (o) => o; // 가독성용

/** Worker 단계 실패 분류. Envelope의 프로세스 사실만 본다. */
function diagnoseWorker(env) {
  const p = env.process ?? {};
  if (env.policy_violation === true) {
    const detail = [
      ...(env.protected_paths?.modified ?? []).map((x) => `modified ${x}`),
      ...(env.protected_paths?.added ?? []).map((x) => `added ${x}`),
      ...(env.protected_paths?.removed ?? []).map((x) => `removed ${x}`),
    ].join(', ');
    return D({
      failure_class: 'POLICY_VIOLATION', action: 'NEEDS_HUMAN',
      reason: `Worker mutated runtime-owned files (${detail || 'see runtime-envelope.json'}).`,
      normalized: 'worker-policy-violation',
    });
  }
  if (p.launch_error) {
    return D({
      failure_class: 'RECOVERY_AMBIGUOUS', action: 'NEEDS_HUMAN',
      reason: `Worker could not be launched: ${p.launch_error}`,
      normalized: 'worker-launch-error',
    });
  }
  if (p.timed_out) {
    return D({
      failure_class: 'TIMEOUT', action: 'RETRY_WITH_HINT',
      reason: `Worker exceeded the ${p.timeout_seconds}s worker timeout and was killed before producing a result.`,
      normalized: 'worker-timeout',
    });
  }
  if (p.exit_code !== 0 && p.exit_code !== null) {
    return D({
      failure_class: 'PROCESS_CRASH', action: 'RETRY',
      reason: `Worker process exited with code ${p.exit_code}.`,
      normalized: `worker-exit-${p.exit_code}`,
    });
  }
  if (env.worker_result_valid !== true) {
    const errs = env.worker_result_errors ?? [];
    return D({
      failure_class: 'SCHEMA_FAILURE', action: 'RETRY_WITH_HINT',
      reason: errs.length > 0
        ? `Worker Result did not validate: ${errs.join('; ')}`
        : 'Worker Result was missing or did not validate.',
      normalized: `worker-schema:${errs.join('|') || 'missing'}`,
      schema_errors: errs,
    });
  }
  return null; // Worker 단계에서는 실패하지 않았다.
}

/** Gate 단계 실패 분류. ERROR/TIMEOUT은 구현 실패의 증거가 아니므로 보수적으로 다룬다. */
function diagnoseGate(gateReport) {
  const bad = (gateReport.gates ?? []).filter((g) => g.status !== 'PASS');
  const errored = bad.filter((g) => g.status === 'ERROR');
  const timedOut = bad.filter((g) => g.status === 'TIMEOUT');
  const failed = bad.filter((g) => g.status === 'FAIL');

  if (errored.length > 0) {
    return D({
      failure_class: 'RECOVERY_AMBIGUOUS', action: 'NEEDS_HUMAN',
      reason: `Gate ${errored.map((g) => `"${g.name}"`).join(', ')} could not be executed (${errored[0].error ?? 'ERROR'}). `
        + 'This is a gate configuration or environment problem, not evidence that the implementation is wrong.',
      normalized: `gate-error:${errored.map((g) => g.name).sort().join(',')}`,
      failed_gates: bad,
    });
  }
  if (timedOut.length > 0) {
    return D({
      failure_class: 'TIMEOUT', action: 'NEEDS_HUMAN',
      reason: `Gate ${timedOut.map((g) => `"${g.name}"`).join(', ')} exceeded its timeout. `
        + 'A gate timeout is ambiguous between a hanging implementation and a slow environment; it is not retried automatically.',
      normalized: `gate-timeout:${timedOut.map((g) => g.name).sort().join(',')}`,
      failed_gates: bad,
    });
  }
  if (failed.length > 0) {
    return D({
      failure_class: 'GATE_FAILURE', action: 'RETRY_WITH_HINT',
      reason: `Gate ${failed.map((g) => `"${g.name}" exited ${g.exit_code}`).join(', ')}.`,
      normalized: `gate-fail:${failed.map((g) => `${g.name}=${g.exit_code}`).sort().join(',')}`,
      failed_gates: bad,
    });
  }
  return null;
}

/** Verifier 단계 실패 분류. Verifier 쪽 사고는 구현 재시도의 근거가 아니다. */
function diagnoseVerifier(vr) {
  if (vr.verifier_policy_violation === true) {
    return D({
      failure_class: 'PERMISSION_DENIED', action: 'NEEDS_HUMAN',
      reason: 'The verifier mutated files it must not touch; its verdict cannot be used.',
      normalized: 'verifier-policy-violation',
    });
  }
  if (vr.verification_subject_stable === false) {
    return D({
      failure_class: 'STALE_VERIFICATION_SUBJECT', action: 'RERUN_GATES',
      reason: 'The repository changed while the verifier was running, so its verdict does not describe any single tree state.',
      normalized: 'verifier-stale-subject',
    });
  }
  const proc = vr.verifier_process ?? {};
  if (proc.launch_error) {
    return D({
      failure_class: 'RECOVERY_AMBIGUOUS', action: 'NEEDS_HUMAN',
      reason: `The verifier could not be launched: ${proc.launch_error}. The implementation was never judged.`,
      normalized: 'verifier-launch-error',
    });
  }
  if (proc.timed_out) {
    return D({
      failure_class: 'TIMEOUT', action: 'NEEDS_HUMAN',
      reason: 'The verifier timed out, so the implementation was never judged. Re-run `loopctl verify --rerun` rather than re-running the worker.',
      normalized: 'verifier-timeout',
    });
  }
  if (proc.exit_code !== 0 && proc.exit_code !== null && proc.exit_code !== undefined) {
    return D({
      failure_class: 'PROCESS_CRASH', action: 'NEEDS_HUMAN',
      reason: `The verifier process exited with code ${proc.exit_code}, so the implementation was never judged. `
        + 'Re-run `loopctl verify --rerun` rather than re-running the worker.',
      normalized: `verifier-exit-${proc.exit_code}`,
    });
  }
  if (vr.verifier_result_valid !== true) {
    return D({
      failure_class: 'SCHEMA_FAILURE', action: 'NEEDS_HUMAN',
      reason: `The verifier returned an unusable result (${(vr.verifier_result_errors ?? []).join('; ') || 'no structured result'}). `
        + 'This is a verifier-side failure; re-run `loopctl verify --rerun` rather than re-running the worker.',
      normalized: 'verifier-schema-failure',
    });
  }
  if (vr.verifier_result === 'FAIL') {
    const failed = (vr.acceptance_criteria ?? [])
      .filter((a) => a.verification_type === 'verifier' && a.status !== 'PASS');
    return D({
      failure_class: 'VERIFY_FAILED', action: 'RETRY_WITH_HINT',
      reason: failed.length > 0
        ? `Verifier rejected ${failed.map((a) => a.id).join(', ')}.`
        : `Verifier failed the run for a global reason: ${vr.verifier_reason ?? '(no reason recorded)'}`,
      normalized: `verify-failed:${failed.map((a) => a.id).sort().join(',') || 'global'}`,
      failed_criteria: failed,
    });
  }
  return null;
}

/**
 * Run 하나를 진단한다. 가장 나중에 도달한 단계의 실패가 현재의 실패다.
 * @returns {object} diagnosis (실패가 없으면 failure_class: null, action: NO_ACTION)
 */
export function computeDiagnosis({ task, run, config, subject = null }) {
  const runDir = run.runDir;
  const envPath = join(runDir, 'runtime-envelope.json');
  const env = existsSync(envPath) ? JSON.parse(readFileSync(envPath, 'utf8')) : null;
  const gateReport = readGateReport(runDir);
  const vr = readVerificationReport(verificationDirFor(runDir));
  const current = subject ?? subjectRef(computeSubject(ROOT));

  let stage = null;
  let found = null;
  const sourceArtifacts = [];

  if (vr && !vr.corrupt && vr.result !== 'PASS') {
    stage = 'verifier';
    found = diagnoseVerifier(vr);
    sourceArtifacts.push('verification/verification-report.json');
  }
  if (!found && gateReport && !gateReport.corrupt && gateReport.result !== 'PASS') {
    stage = 'gate';
    found = diagnoseGate(gateReport);
    sourceArtifacts.push('gate-report.json');
  }
  if (!found && env) {
    const w = diagnoseWorker(env);
    if (w) { stage = 'worker'; found = w; sourceArtifacts.push('runtime-envelope.json'); }
  }
  if (!found && !env) {
    stage = 'worker';
    found = D({
      failure_class: 'RECOVERY_AMBIGUOUS', action: 'NEEDS_HUMAN',
      reason: 'This run has no runtime envelope; no worker attempt was completed here.',
      normalized: 'no-envelope',
    });
    sourceArtifacts.push('(none)');
  }

  const attempt = Number.isInteger(run.manifest?.attempt) ? run.manifest.attempt : (env?.attempt ?? 1);

  if (!found) {
    return {
      schema: DIAGNOSIS_SCHEMA,
      task_id: task.id,
      run_id: run.runId,
      stage: null,
      failure_class: null,
      retryable: false,
      recommended_action: 'NO_ACTION',
      failure_fingerprint: null,
      attempt,
      failed_gates: [],
      failed_criteria: [],
      reason: 'No failure was found for this run.',
      source_artifacts: [],
      evidence_sha256: evidenceFingerprint(runDir),
      subject_check: null,
      llm_calls: 0,
    };
  }

  const failedGates = (found.failed_gates ?? []).map((g) => ({
    name: g.name, status: g.status, exit_code: g.exit_code ?? null,
  }));
  const failedCriteria = (found.failed_criteria ?? []).map((c) => c.id);

  // 재시도 안전성: 실패한 Run이 검사했던 저장소 상태가 지금도 그대로인가.
  // 권위 있는 지문이 없으면 안전을 단정하지 않는다(fail-closed).
  const bound = stage === 'verifier' || stage === 'gate'
    ? gateReport?.verification_subject ?? null
    : env?.verification_subject_after ?? null;
  const subjectCheck = {
    bound_to: bound?.sha256 ?? null,
    current: current.sha256,
    matches: bound ? sameSubject(bound, current) : false,
    source: stage === 'worker' ? 'runtime-envelope.verification_subject_after' : 'gate-report.verification_subject',
  };

  let failureClass = found.failure_class;
  let action = found.action;
  let reason = found.reason;
  // 이 실패 자체는 재시도 가능했지만 저장소 안전성 때문에 낮춘 것인지 구분해 둔다.
  // 그래야 운영자에게 "정책 위반"과 "작업 트리가 바뀜"을 뒤섞어 보고하지 않는다.
  let subjectDowngraded = false;

  if (RETRYABLE_ACTIONS.includes(action)) {
    if (!subjectCheck.bound_to) {
      failureClass = 'RECOVERY_AMBIGUOUS';
      action = 'NEEDS_HUMAN';
      subjectDowngraded = true;
      reason = `${reason} The runtime cannot prove which repository state this attempt left behind, so another worker attempt is not provably safe.`;
    } else if (!subjectCheck.matches) {
      failureClass = 'RECOVERY_AMBIGUOUS';
      action = 'NEEDS_HUMAN';
      subjectDowngraded = true;
      reason = `${reason} The working tree has changed since this attempt, so a retry would be layered onto unrelated changes.`;
    }
  }

  return {
    schema: DIAGNOSIS_SCHEMA,
    task_id: task.id,
    run_id: run.runId,
    stage,
    failure_class: failureClass,
    retryable: RETRYABLE_ACTIONS.includes(action),
    recommended_action: action,
    failure_fingerprint: failureFingerprint({
      stage, failureClass, failedGates, failedCriteria, normalizedReason: found.normalized,
    }),
    attempt,
    failed_gates: failedGates,
    failed_criteria: failedCriteria,
    reason,
    source_artifacts: sourceArtifacts,
    evidence_sha256: evidenceFingerprint(runDir),
    subject_check: subjectCheck,
    subject_downgraded: subjectDowngraded,
    // 진단은 결정론적 Runtime 연산이다. 토큰을 쓰지 않는다.
    llm_calls: 0,
    detail: {
      schema_errors: found.schema_errors ?? null,
      failed_criteria_detail: found.failed_criteria ?? [],
      failed_gates_detail: found.failed_gates ?? [],
    },
  };
}

function archivePrior(runDir) {
  const dir = recoveryDir(runDir);
  const movable = [DIAGNOSIS_FILE, 'failure-memo.json'].filter((f) => existsSync(join(dir, f)));
  if (movable.length === 0) return null;
  const historyRoot = join(dir, HISTORY_DIR);
  mkdirSync(historyRoot, { recursive: true });
  let n = 1;
  while (existsSync(join(historyRoot, String(n)))) n += 1;
  mkdirSync(join(historyRoot, String(n)), { recursive: true });
  for (const f of movable) renameSync(join(dir, f), join(historyRoot, String(n), f));
  return `${RECOVERY_DIR}/${HISTORY_DIR}/${n}`;
}

/**
 * 진단을 얻는다. 같은 증거에 대한 진단이 이미 있으면 그것을 그대로 쓴다.
 * 증거가 달라졌으면 다시 계산하고, 이전 것은 지우지 않고 history로 옮긴다.
 * @returns {{ diagnosis: object, reused: boolean, archived: string|null }}
 */
export function getDiagnosis({ task, run, config, subject = null }) {
  const existing = readDiagnosis(run.runDir);
  const fresh = computeDiagnosis({ task, run, config, subject });

  if (existing && !existing.corrupt && existing.evidence_sha256 === fresh.evidence_sha256
      && existing.subject_check?.current === fresh.subject_check?.current) {
    return { diagnosis: existing, reused: true, archived: null };
  }
  const archived = existing ? archivePrior(run.runDir) : null;
  mkdirSync(recoveryDir(run.runDir), { recursive: true });
  const p = diagnosisPath(run.runDir);
  writeFileSync(p, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
  freeze(p);
  return { diagnosis: fresh, reused: false, archived };
}

export { freeze, archivePrior };
