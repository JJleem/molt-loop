// transitions — V0 Task 상태 기계. 여기 없는 전이는 존재하지 않는다.
//
// 상태 변경은 Runtime만 수행한다(Single Writer). Worker/Verifier는 이 표를 우회할 수 없다.

export const STATES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'BLOCKED', 'DROPPED'];

// from -> 허용되는 to 목록. DONE과 DROPPED는 종단 상태다.
export const TRANSITIONS = {
  TODO: ['IN_PROGRESS', 'BLOCKED', 'DROPPED'],
  IN_PROGRESS: ['REVIEW', 'BLOCKED', 'TODO'],
  REVIEW: ['DONE', 'IN_PROGRESS', 'BLOCKED'],
  BLOCKED: ['TODO', 'DROPPED'],
  DONE: [],
  DROPPED: [],
};

// Worker가 Result로 요청할 수 있는 전이. 요청일 뿐이며 실제 적용은 Runtime이 결정한다.
export const WORKER_REQUESTABLE = ['REVIEW', 'BLOCKED'];

export function isState(s) {
  return STATES.includes(s);
}

/** @returns {{allowed: true} | {allowed: false, reason: string}} */
export function checkTransition(from, to) {
  if (!isState(from)) return { allowed: false, reason: `unknown current state "${from}"` };
  if (!isState(to)) {
    return { allowed: false, reason: `unknown target state "${to}" (valid: ${STATES.join(', ')})` };
  }
  if (from === to) return { allowed: false, reason: `already in ${from}` };
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const hint = allowed.length === 0 ? `${from} is terminal` : `allowed from ${from}: ${allowed.join(', ')}`;
    return { allowed: false, reason: hint };
  }
  return { allowed: true };
}
