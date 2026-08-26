// recovery/failure-memo — 실패를 다음 Attempt가 쓸 수 있는 최소한의 lesson으로 증류한다.
//
// Failure Memo는 로그 보관소가 아니라 **항해용 메모**다. 들어가지 않는 것:
//   이전 Worker의 요약·자기평가·narrative · stdout/stderr 전문 · Gate 로그 전문 ·
//   Verifier transcript · 이전 AI 세션 기록
//
// 증거가 없는 recovery hint를 지어내지 않는다. 쓸 만한 lesson을 안전하게 뽑을 수 없으면
// 진단이 NEEDS_HUMAN이 되고 Memo는 만들어지지 않는다.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryDir, freeze } from './diagnose.mjs';

export const MEMO_FILE = 'failure-memo.json';
export const MEMO_SCHEMA = 1;
// 다음 Worker Context로 들어가는 로그 발췌의 상한. 로그 전문은 Run artifact에 그대로 남아 있다.
export const STDERR_EXCERPT_LIMIT = 2048;
export const MAX_EXCERPT_LINES = 20;

const memoPath = (runDir) => join(recoveryDir(runDir), MEMO_FILE);

export function readFailureMemo(runDir) {
  const p = memoPath(runDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { corrupt: true }; }
}

/** 로그의 마지막 의미 있는 줄만 유계로 잘라 온다. 메가바이트를 Context에 넣지 않는다. */
export function boundedExcerpt(path, limit = STDERR_EXCERPT_LIMIT) {
  if (!existsSync(path)) return null;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  const tail = lines.slice(-MAX_EXCERPT_LINES);
  let out = tail.join('\n');
  if (Buffer.byteLength(out, 'utf8') > limit) {
    out = `...(truncated)\n${out.slice(-limit)}`;
  }
  return out;
}

/** 진단 결과별로 evidence에 근거한 lesson과 hint를 만든다. 근거 없는 문장은 만들지 않는다. */
function distill({ diagnosis, runDir }) {
  const d = diagnosis;
  switch (d.failure_class) {
    case 'GATE_FAILURE': {
      const gates = d.failed_gates.map((g) => {
        const excerpt = boundedExcerpt(join(runDir, 'gates', g.name, 'stderr.log'))
          ?? boundedExcerpt(join(runDir, 'gates', g.name, 'stdout.log'));
        return { ...g, stderr_excerpt: excerpt };
      });
      const names = gates.map((g) => g.name).join(', ');
      return {
        lesson: `Attempt ${d.attempt} did not pass the deterministic gate(s): ${gates.map((g) => `${g.name} exited ${g.exit_code}`).join(', ')}.`,
        recovery_hint: `Run the ${names} gate command locally, read the failure output, and fix the cause before returning. `
          + 'Do not delete, skip, or weaken tests to make the gate pass.',
        failed_gates: gates,
        failed_criteria: [],
      };
    }
    case 'VERIFY_FAILED': {
      const criteria = (d.detail?.failed_criteria_detail ?? []).map((c) => ({
        id: c.id,
        reason: (c.reason ?? '').trim(),
      }));
      if (criteria.length === 0) {
        return {
          lesson: `Attempt ${d.attempt} was rejected by the independent verifier for a global reason: ${d.reason}`,
          recovery_hint: 'Re-read the acceptance criteria and the task scope, and address the stated problem.',
          failed_gates: [],
          failed_criteria: [],
        };
      }
      return {
        lesson: `Attempt ${d.attempt} passed the gates but the independent verifier found ${criteria.map((c) => c.id).join(', ')} unsatisfied.`,
        recovery_hint: 'Implement what each criterion below actually requires and make it visible in the diff. '
          + 'The acceptance criteria are unchanged — do not reinterpret them.',
        failed_gates: [],
        failed_criteria: criteria,
      };
    }
    case 'SCHEMA_FAILURE': {
      const errs = d.detail?.schema_errors ?? [];
      return {
        lesson: `Attempt ${d.attempt} did not produce a valid Worker Result: ${errs.join('; ') || 'the result file was missing.'}`,
        recovery_hint: 'Do the work, then write exactly one Worker Result JSON to the path the runtime protocol specifies, '
          + 'with the run_id and task_id it gave you. Conversational output is not a result.',
        failed_gates: [],
        failed_criteria: [],
      };
    }
    case 'TIMEOUT':
      return {
        lesson: `Attempt ${d.attempt} exceeded the worker timeout and was killed before producing a result.`,
        recovery_hint: 'Spend less time exploring. Decide on the smallest change that satisfies the acceptance criteria, '
          + 'make it, and write the result file early rather than at the very end.',
        failed_gates: [],
        failed_criteria: [],
      };
    case 'PROCESS_CRASH':
      return {
        // 이 실패에는 구현에 대한 lesson이 없다. 없는 교훈을 지어내지 않는다.
        lesson: `Attempt ${d.attempt} ended because the worker process terminated abnormally (${d.reason}). `
          + 'No conclusion about the implementation can be drawn from this.',
        recovery_hint: null,
        failed_gates: [],
        failed_criteria: [],
      };
    default:
      return null;
  }
}

/**
 * 진단으로부터 Failure Memo를 만들거나 이미 있는 것을 재사용한다.
 * 재시도 가능한 실패에 대해서만 만든다.
 * @returns {{ memo: object|null, reused: boolean, reason?: string }}
 */
export function getFailureMemo({ diagnosis, run }) {
  if (!diagnosis.retryable) {
    return { memo: null, reused: false, reason: `recommended action is ${diagnosis.recommended_action}` };
  }
  const existing = readFailureMemo(run.runDir);
  if (existing && !existing.corrupt && existing.failure_fingerprint === diagnosis.failure_fingerprint) {
    return { memo: existing, reused: true };
  }

  const distilled = distill({ diagnosis, runDir: run.runDir });
  if (!distilled) {
    return { memo: null, reused: false, reason: `no safe lesson can be distilled from ${diagnosis.failure_class}` };
  }

  const memo = {
    schema: MEMO_SCHEMA,
    source_run_id: run.runId,
    attempt: diagnosis.attempt,
    stage: diagnosis.stage,
    failure_class: diagnosis.failure_class,
    lesson: distilled.lesson,
    recovery_hint: distilled.recovery_hint,
    failed_gates: distilled.failed_gates,
    failed_criteria: distilled.failed_criteria,
    evidence_refs: diagnosis.source_artifacts,
    failure_fingerprint: diagnosis.failure_fingerprint,
  };
  mkdirSync(recoveryDir(run.runDir), { recursive: true });
  const p = memoPath(run.runDir);
  writeFileSync(p, `${JSON.stringify(memo, null, 2)}\n`, 'utf8');
  freeze(p);
  return { memo, reused: false };
}

export { memoPath };
