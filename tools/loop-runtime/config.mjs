// config — .loop/project.yaml 읽기. 값이 없으면 기본값을 쓰되, 잘못된 값은 조용히 고치지 않는다.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml-lite.mjs';
import { LOOP_DIR } from './task-store.mjs';
import { efficiencyConfig } from './efficiency.mjs';

export const PROJECT_YAML = join(LOOP_DIR, 'project.yaml');
// 정지·에스컬레이션 정책의 유일한 출처. project.yaml에 중복해서 두지 않는다.
export const LIMITS_YAML = join(LOOP_DIR, 'policies', 'limits.yaml');

/**
 * Triage — 사람 대신 먼저 보는 판단 역할의 한도. 완료를 선언할 수 없고, 메뉴에서만 고른다.
 * 여기 숫자는 "판단 예산"이다. 결정론적 재시도 사다리(stop/escalation)와는 별개로 센다.
 */
const TRIAGE_DEFAULTS = {
  enabled: true,
  max_decisions_per_task: 2,
  max_retries_per_task: 1,
  max_replans_per_plan: 1,
  max_answers_per_plan: 1,
};

const LIMIT_DEFAULTS = {
  max_attempts: 3,
  max_consecutive_failures: 2,
  retry_max: 1,
  hint_retry_max: 1,
  max_tasks_per_plan: 12,
};

const posInt = (v, label) => {
  if (!Number.isInteger(v) || v < 0) throw new Error(`limits.yaml: ${label} must be an integer >= 0`);
  return v;
};

/**
 * .loop/policies/limits.yaml 을 읽는다. 파일이 없으면 기본값을 쓰되 값이 잘못되면 조용히 고치지 않는다.
 * escalation.retry_max / hint_retry_max 는 사다리다: 평범한 재시도 1회 + hint 재시도 1회 -> needs-human.
 */
function loadLimits() {
  if (!existsSync(LIMITS_YAML)) return { ...LIMIT_DEFAULTS, triage: { ...TRIAGE_DEFAULTS, enabled: false, source: 'absent' }, source: 'defaults' };
  const raw = parseYaml(readFileSync(LIMITS_YAML, 'utf8')) ?? {};
  const stop = raw.stop ?? {};
  const esc = raw.escalation ?? {};
  const planning = raw.planning ?? {};
  const maxTasks = planning.max_tasks_per_plan ?? LIMIT_DEFAULTS.max_tasks_per_plan;
  if (!Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new Error('limits.yaml: planning.max_tasks_per_plan must be an integer >= 1');
  }
  const triageRaw = raw.triage;
  let triage;
  if (triageRaw === undefined || triageRaw === null) {
    // 섹션이 없으면 꺼진 것이다 — 이전 프로젝트의 정지 동작을 바꾸지 않는다. Starter는 켜 둔다.
    triage = { ...TRIAGE_DEFAULTS, enabled: false, source: 'absent' };
  } else {
    if (typeof triageRaw !== 'object' || Array.isArray(triageRaw)) throw new Error('limits.yaml: triage must be a mapping');
    const enabled = triageRaw.enabled ?? TRIAGE_DEFAULTS.enabled;
    if (typeof enabled !== 'boolean') throw new Error('limits.yaml: triage.enabled must be boolean');
    triage = {
      enabled,
      max_decisions_per_task: posInt(triageRaw.max_decisions_per_task ?? TRIAGE_DEFAULTS.max_decisions_per_task, 'triage.max_decisions_per_task'),
      max_retries_per_task: posInt(triageRaw.max_retries_per_task ?? TRIAGE_DEFAULTS.max_retries_per_task, 'triage.max_retries_per_task'),
      max_replans_per_plan: posInt(triageRaw.max_replans_per_plan ?? TRIAGE_DEFAULTS.max_replans_per_plan, 'triage.max_replans_per_plan'),
      max_answers_per_plan: posInt(triageRaw.max_answers_per_plan ?? TRIAGE_DEFAULTS.max_answers_per_plan, 'triage.max_answers_per_plan'),
      source: 'policies/limits.yaml',
    };
  }
  return {
    triage,
    max_attempts: posInt(stop.max_attempts ?? LIMIT_DEFAULTS.max_attempts, 'stop.max_attempts'),
    max_consecutive_failures: posInt(stop.max_consecutive_failures ?? LIMIT_DEFAULTS.max_consecutive_failures, 'stop.max_consecutive_failures'),
    retry_max: posInt(esc.retry_max ?? LIMIT_DEFAULTS.retry_max, 'escalation.retry_max'),
    hint_retry_max: posInt(esc.hint_retry_max ?? LIMIT_DEFAULTS.hint_retry_max, 'escalation.hint_retry_max'),
    // Plan 크기 한도. 정지·에스컬레이션 정책과 같은 파일에 둔다 — 한도를 흩어 놓지 않는다.
    max_tasks_per_plan: maxTasks,
    then: esc.then ?? 'needs-human',
    source: 'policies/limits.yaml',
  };
}

const DEFAULTS = {
  worker_adapter: 'claude',
  worker_timeout_seconds: 900,
  worker_model: null,
  gate_timeout_seconds: 300,
  verifier_adapter: 'claude',
  verifier_timeout_seconds: 600,
  verifier_model: null,
  planner_adapter: 'claude',
  planner_timeout_seconds: 600,
  planner_model: null,
  // Effort는 provider CLI의 --effort 값이다. null이면 플래그를 넘기지 않는다(CLI 기본값).
  worker_effort: null,
  verifier_effort: null,
  planner_effort: null,
  // 호출 1회의 상한(USD). provider가 호출 뒤에 검사하므로 첫 응답이 상한을 넘길 수 있다.
  max_call_budget_usd: null,
  // Triage 역할. adapter가 null이면 verifier_adapter를 쓴다 (같은 읽기 전용 호출 형태).
  triage_adapter: null,
  triage_timeout_seconds: 300,
  triage_model: null,
  triage_effort: null,
};

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function checkEffort(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !EFFORT_LEVELS.includes(value)) {
    throw new Error(`${label} must be one of ${EFFORT_LEVELS.join(', ')} or null`);
  }
  return value;
}

function checkCallBudget(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number or null`);
  return value;
}

/**
 * runtime.profiles.<name> — 명시적으로 고를 수 있는 설정 묶음. 여기 적힌 키만 덮어쓴다.
 * Gate·Verifier 요구·승인 경계는 프로필로 바꿀 수 없다. 속도·비용에 관한 값만 다룬다.
 */
export const PROFILE_KEYS = [
  'worker_model', 'verifier_model', 'planner_model', 'triage_model',
  'worker_effort', 'verifier_effort', 'planner_effort', 'triage_effort',
  'worker_timeout_seconds', 'verifier_timeout_seconds', 'planner_timeout_seconds', 'triage_timeout_seconds',
  'max_call_budget_usd', 'goal_verification', 'max_tasks_per_plan', 'triage',
];

function checkProfiles(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('project.yaml: runtime.profiles must be a mapping');
  const out = {};
  for (const [name, body] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`project.yaml: profile name "${name}" must be lowercase letters, digits or dashes`);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error(`project.yaml: runtime.profiles.${name} must be a mapping`);
    for (const key of Object.keys(body)) {
      if (!PROFILE_KEYS.includes(key)) throw new Error(`project.yaml: runtime.profiles.${name}.${key} is not a profile key (allowed: ${PROFILE_KEYS.join(', ')})`);
    }
    out[name] = { ...body };
  }
  return out;
}

/**
 * 프로필을 현재 설정에 적용한다. 원본 파일은 바꾸지 않는다.
 * 어떤 값이 실제로 바뀌었는지 돌려주므로 CLI가 그대로 출력하고 Envelope에 기록할 수 있다.
 */
export function applyProfile(config, name) {
  if (!name) return { name: null, applied: [] };
  const profile = config.profiles?.[name];
  if (!profile) {
    const known = Object.keys(config.profiles ?? {});
    throw new Error(`unknown profile "${name}"${known.length ? ` (configured: ${known.join(', ')})` : ' (no runtime.profiles configured in .loop/project.yaml)'}`);
  }
  const applied = [];
  const set = (label, before, after) => { if (before !== after) applied.push(`${label}: ${before ?? 'null'} -> ${after ?? 'null'}`); };
  for (const [key, value] of Object.entries(profile)) {
    if (key.endsWith('_effort')) {
      const v = checkEffort(value, `profile ${name}.${key}`);
      set(key, config.runtime[key], v); config.runtime[key] = v;
    } else if (key.endsWith('_model')) {
      if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error(`profile ${name}.${key} must be a string or null`);
      set(key, config.runtime[key], value); config.runtime[key] = value;
    } else if (key.endsWith('_timeout_seconds')) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`profile ${name}.${key} must be an integer >= 1`);
      set(key, config.runtime[key], value); config.runtime[key] = value;
    } else if (key === 'max_call_budget_usd') {
      const v = checkCallBudget(value, `profile ${name}.${key}`);
      set(key, config.runtime[key], v); config.runtime[key] = v;
    } else if (key === 'goal_verification') {
      if (typeof value !== 'boolean') throw new Error(`profile ${name}.${key} must be boolean`);
      set(key, config.efficiency.goal_verification, value); config.efficiency.goal_verification = value;
    } else if (key === 'max_tasks_per_plan') {
      if (!Number.isInteger(value) || value < 1) throw new Error(`profile ${name}.${key} must be an integer >= 1`);
      set(key, config.limits.max_tasks_per_plan, value); config.limits.max_tasks_per_plan = value;
    } else if (key === 'triage') {
      if (typeof value !== 'boolean') throw new Error(`profile ${name}.${key} must be boolean`);
      set(key, config.limits.triage.enabled, value); config.limits.triage = { ...config.limits.triage, enabled: value };
    }
  }
  config.profile = name;
  return { name, applied };
}

let cached = null;

export function loadConfig(force = false) {
  if (cached && !force) return cached;
  const raw = parseYaml(readFileSync(PROJECT_YAML, 'utf8')) ?? {};
  const runtime = raw.runtime ?? {};

  const timeout = runtime.worker_timeout_seconds ?? DEFAULTS.worker_timeout_seconds;
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error('project.yaml: runtime.worker_timeout_seconds must be an integer >= 1');
  }
  const adapter = runtime.worker_adapter ?? DEFAULTS.worker_adapter;
  if (typeof adapter !== 'string' || adapter.trim() === '') {
    throw new Error('project.yaml: runtime.worker_adapter must be a non-empty string');
  }
  const gateTimeout = runtime.gate_timeout_seconds ?? DEFAULTS.gate_timeout_seconds;
  if (!Number.isInteger(gateTimeout) || gateTimeout < 1) {
    throw new Error('project.yaml: runtime.gate_timeout_seconds must be an integer >= 1');
  }
  const verifierTimeout = runtime.verifier_timeout_seconds ?? DEFAULTS.verifier_timeout_seconds;
  if (!Number.isInteger(verifierTimeout) || verifierTimeout < 1) {
    throw new Error('project.yaml: runtime.verifier_timeout_seconds must be an integer >= 1');
  }
  const verifierAdapter = runtime.verifier_adapter ?? DEFAULTS.verifier_adapter;
  if (typeof verifierAdapter !== 'string' || verifierAdapter.trim() === '') {
    throw new Error('project.yaml: runtime.verifier_adapter must be a non-empty string');
  }
  // 모델 이름은 추측하지 않는다. null이면 CLI 기본값을 쓰고 실제 값은 Envelope에 기록한다.
  const model = runtime.worker_model ?? DEFAULTS.worker_model;
  if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error('project.yaml: runtime.worker_model must be a string or null');
  }
  const verifierModel = runtime.verifier_model ?? DEFAULTS.verifier_model;
  if (verifierModel !== null && (typeof verifierModel !== 'string' || verifierModel.trim() === '')) {
    throw new Error('project.yaml: runtime.verifier_model must be a string or null');
  }
  const plannerTimeout = runtime.planner_timeout_seconds ?? DEFAULTS.planner_timeout_seconds;
  if (!Number.isInteger(plannerTimeout) || plannerTimeout < 1) {
    throw new Error('project.yaml: runtime.planner_timeout_seconds must be an integer >= 1');
  }
  const plannerAdapter = runtime.planner_adapter ?? DEFAULTS.planner_adapter;
  if (typeof plannerAdapter !== 'string' || plannerAdapter.trim() === '') {
    throw new Error('project.yaml: runtime.planner_adapter must be a non-empty string');
  }
  const plannerModel = runtime.planner_model ?? DEFAULTS.planner_model;
  if (plannerModel !== null && (typeof plannerModel !== 'string' || plannerModel.trim() === '')) {
    throw new Error('project.yaml: runtime.planner_model must be a string or null');
  }
  const workerEffort = checkEffort(runtime.worker_effort, 'project.yaml: runtime.worker_effort');
  const verifierEffort = checkEffort(runtime.verifier_effort, 'project.yaml: runtime.verifier_effort');
  const plannerEffort = checkEffort(runtime.planner_effort, 'project.yaml: runtime.planner_effort');
  const callBudget = checkCallBudget(runtime.max_call_budget_usd, 'project.yaml: runtime.max_call_budget_usd');
  const profiles = checkProfiles(runtime.profiles);
  const triageAdapter = runtime.triage_adapter ?? DEFAULTS.triage_adapter;
  if (triageAdapter !== null && (typeof triageAdapter !== 'string' || triageAdapter.trim() === '')) {
    throw new Error('project.yaml: runtime.triage_adapter must be a non-empty string or null');
  }
  const triageTimeout = runtime.triage_timeout_seconds ?? DEFAULTS.triage_timeout_seconds;
  if (!Number.isInteger(triageTimeout) || triageTimeout < 1) {
    throw new Error('project.yaml: runtime.triage_timeout_seconds must be an integer >= 1');
  }
  const triageModel = runtime.triage_model ?? DEFAULTS.triage_model;
  if (triageModel !== null && (typeof triageModel !== 'string' || triageModel.trim() === '')) {
    throw new Error('project.yaml: runtime.triage_model must be a string or null');
  }
  const triageEffort = checkEffort(runtime.triage_effort, 'project.yaml: runtime.triage_effort');

  cached = {
    efficiency: efficiencyConfig(runtime, existsSync(LIMITS_YAML) ? parseYaml(readFileSync(LIMITS_YAML, 'utf8')) : {}),
    project: raw.project ?? {},
    gates: raw.gates ?? {},
    limits: loadLimits(),
    runtime: {
      ...DEFAULTS, ...runtime,
      worker_adapter: adapter,
      worker_timeout_seconds: timeout,
      worker_model: model,
      gate_timeout_seconds: gateTimeout,
      verifier_adapter: verifierAdapter,
      verifier_timeout_seconds: verifierTimeout,
      verifier_model: verifierModel,
      planner_adapter: plannerAdapter,
      planner_timeout_seconds: plannerTimeout,
      planner_model: plannerModel,
      worker_effort: workerEffort,
      verifier_effort: verifierEffort,
      planner_effort: plannerEffort,
      max_call_budget_usd: callBudget,
      triage_adapter: triageAdapter,
      triage_timeout_seconds: triageTimeout,
      triage_model: triageModel,
      triage_effort: triageEffort,
    },
    profiles,
    profile: null,
  };
  return cached;
}
