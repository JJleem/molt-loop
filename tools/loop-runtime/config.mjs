// config — .loop/project.yaml 읽기. 값이 없으면 기본값을 쓰되, 잘못된 값은 조용히 고치지 않는다.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml-lite.mjs';
import { LOOP_DIR } from './task-store.mjs';

export const PROJECT_YAML = join(LOOP_DIR, 'project.yaml');
// 정지·에스컬레이션 정책의 유일한 출처. project.yaml에 중복해서 두지 않는다.
export const LIMITS_YAML = join(LOOP_DIR, 'policies', 'limits.yaml');

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
  if (!existsSync(LIMITS_YAML)) return { ...LIMIT_DEFAULTS, source: 'defaults' };
  const raw = parseYaml(readFileSync(LIMITS_YAML, 'utf8')) ?? {};
  const stop = raw.stop ?? {};
  const esc = raw.escalation ?? {};
  const planning = raw.planning ?? {};
  const maxTasks = planning.max_tasks_per_plan ?? LIMIT_DEFAULTS.max_tasks_per_plan;
  if (!Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new Error('limits.yaml: planning.max_tasks_per_plan must be an integer >= 1');
  }
  return {
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
};

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

  cached = {
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
    },
  };
  return cached;
}
