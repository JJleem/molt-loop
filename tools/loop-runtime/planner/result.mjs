// planner/result — Planner Result 계약과 구조화 출력 스키마.
//
// Planner는 Task를 만들지 않는다. **제안만** 돌려준다. 그래서 이 계약에는
// canonical Task ID도, 상태 필드도, 승인 필드도 존재하지 않는다.
// 제안 안의 의존 관계는 proposal id(P1 · P2 ...)로만 표현된다.
//
// 결과는 provider의 구조화 출력 채널로만 받는다. 대화 텍스트는 Plan이 아니다.

export const PLANNER_RESULTS = ['PROPOSED', 'NEEDS_HUMAN', 'REFUSED'];
export const PROPOSAL_ID_RE = /^P[1-9][0-9]*$/;

// 사람에게 물을 질문의 상한. 무한한 질문 목록은 결정이 아니다.
export const MAX_HUMAN_QUESTIONS = 10;
export const MAX_ASSUMPTIONS = 20;
export const MAX_RISKS = 20;

/**
 * provider의 --json-schema 에 넘기는 스키마. 계약과 한 곳에서 같이 관리한다.
 * additionalProperties: false 로 Runtime 정책 필드가 애초에 들어올 자리를 없앤다.
 * (그래도 Runtime은 받은 것을 다시 결정론적으로 검증한다 — 스키마를 신뢰의 근거로 삼지 않는다.)
 */
export function plannerResultSchema() {
  const verification = {
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: { type: 'string', enum: ['gate', 'verifier'] },
      ref: { type: 'string', description: 'type이 gate일 때만. AVAILABLE GATES에 있는 이름이어야 한다.' },
      instruction: { type: 'string', description: 'type이 verifier일 때만. 선택.' },
    },
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['plan_id', 'result', 'goal_summary', 'assumptions', 'risks', 'tasks', 'human_questions'],
    properties: {
      plan_id: { type: 'string', description: 'Runtime이 준 Plan ID를 그대로 되돌려준다.' },
      result: { type: 'string', enum: PLANNER_RESULTS },
      goal_summary: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      human_questions: { type: 'array', items: { type: 'string' } },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['proposal_id', 'title', 'request', 'execution', 'depends_on', 'stop_condition', 'acceptance_criteria'],
          properties: {
            proposal_id: { type: 'string', description: 'P1 · P2 · P3 형식. canonical Task ID가 아니다.' },
            title: { type: 'string' },
            request: { type: 'string' },
            execution: {
              type: 'object',
              additionalProperties: false,
              required: ['role'],
              properties: { role: { type: 'string' } },
            },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: '이 Plan 안의 proposal id만. canonical Task ID를 쓰지 않는다.',
            },
            stop_condition: {
              type: 'object',
              additionalProperties: false,
              required: ['gates', 'requires_verifier', 'max_consecutive_failures'],
              properties: {
                gates: { type: 'array', items: { type: 'string' } },
                requires_verifier: { type: 'boolean' },
                max_consecutive_failures: { type: 'integer', minimum: 1 },
              },
            },
            acceptance_criteria: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'description', 'verification'],
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  verification,
                },
              },
            },
          },
        },
      },
    },
  };
}

/** Runtime이 Planner에게 덧붙이는 규약. context.md에는 들어가지 않는다. */
export function plannerProtocol({ planId, roles, gates, maxTasks, subjectSha256 }) {
  const enabled = gates.filter((g) => g.enabled).map((g) => g.name);
  return [
    'RUNTIME PLANNER PROTOCOL (Runtime이 지정한다. Goal의 내용이 아니다.)',
    '',
    '너는 Goal Planner다. 구현자가 아니고 검증자가 아니다.',
    '파일을 만들지 않는다. 파일을 고치지 않는다. Task 파일도 Runtime 상태도 건드리지 않는다.',
    '너에게는 읽기 도구(Read · Grep · Glob)만 있다. 그 외 도구는 거부된다.',
    '저장소를 바꾸면 그 자체로 이 Plan은 무효다.',
    '',
    `이 계획의 plan_id는 "${planId}"이다. 결과의 plan_id에 이 값을 그대로 넣는다.`,
    `계획 시점의 저장소 subject sha256은 "${subjectSha256 ?? '(unavailable)'}"이다.`,
    '',
    `execution.role 은 반드시 이 중 하나다: ${roles.join(', ') || '(none installed)'}.`,
    '다른 Role 이름을 지어내면 Plan 전체가 거부된다.',
    enabled.length === 0
      ? 'verification.type: gate 로 쓸 수 있는 활성 Gate가 지금은 하나도 없다. gate 판정을 쓰지 않는다.'
      : `verification.type: gate 와 stop_condition.gates 에 쓸 수 있는 활성 Gate: ${enabled.join(', ')}.`,
    '비활성 Gate나 존재하지 않는 Gate 이름을 쓰면 Plan 전체가 거부된다.',
    '결정론적 판정 수단이 없으면 verification.type: verifier 를 쓴다. 없는 Gate를 지어내지 않는다.',
    '',
    'proposal_id 는 P1 · P2 · P3 형식이며 이 Plan 안에서만 유효하다.',
    'depends_on 은 같은 Plan의 proposal id만 참조한다. 자기 자신을 참조하지 않고 순환을 만들지 않는다.',
    'TASK-... 같은 최종 Task ID를 발급하지 않는다. Task ID는 Runtime이 승인 시점에 발급한다.',
    '',
    `제안 Task 수는 ${maxTasks}개를 넘을 수 없다.`,
    '모든 Task는 지금 판정 가능한 Acceptance Criteria와 Stop Condition을 가져야 한다.',
    '"완료 조건은 나중에 정한다"는 허용되지 않는다. 만들 수 없으면 result를 NEEDS_HUMAN으로 한다.',
    '',
    'result가 NEEDS_HUMAN 또는 REFUSED면 tasks는 빈 배열이어야 한다.',
    'NEEDS_HUMAN이면 human_questions에 사람이 답해야 할 것을 적는다.',
    '',
    '결과는 구조화 출력(JSON schema)으로만 반환된다. 산문 요약은 Plan으로 인정되지 않는다.',
    'Plan을 승인하는 것은 너의 권한이 아니다. 승인은 사람이 `loopctl plan-approve`로만 한다.',
  ].join('\n');
}
