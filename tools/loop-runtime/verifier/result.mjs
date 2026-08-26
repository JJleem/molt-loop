// verifier/result — Verifier Result 계약과 결정론적 검증.
//
// Worker Result와는 다른 계약이다. 전이 요청 필드가 존재하지 않는다 —
// Verifier는 완료를 요청할 수 없고, 상태 결정은 Runtime의 몫이다.
// 잘못된 출력을 추측으로 고치지 않는다. 대화 텍스트를 판정으로 해석하지 않는다.

export const VERIFIER_RESULTS = ['PASS', 'FAIL'];
export const CRITERION_STATUSES = ['PASS', 'FAIL'];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** CLI의 구조화 출력(--json-schema)에 넘기는 스키마. 계약과 한 곳에서 같이 관리한다. */
export function verifierResultSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['run_id', 'task_id', 'verification_subject_sha256', 'result', 'criteria', 'failed_criteria', 'reason'],
    properties: {
      run_id: { type: 'string' },
      task_id: { type: 'string' },
      verification_subject_sha256: { type: 'string' },
      result: { type: 'string', enum: VERIFIER_RESULTS },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'reason'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: CRITERION_STATUSES },
            reason: { type: 'string' },
          },
        },
      },
      failed_criteria: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
  };
}

/** 이 Task에서 Verifier가 판정해야 하는 AC id (선언 순서 유지). */
export function verifierCriterionIds(task) {
  return task.data.acceptance_criteria
    .filter((ac) => ac.verification.type === 'verifier')
    .map((ac) => ac.id);
}

/** 결정론적 Gate가 판정하는 AC id — Verifier가 이것을 자기 판정으로 주장하면 거부한다. */
export function gateCriterionIds(task) {
  return task.data.acceptance_criteria
    .filter((ac) => ac.verification.type === 'gate')
    .map((ac) => ac.id);
}

/**
 * @returns {{ valid: boolean, errors: string[], result: object|null, global_failure: boolean }}
 */
export function validateVerifierResult(raw, { runId, taskId, subjectSha256, task }) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['verifier result must be a JSON object'], result: null, global_failure: false };
  }

  if (raw.run_id !== runId) err(`run_id mismatch: expected "${runId}", got ${JSON.stringify(raw.run_id)}`);
  if (raw.task_id !== taskId) err(`task_id mismatch: expected "${taskId}", got ${JSON.stringify(raw.task_id)}`);
  if (raw.verification_subject_sha256 !== subjectSha256) {
    err(`verification_subject_sha256 mismatch: the verifier did not judge the subject it was given`);
  }

  if (!isNonEmptyString(raw.result)) err('result is required');
  else if (!VERIFIER_RESULTS.includes(raw.result)) {
    err(`unsupported result "${raw.result}" (valid: ${VERIFIER_RESULTS.join(', ')})`);
  }

  if (!isNonEmptyString(raw.reason)) err('reason is required and must be a non-empty string');

  const required = verifierCriterionIds(task);
  const gateOwned = new Set(gateCriterionIds(task));

  if (!Array.isArray(raw.criteria)) {
    err('criteria must be an array');
    return { valid: false, errors, result: null, global_failure: false };
  }

  const seen = new Set();
  const byId = new Map();
  raw.criteria.forEach((c, i) => {
    const at = `criteria[${i}]`;
    if (!isPlainObject(c)) return err(`${at} must be an object with id, status, reason`);
    if (!isNonEmptyString(c.id)) return err(`${at}.id is required`);
    if (seen.has(c.id)) err(`${at}: duplicate criterion "${c.id}"`);
    seen.add(c.id);
    if (gateOwned.has(c.id)) {
      // Gate가 결정론적으로 판정한 것을 LLM이 다시 주장하게 두지 않는다.
      err(`${at}: "${c.id}" is a gate criterion and is decided deterministically; the verifier must not judge it`);
    } else if (!required.includes(c.id)) {
      err(`${at}: unknown criterion "${c.id}" (this task's verifier criteria: ${required.join(', ') || 'none'})`);
    }
    if (!isNonEmptyString(c.status)) err(`${at}.status is required`);
    else if (!CRITERION_STATUSES.includes(c.status)) {
      err(`${at}.status "${c.status}" is unsupported (valid: ${CRITERION_STATUSES.join(', ')})`);
    }
    if (!isNonEmptyString(c.reason)) err(`${at}.reason is required and must be a non-empty string`);
    byId.set(c.id, c);
  });

  for (const id of required) {
    if (!seen.has(id)) err(`missing verifier criterion "${id}" — every verifier-type acceptance criterion must be judged`);
  }

  if (!Array.isArray(raw.failed_criteria) || !raw.failed_criteria.every(isNonEmptyString)) {
    err('failed_criteria must be an array of non-empty strings');
  }

  if (errors.length > 0) return { valid: false, errors, result: null, global_failure: false };

  const failedFromCriteria = required.filter((id) => byId.get(id).status === 'FAIL');
  const declaredFailed = [...raw.failed_criteria].sort();
  if (JSON.stringify(declaredFailed) !== JSON.stringify([...failedFromCriteria].sort())) {
    err(`failed_criteria ${JSON.stringify(raw.failed_criteria)} does not match the FAIL entries in criteria[] ${JSON.stringify(failedFromCriteria)}`);
  }

  if (raw.result === 'PASS' && failedFromCriteria.length > 0) {
    err(`result "PASS" contradicts failed criteria ${failedFromCriteria.join(', ')}`);
  }

  // FAIL인데 개별 AC는 전부 PASS인 경우 — 범위 밖 변경·테스트 약화 같은 전역 사유만 인정한다.
  // reason은 위에서 이미 필수이므로, 여기서는 그 사실을 기록만 한다.
  const globalFailure = raw.result === 'FAIL' && failedFromCriteria.length === 0;

  if (errors.length > 0) return { valid: false, errors, result: null, global_failure: false };

  return {
    valid: true,
    errors: [],
    global_failure: globalFailure,
    result: {
      run_id: raw.run_id,
      task_id: raw.task_id,
      verification_subject_sha256: raw.verification_subject_sha256,
      result: raw.result,
      criteria: required.map((id) => ({
        id,
        status: byId.get(id).status,
        reason: byId.get(id).reason,
      })),
      failed_criteria: failedFromCriteria,
      reason: raw.reason,
    },
  };
}
