// verifier/result — Verifier Result 계약과 결정론적 검증.
//
// Worker Result와는 다른 계약이다. 전이 요청 필드가 존재하지 않는다 —
// Verifier는 완료를 요청할 수 없고, 상태 결정은 Runtime의 몫이다.
// 잘못된 출력을 추측으로 고치지 않는다. 대화 텍스트를 판정으로 해석하지 않는다.

export const VERIFIER_RESULTS = ['PASS', 'FAIL'];
export const CRITERION_STATUSES = ['PASS', 'FAIL'];

/**
 * PASS의 근거가 될 수 있는 것의 전부. 이 목록에 "worker가 그렇게 말했다"는 없다.
 *
 *   gate                 Runtime이 직접 실행한 결정론적 Gate 결과
 *   runtime_artifact     Runtime이 만든 Run 산출물 (gate 로그 · canonical diff 파일 등)
 *   canonical_diff       Runtime이 만든 변경 매니페스트/패치 자체
 *   repository_content   저장소에 실제로 존재하는 파일의 내용
 *   unwitnessed_claim    이 AC를 만족시키려면 Runtime이 목격하지 못한 실행이 필요하다
 *                        (수동 조작 · 브라우저 · 네트워크 · 외부 서비스 · 실물 렌더링 등)
 *
 * `unwitnessed_claim` 은 PASS의 근거가 될 수 없다. 이것이 이 계약의 핵심 규칙이다.
 */
export const EVIDENCE_BASES = [
  'gate', 'runtime_artifact', 'canonical_diff', 'repository_content', 'unwitnessed_claim',
];

/** 목격되지 않은 실행을 요구하는 주장의 분류. Verifier가 그대로 고른다. */
export const UNWITNESSED_KINDS = [
  'manual_operation', 'browser_session', 'network_access', 'external_service', 'real_world_execution',
];

/** evidence_refs가 반드시 있어야 하는 근거 종류. */
const REFS_REQUIRED = new Set(['runtime_artifact', 'repository_content']);

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
          required: ['id', 'status', 'reason', 'evidence_basis', 'evidence_refs'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: CRITERION_STATUSES },
            reason: { type: 'string' },
            evidence_basis: { type: 'string', enum: EVIDENCE_BASES },
            evidence_refs: { type: 'array', items: { type: 'string' } },
            unwitnessed_kind: { type: 'string', enum: UNWITNESSED_KINDS },
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
 * PASS 근거가 실제로 성립하는지 Runtime 사실과 대조한다.
 *
 * 여기서 하는 일은 "Verifier가 근거라고 말한 것이 존재하는가"의 확인이다.
 * 근거가 존재하지 않으면 그 판정은 서술일 뿐이므로 결과 전체를 무효로 본다.
 *
 * @param {{ gateReport: object|null, diffFileCount: number, refExists: (p: string) => boolean }} facts
 * @returns {string|null} 문제가 있으면 사람이 읽을 수 있는 사유
 */
function checkEvidenceBasis(c, at, facts) {
  const basis = c.evidence_basis;
  const refs = Array.isArray(c.evidence_refs) ? c.evidence_refs.filter(isNonEmptyString) : [];

  // 핵심 규칙 — 목격되지 않은 실행은 PASS의 근거가 될 수 없다.
  if (basis === 'unwitnessed_claim') {
    if (c.status === 'PASS') {
      return `${at}: "${c.id}" is declared unwitnessed_claim`
        + `${isNonEmptyString(c.unwitnessed_kind) ? ` (${c.unwitnessed_kind})` : ''}`
        + ' — a criterion that needs manual, browser, network, external or real-world execution'
        + ' cannot PASS without runtime evidence of that execution';
    }
    return null;   // FAIL/거절은 정상 경로다
  }

  // FAIL 판정에는 근거 존재를 요구하지 않는다. 없다는 것이 곧 실패 사유이기 때문이다.
  if (c.status !== 'PASS') return null;

  if (basis === 'gate') {
    const executed = (facts.gateReport?.gates ?? []).length;
    if (executed === 0) {
      return `${at}: "${c.id}" claims a gate basis but this run executed no gate`;
    }
    return null;
  }
  if (basis === 'canonical_diff') {
    if (facts.diffFileCount <= 0) {
      return `${at}: "${c.id}" claims a canonical_diff basis but the canonical diff is empty`;
    }
    return null;
  }
  if (REFS_REQUIRED.has(basis)) {
    if (refs.length === 0) {
      return `${at}: "${c.id}" claims a ${basis} basis but lists no evidence_refs`;
    }
    const missing = refs.filter((r) => !facts.refExists(r));
    if (missing.length > 0) {
      return `${at}: "${c.id}" cites evidence that does not exist: ${missing.join(', ')}`;
    }
    return null;
  }
  return null;
}

/**
 * @param {{ runId, taskId, subjectSha256, task, evidenceFacts? }} opts
 *   evidenceFacts — Runtime이 아는 사실. 생략하면 근거 존재 확인을 건너뛴다(단위 테스트용).
 * @returns {{ valid: boolean, errors: string[], result: object|null, global_failure: boolean }}
 */
export function validateVerifierResult(raw, { runId, taskId, subjectSha256, task, evidenceFacts = null }) {
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

    // 근거 종류는 선택이 아니다. "무엇이 이것을 증명하는가"를 반드시 고르게 한다.
    if (!isNonEmptyString(c.evidence_basis)) {
      err(`${at}.evidence_basis is required (valid: ${EVIDENCE_BASES.join(', ')})`);
    } else if (!EVIDENCE_BASES.includes(c.evidence_basis)) {
      err(`${at}.evidence_basis "${c.evidence_basis}" is unsupported (valid: ${EVIDENCE_BASES.join(', ')})`);
    }
    if (c.evidence_refs !== undefined && (!Array.isArray(c.evidence_refs) || !c.evidence_refs.every(isNonEmptyString))) {
      err(`${at}.evidence_refs must be an array of non-empty strings`);
    }
    if (c.unwitnessed_kind !== undefined && !UNWITNESSED_KINDS.includes(c.unwitnessed_kind)) {
      err(`${at}.unwitnessed_kind "${c.unwitnessed_kind}" is unsupported (valid: ${UNWITNESSED_KINDS.join(', ')})`);
    }
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

  // 근거 확인. 서술은 근거가 아니다 — Verifier가 지목한 것이 실제로 존재해야 한다.
  const facts = evidenceFacts ?? {
    gateReport: null, diffFileCount: 0, refExists: () => true, skipExistence: true,
  };
  raw.criteria.forEach((c, i) => {
    if (!isPlainObject(c) || !byId.has(c.id)) return;
    if (facts.skipExistence && c.evidence_basis !== 'unwitnessed_claim') return;
    const problem = checkEvidenceBasis(c, `criteria[${i}]`, facts);
    if (problem) err(problem);
  });

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
      criteria: required.map((id) => {
        const c = byId.get(id);
        return {
          id,
          status: c.status,
          reason: c.reason,
          evidence_basis: c.evidence_basis,
          evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs.filter(isNonEmptyString) : [],
          unwitnessed_kind: isNonEmptyString(c.unwitnessed_kind) ? c.unwitnessed_kind : null,
        };
      }),
      failed_criteria: failedFromCriteria,
      // 목격되지 않은 실행을 요구한다고 Verifier가 표시한 AC. Runtime이 그대로 기록한다.
      unwitnessed_criteria: required.filter((id) => byId.get(id).evidence_basis === 'unwitnessed_claim'),
      reason: raw.reason,
    },
  };
}
