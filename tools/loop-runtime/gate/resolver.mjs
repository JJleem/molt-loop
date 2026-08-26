// gate/resolver — Gate 설정 로드와 Task별 필수 Gate 계산.
//
// Gate 명령은 Runtime이 소유하는 설정(.loop/project.yaml)에서만 온다.
// Worker Result · Worker stdout · Task 서술 · AC description에서 명령 문자열을 받지 않는다.
// 여기서 resolve되지 않는 이름은 실행되지 않으며, 조용히 무시되지도 않는다.

import { statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { ROOT } from '../task-store.mjs';

const GATE_KEYS = new Set(['enabled', 'command', 'reason', 'timeout_seconds', 'cwd']);
// Gate 이름은 Run 디렉터리 이름이 된다. 경로 조작이 불가능한 문자만 허용한다.
const GATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const DEFAULT_GATE_TIMEOUT_SECONDS = 300;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * project.yaml의 gates 블록을 정규화한다. 잘못된 항목은 조용히 고치지 않고 errors로 보고한다.
 * @returns {{ gates: Record<string, object>, names: string[], errors: string[] }}
 */
export function loadGateConfig(config) {
  const errors = [];
  const gates = {};
  const raw = config.gates ?? {};

  if (raw !== null && !isPlainObject(raw)) {
    return { gates, names: [], errors: ['project.yaml: gates must be a mapping'] };
  }

  for (const [name, body] of Object.entries(raw ?? {})) {
    const at = `project.yaml: gates.${name}`;
    if (!GATE_NAME_RE.test(name)) {
      errors.push(`${at}: invalid gate name (allowed: letters, digits, "_", "-")`);
      continue;
    }
    if (!isPlainObject(body)) {
      errors.push(`${at} must be a mapping (enabled · command · reason · timeout_seconds · cwd)`);
      continue;
    }
    for (const key of Object.keys(body)) {
      if (!GATE_KEYS.has(key)) errors.push(`${at}: unknown field "${key}"`);
    }

    let enabled = body.enabled ?? true;
    if (typeof enabled !== 'boolean') {
      errors.push(`${at}.enabled must be a boolean`);
      enabled = false;
    }

    const command = body.command ?? null;
    if (command !== null && !isNonEmptyString(command)) {
      errors.push(`${at}.command must be a non-empty string or null`);
    }
    if (enabled && !isNonEmptyString(command)) {
      errors.push(`${at}.command is required when enabled is true`);
    }

    const reason = body.reason ?? null;
    if (reason !== null && !isNonEmptyString(reason)) {
      errors.push(`${at}.reason must be a non-empty string or null`);
    }

    let timeoutSeconds = null;
    if (body.timeout_seconds !== undefined && body.timeout_seconds !== null) {
      if (!Number.isInteger(body.timeout_seconds) || body.timeout_seconds < 1) {
        errors.push(`${at}.timeout_seconds must be an integer >= 1`);
      } else {
        timeoutSeconds = body.timeout_seconds;
      }
    }

    // cwd는 선택이며, 지정하면 프로젝트 루트 안이어야 한다. 존재 여부는 실행 시점에 다시 본다.
    let cwd = null;
    if (body.cwd !== undefined && body.cwd !== null) {
      if (!isNonEmptyString(body.cwd)) {
        errors.push(`${at}.cwd must be a non-empty string or null`);
      } else {
        const abs = resolve(ROOT, body.cwd);
        const inside = abs === ROOT || abs.startsWith(ROOT + sep);
        if (!inside) errors.push(`${at}.cwd must stay inside the project root`);
        else cwd = body.cwd;
      }
    }

    gates[name] = {
      name,
      enabled,
      command: isNonEmptyString(command) ? command.trim() : null,
      reason,
      timeout_seconds: timeoutSeconds,
      cwd,
    };
  }

  return { gates, names: Object.keys(gates), errors };
}

/** 설정된 기본 Gate timeout. runtime.gate_timeout_seconds 가 없으면 기본값을 쓴다. */
export function gateTimeoutSeconds(config, gateDef) {
  return gateDef?.timeout_seconds ?? config.runtime.gate_timeout_seconds ?? DEFAULT_GATE_TIMEOUT_SECONDS;
}

/** Gate가 실제로 실행될 작업 디렉터리 (절대경로). 지정이 없으면 프로젝트 루트다. */
export function gateCwd(gateDef) {
  return gateDef.cwd ? resolve(ROOT, gateDef.cwd) : ROOT;
}

export function gateCwdExists(gateDef) {
  const dir = gateCwd(gateDef);
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Task가 요구하는 결정론적 Gate의 합집합.
 *   stop_condition.gates  +  acceptance_criteria[].verification.ref (type == gate)
 * 중복은 제거하되 최초 등장 순서를 유지한다(결정론적 실행 순서).
 * @returns {{ names: string[], sources: Record<string, string[]> }}
 */
export function resolveRequiredGates(task) {
  const names = [];
  const sources = {};
  const add = (name, source) => {
    if (!Object.hasOwn(sources, name)) {
      sources[name] = [];
      names.push(name);
    }
    sources[name].push(source);
  };

  for (const g of task.data.stop_condition.gates) add(g, 'stop_condition.gates');
  for (const ac of task.data.acceptance_criteria) {
    if (ac.verification?.type === 'gate') add(ac.verification.ref, `acceptance_criteria.${ac.id}`);
  }
  return { names, sources };
}

/**
 * Task가 참조하는 모든 Gate 이름이 실제 설정된 Gate로 resolve되는지 확인한다.
 * 알 수 없는 참조는 조용히 무시하지도, Verifier 기준으로 강등하지도 않는다.
 * @returns {string[]} 사람이 읽을 수 있는 에러 문자열
 */
export function checkGateRefs(task, gateConfig) {
  const { names, sources } = resolveRequiredGates(task);
  const errors = [];
  for (const name of names) {
    if (!Object.hasOwn(gateConfig.gates, name)) {
      const known = gateConfig.names.join(', ') || '(none configured)';
      errors.push(
        `${task.id}: unknown gate reference "${name}" (from ${sources[name].join(', ')}; configured: ${known})`
      );
    }
  }
  return errors;
}

export const relFromRoot = (p) => relative(ROOT, p).split('\\').join('/');
