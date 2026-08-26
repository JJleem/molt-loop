// planner/validator — Planner Result에 대한 결정론적 검증. **LLM을 호출하지 않는다.**
//
// Planner의 "이 계획은 유효하다"는 선언은 근거가 아니다. 유효성은 Runtime이 정한다.
// Task 스키마 검증은 기존 validateTask()를 그대로 쓴다 — Planner 전용 완화 경로를 만들지 않는다.
// 잘못된 Plan을 추측으로 고치지 않는다. 거부한다.

import { validateTask, executionRoles } from '../task-store.mjs';
import { loadGateConfig } from '../gate/resolver.mjs';
import {
  PLANNER_RESULTS, PROPOSAL_ID_RE, MAX_HUMAN_QUESTIONS, MAX_ASSUMPTIONS, MAX_RISKS,
} from './result.mjs';
import { validateProposalGraph } from './graph.mjs';
import { normalizeText } from './task-yaml.mjs';

const TOP_LEVEL_KEYS = new Set([
  'plan_id', 'result', 'goal_summary', 'assumptions', 'risks', 'tasks', 'human_questions',
]);
const TASK_KEYS = new Set([
  'proposal_id', 'title', 'request', 'execution', 'depends_on', 'stop_condition', 'acceptance_criteria',
]);

// Planner가 절대 건드릴 수 없는 것들. 이런 필드가 보이면 그 자체로 정책 위반이다.
export const FORBIDDEN_KEYS = [
  'approved', 'approve', 'status', 'task_id', 'id',
  'max_attempts', 'retry_max', 'hint_retry_max', 'budget', 'max_cost_usd',
  'adapter', 'provider', 'model', 'permissions', 'policies', 'kernel',
  'gates_config', 'gate_command', 'command', 'auto_dispatch', 'example',
];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 승인 시점에 파일로 쓰게 될 Task 본문. 검증과 생성이 **같은 함수**를 쓴다.
 *
 * 자유 서술 필드는 여기서 한 번만 정규화한다(tab -> 공백, 제어문자 제거).
 * 정규화를 직렬화 단계에 미루면 검증한 값과 파일에 적히는 값이 달라진다.
 */
export function materializedTaskData(proposal, { id, dependsOn = [] }) {
  const data = {
    id,
    status: 'TODO',
    request: normalizeText(proposal.request).trim(),
    execution: { role: proposal.execution.role },
    stop_condition: {
      gates: [...proposal.stop_condition.gates],
      requires_verifier: proposal.stop_condition.requires_verifier,
      max_consecutive_failures: proposal.stop_condition.max_consecutive_failures,
    },
    acceptance_criteria: proposal.acceptance_criteria.map((ac) => {
      const v = { type: ac.verification.type };
      if (ac.verification.type === 'gate') v.ref = ac.verification.ref;
      else if (isNonEmptyString(ac.verification.instruction)) v.instruction = normalizeText(ac.verification.instruction).trim();
      return { id: ac.id, description: normalizeText(ac.description).trim(), verification: v };
    }),
    evidence: [],
    failure_memo: [],
  };
  if (dependsOn.length > 0) data.depends_on = [...dependsOn];
  return data;
}

/** Task가 참조하는 Gate 이름의 합집합 (stop_condition + gate 타입 AC). */
function referencedGates(taskData) {
  const names = [];
  const add = (n) => { if (!names.includes(n)) names.push(n); };
  for (const g of taskData.stop_condition.gates) add(g);
  for (const ac of taskData.acceptance_criteria) {
    if (ac.verification?.type === 'gate' && isNonEmptyString(ac.verification.ref)) add(ac.verification.ref);
  }
  return names;
}

/**
 * Planner Result 하나를 검증한다.
 *
 * @param {object} raw               Planner가 구조화 출력으로 돌려준 것 (정규화 전)
 * @param {object} ctx
 * @param {string} ctx.planId        Runtime이 발급한 Plan ID
 * @param {object} ctx.config        loadConfig() 결과
 * @param {object[]} ctx.existingTasks loadAllTasks() 결과
 * @returns {{ valid, errors, warnings, result: object|null, order: string[] }}
 */
export function validatePlannerResult(raw, { planId, config, existingTasks = [] }) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['planner result must be a JSON object'], warnings, result: null, order: [] };
  }

  for (const key of Object.keys(raw)) {
    if (TOP_LEVEL_KEYS.has(key)) continue;
    if (FORBIDDEN_KEYS.includes(key)) err(`forbidden field "${key}" — the planner cannot set runtime policy or approval state`);
    else err(`unknown field "${key}"`);
  }

  if (raw.plan_id !== planId) {
    err(`plan_id mismatch: expected "${planId}", got ${JSON.stringify(raw.plan_id)}`);
  }
  if (!isNonEmptyString(raw.result)) err('result is required');
  else if (!PLANNER_RESULTS.includes(raw.result)) {
    err(`unsupported result "${raw.result}" (valid: ${PLANNER_RESULTS.join(', ')})`);
  }
  if (!isNonEmptyString(raw.goal_summary)) err('goal_summary is required and must be a non-empty string');

  const stringList = (value, label, max) => {
    if (!Array.isArray(value)) { err(`${label} must be an array of strings`); return []; }
    if (value.length > max) err(`${label} has ${value.length} entries (max ${max})`);
    value.forEach((v, i) => { if (!isNonEmptyString(v)) err(`${label}[${i}] must be a non-empty string`); });
    return value.filter(isNonEmptyString).map((v) => v.trim());
  };
  const assumptions = stringList(raw.assumptions ?? [], 'assumptions', MAX_ASSUMPTIONS);
  const risks = stringList(raw.risks ?? [], 'risks', MAX_RISKS);
  const humanQuestions = stringList(raw.human_questions ?? [], 'human_questions', MAX_HUMAN_QUESTIONS);

  if (!Array.isArray(raw.tasks)) {
    err('tasks must be an array');
    return { valid: false, errors, warnings, result: null, order: [] };
  }

  // 결과 상태와 Task 목록의 정합성 — 상태를 산문으로 해석하지 않는다.
  if (raw.result === 'PROPOSED' && raw.tasks.length === 0) {
    err('result "PROPOSED" requires at least one proposed task');
  }
  if ((raw.result === 'NEEDS_HUMAN' || raw.result === 'REFUSED') && raw.tasks.length > 0) {
    err(`result "${raw.result}" must not propose tasks (got ${raw.tasks.length})`);
  }
  if (raw.result === 'NEEDS_HUMAN' && humanQuestions.length === 0) {
    err('result "NEEDS_HUMAN" requires at least one entry in human_questions');
  }

  const maxTasks = config.limits.max_tasks_per_plan;
  if (raw.tasks.length > maxTasks) {
    err(`too many proposed tasks: ${raw.tasks.length} (max ${maxTasks} from policies/limits.yaml planning.max_tasks_per_plan)`);
  }

  const gateConfig = loadGateConfig(config);
  for (const e of gateConfig.errors) err(`gate configuration is broken, refusing to validate the plan: ${e}`);
  const roles = executionRoles();
  const existingIds = new Set(existingTasks.map((t) => t.id));

  const seenProposals = new Set();
  const normalized = [];

  raw.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!isPlainObject(t)) return err(`${at} must be an object`);
    for (const key of Object.keys(t)) {
      if (TASK_KEYS.has(key)) continue;
      if (FORBIDDEN_KEYS.includes(key)) err(`${at}: forbidden field "${key}" — the planner does not own task state or runtime policy`);
      else err(`${at}: unknown field "${key}"`);
    }

    const pid = t.proposal_id;
    const label = isNonEmptyString(pid) ? pid : at;
    if (!isNonEmptyString(pid)) {
      err(`${at}.proposal_id is required`);
    } else if (!PROPOSAL_ID_RE.test(pid)) {
      err(`${at}: proposal_id "${pid}" must look like P1, P2, P3 (canonical task ids are allocated by the runtime)`);
    } else if (seenProposals.has(pid)) {
      err(`${at}: duplicate proposal_id "${pid}"`);
    } else if (existingIds.has(pid)) {
      err(`${at}: proposal_id "${pid}" collides with an existing task id`);
    }
    if (isNonEmptyString(pid)) seenProposals.add(pid);

    if (!isNonEmptyString(t.title)) err(`${label}: title is required`);
    if (!isNonEmptyString(t.request)) err(`${label}: request is required`);

    // Role은 실제로 설치된 실행 Role이어야 한다. verifier/planner는 실행 Role이 아니다.
    const role = isPlainObject(t.execution) ? t.execution.role : undefined;
    if (!isPlainObject(t.execution)) {
      err(`${label}: execution must be an object with a role`);
    } else if (!isNonEmptyString(role)) {
      err(`${label}: execution.role is required`);
    } else if (!roles.includes(role)) {
      err(`${label}: unknown execution role "${role}" (installed: ${roles.join(', ') || 'none'})`);
    }

    // 여기서는 Task 하나의 구조만 본다. 스키마 판단은 기존 validateTask에 맡긴다.
    const structurallyRenderable = isNonEmptyString(t.request)
      && isPlainObject(t.execution) && isNonEmptyString(role)
      && isPlainObject(t.stop_condition) && Array.isArray(t.stop_condition.gates)
      && Array.isArray(t.acceptance_criteria)
      && t.acceptance_criteria.every((ac) => isPlainObject(ac) && isPlainObject(ac.verification));
    if (!structurallyRenderable) {
      if (!isPlainObject(t.stop_condition)) err(`${label}: stop_condition is required and must be an object`);
      else if (!Array.isArray(t.stop_condition.gates)) err(`${label}: stop_condition.gates must be an array`);
      if (!Array.isArray(t.acceptance_criteria)) err(`${label}: acceptance_criteria must be an array`);
      else {
        t.acceptance_criteria.forEach((ac, k) => {
          if (!isPlainObject(ac)) err(`${label}.acceptance_criteria[${k}] must be an object`);
          else if (!isPlainObject(ac.verification)) err(`${label}.acceptance_criteria[${k}].verification is required`);
        });
      }
      return;
    }

    // Plan 시점에는 canonical id가 없다. 구조 검증만을 위한 자리표시자를 쓴다.
    const placeholder = `TASK-PROPOSAL-${isNonEmptyString(pid) ? pid : i + 1}`;
    const data = materializedTaskData(t, { id: placeholder, dependsOn: [] });
    for (const e of validateTask(data, label)) {
      err(e.replace(placeholder, label));
    }

    // Gate 참조는 설정에 실제로 있고 **활성**이어야 한다.
    // 비활성 Gate에 걸린 Task는 승인 즉시 실행 불가능한 Task가 된다.
    for (const name of referencedGates(data)) {
      const g = gateConfig.gates[name];
      if (!g) {
        err(`${label}: unknown gate "${name}" (configured: ${gateConfig.names.join(', ') || 'none'})`);
      } else if (!g.enabled) {
        err(`${label}: gate "${name}" is disabled${g.reason ? ` (${g.reason})` : ''} — a plan cannot depend on a gate that cannot run`);
      }
    }

    if (t.acceptance_criteria.length === 0) {
      err(`${label}: at least one acceptance criterion is required — a task without a judgeable completion condition cannot be approved`);
    }

    if (!Array.isArray(t.depends_on)) err(`${label}: depends_on must be an array (use [] when there is no prerequisite)`);

    normalized.push({
      proposal_id: pid,
      title: isNonEmptyString(t.title) ? t.title.trim() : '',
      request: data.request,
      execution: data.execution,
      depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
      stop_condition: data.stop_condition,
      acceptance_criteria: data.acceptance_criteria,
    });
  });

  // 의존 그래프는 모든 제안 id를 알아야 판단할 수 있다 — 개별 Task 검증 다음에 온다.
  let order = [];
  if (normalized.length === raw.tasks.length && errors.length === 0) {
    const graph = validateProposalGraph(normalized);
    errors.push(...graph.errors);
    order = graph.order;
  }

  // 비치명적 경고 — 결정론적으로 지지되는 것만. LLM으로 중복을 판단하지 않는다.
  for (const t of normalized) {
    const dup = existingTasks.find(
      (x) => x.data && !['DONE', 'DROPPED'].includes(x.data.status)
        && typeof x.data.request === 'string'
        && x.data.request.trim().toLowerCase() === t.request.trim().toLowerCase()
    );
    if (dup) warnings.push(`${t.proposal_id}: request is identical to unfinished ${dup.id} — possible overlap`);
  }

  if (errors.length > 0) return { valid: false, errors, warnings, result: null, order: [] };

  return {
    valid: true,
    errors: [],
    warnings,
    order,
    result: {
      plan_id: planId,
      result: raw.result,
      goal_summary: raw.goal_summary.trim(),
      assumptions,
      risks,
      human_questions: humanQuestions,
      tasks: normalized,
    },
  };
}
