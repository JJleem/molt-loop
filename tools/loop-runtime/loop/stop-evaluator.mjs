// loop/stop-evaluator — 계속할지 멈출지를 한 곳에서 판단한다.
//
// 정지 규칙을 CLI 여기저기에 흩지 않는다. 이 함수가 나중에 governance의 토대가 된다.
// 판단은 전부 결정론적이다. "재시도할까요?"를 모델에게 묻지 않는다.

import { isPaused } from '../task-store.mjs';

/** next-action의 STOP_* 를 실행 결과로 옮기는 표. */
const STOP_RESULT = {
  STOP_BLOCKED: { result: 'BLOCKED', reason: 'TASK_BLOCKED' },
  STOP_NEEDS_HUMAN: { result: 'NEEDS_HUMAN', reason: 'NEEDS_HUMAN' },
  STOP_LIMIT: { result: 'LIMIT_REACHED', reason: 'RETRY_BUDGET_EXHAUSTED' },
  STOP_STALLED: { result: 'STALLED', reason: 'REPEATED_IDENTICAL_FAILURE' },
  STOP_AMBIGUOUS: { result: 'NEEDS_HUMAN', reason: 'RECOVERY_AMBIGUOUS' },
  STOP_REFUSED: { result: 'FAILED', reason: 'TASK_NOT_EXECUTABLE' },
};

/**
 * 한 단계가 끝날 때마다 호출한다.
 * @returns {{ stop: true, result, reason, detail? } | { stop: false }}
 */
export function evaluateStop({ next, interrupted, deadlineExceeded, guardExceeded }) {
  // 운영자 개입이 가장 우선한다. 새 단계를 시작하지 않는다.
  if (interrupted) return { stop: true, result: 'INTERRUPTED', reason: 'OPERATOR_INTERRUPT' };
  if (guardExceeded) return { stop: true, result: 'FAILED', reason: 'RUNTIME_LOOP_GUARD_EXCEEDED' };
  if (deadlineExceeded) return { stop: true, result: 'LIMIT_REACHED', reason: 'ORCHESTRATION_TIMEOUT' };
  // PAUSE가 도중에 켜지면 다음 유료/부작용 단계를 시작하지 않는다.
  if (isPaused()) return { stop: true, result: 'NEEDS_HUMAN', reason: 'PAUSE_ACTIVE' };

  if (next.action === 'DONE') return { stop: true, result: 'DONE', reason: 'TASK_DONE' };

  const mapped = STOP_RESULT[next.action];
  if (mapped) return { stop: true, ...mapped, detail: next.reason };

  return { stop: false };
}

/**
 * 상태 해석에 버그가 있어도 무한히 돌지 않도록 하는 독립 안전장치.
 * 재시도 정책이 아니라 마지막 방어선이다.
 */
export function loopGuardLimit(config) {
  const attempts = config.limits.max_attempts;
  // Attempt 하나가 쓸 수 있는 단계: worker · gate · verifier · retry 준비 + 여유
  return attempts * 6 + 10;
}

export { STOP_RESULT };
