// result — Worker Result 계약. Worker의 출력은 신뢰하지 않고 결정론적으로 검증한다.
//
// Worker Result는 "주장"이다. Runtime이 관찰한 사실은 Runtime Envelope에 따로 기록한다.

import { WORKER_REQUESTABLE } from '../transitions.mjs';

export const OUTCOMES = ['success', 'blocked', 'failed'];

// outcome별로 허용되는 requested_transition. DONE은 어떤 경우에도 Worker가 요청할 수 없다.
const EXPECTED_TRANSITION = {
  success: ['REVIEW'],
  blocked: ['BLOCKED'],
  failed: [null],
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Worker Result를 검증한다.
 * @returns {{ valid: boolean, errors: string[], result: object|null }}
 */
export function validateWorkerResult(raw, { runId, taskId }) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['worker result must be a JSON object'], result: null };
  }

  if (raw.run_id !== runId) err(`run_id mismatch: expected "${runId}", got ${JSON.stringify(raw.run_id)}`);
  if (raw.task_id !== taskId) err(`task_id mismatch: expected "${taskId}", got ${JSON.stringify(raw.task_id)}`);

  if (!isNonEmptyString(raw.outcome)) {
    err('outcome is required');
  } else if (!OUTCOMES.includes(raw.outcome)) {
    err(`unsupported outcome "${raw.outcome}" (valid: ${OUTCOMES.join(', ')})`);
  }

  if (!isNonEmptyString(raw.summary)) err('summary is required and must be a non-empty string');

  if (!Array.isArray(raw.changed_files)) {
    err('changed_files must be an array');
  } else if (!raw.changed_files.every(isNonEmptyString)) {
    err('changed_files must contain only non-empty strings');
  }

  if (!Array.isArray(raw.evidence)) {
    err('evidence must be an array');
  } else {
    raw.evidence.forEach((e, i) => {
      if (!isPlainObject(e)) return err(`evidence[${i}] must be an object with kind and path`);
      if (!isNonEmptyString(e.kind)) err(`evidence[${i}].kind is required`);
      if (!isNonEmptyString(e.path)) err(`evidence[${i}].path is required`);
    });
  }

  const rt = raw.requested_transition ?? null;
  if (rt !== null) {
    if (!isNonEmptyString(rt)) {
      err('requested_transition must be a string or null');
    } else if (rt === 'DONE') {
      // 종료는 Verifier가 결정한다. Worker는 완료를 선언할 수 없다.
      err('requested_transition "DONE" is never allowed for a worker');
    } else if (!WORKER_REQUESTABLE.includes(rt)) {
      err(`requested_transition "${rt}" is not worker-requestable (allowed: ${WORKER_REQUESTABLE.join(', ')}, or null)`);
    }
  }

  if (isNonEmptyString(raw.outcome) && OUTCOMES.includes(raw.outcome) && errors.length === 0) {
    const expected = EXPECTED_TRANSITION[raw.outcome];
    if (!expected.includes(rt)) {
      const shown = expected.map((v) => (v === null ? 'null' : v)).join(' | ');
      err(`outcome "${raw.outcome}" requires requested_transition ${shown}, got ${rt === null ? 'null' : `"${rt}"`}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors, result: null };

  return {
    valid: true,
    errors: [],
    result: {
      run_id: raw.run_id,
      task_id: raw.task_id,
      outcome: raw.outcome,
      summary: raw.summary,
      changed_files: raw.changed_files,
      evidence: raw.evidence,
      requested_transition: rt,
      notes: isNonEmptyString(raw.notes) ? raw.notes : null,
    },
  };
}
