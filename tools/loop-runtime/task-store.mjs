// task-store — Task 파일 로드 · 검증 · 상태 쓰기.
//
// Single Writer: Task 파일에 대한 유일한 쓰기 경로는 이 모듈의 writeStatus()다.
// 잘못된 Task를 조용히 고치지 않는다. 에러를 반환한다.

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, YamlError } from './yaml-lite.mjs';
import { STATES, isState, checkTransition } from './transitions.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOOP_DIR = join(ROOT, '.loop');
export const LOCAL_DIR = join(ROOT, '.loop-local');
export const TASKS_DIR = join(LOOP_DIR, 'tasks');
export const SKILLS_DIR = join(LOOP_DIR, 'skills');
export const KERNEL_PATH = join(LOOP_DIR, 'KERNEL.md');
export const PAUSE_PATH = join(LOCAL_DIR, 'PAUSE');

const TOP_LEVEL_KEYS = new Set([
  'id', 'status', 'request', 'execution', 'stop_condition',
  'acceptance_criteria', 'evidence', 'failure_memo',
  'auto_dispatch', 'example', 'domain', 'depends_on',
]);

// Runtime 내부 Role. Task의 execution.role 로 배정할 수 있는 Role이 아니다.
// (.loop/skills/ 에 파일이 있는 것과 "실행 Role"인 것은 다르다.)
export const RUNTIME_ROLES = ['verifier', 'planner'];

// V0 Acceptance Criteria: { id, description, verification: { type: gate|verifier, ref|instruction } }
// human · 복합식(AND/OR) · threshold는 아직 도입하지 않는다.
const AC_KEYS = new Set(['id', 'description', 'verification']);
const VERIFICATION_KEYS = new Set(['type', 'ref', 'instruction']);
export const VERIFICATION_TYPES = ['gate', 'verifier'];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Task 하나를 검증한다. 반환값은 사람이 읽을 수 있는 에러 문자열 배열이며,
 * 비어 있으면 유효한 Task다.
 */
export function validateTask(data, label) {
  const errors = [];
  const err = (msg) => errors.push(`${label}: ${msg}`);

  if (!isPlainObject(data)) {
    return [`${label}: task file must contain a YAML mapping at the top level`];
  }

  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.has(key)) err(`unknown field "${key}"`);
  }

  if (!isNonEmptyString(data.id)) err('id is required and must be a non-empty string');

  if (!isNonEmptyString(data.status)) {
    err('status is required and must be a non-empty string');
  } else if (!isState(data.status)) {
    err(`invalid status "${data.status}" (valid: ${STATES.join(', ')})`);
  }

  if (!isNonEmptyString(data.request)) err('request is required and must be a non-empty string');

  if (!isPlainObject(data.execution)) {
    err('execution is required and must be a mapping');
  } else if (!isNonEmptyString(data.execution.role)) {
    err('execution.role is required and must be a non-empty string');
  } else if (!existsSync(join(SKILLS_DIR, `${data.execution.role}.md`))) {
    err(`execution.role "${data.execution.role}" has no skill file .loop/skills/${data.execution.role}.md`);
  }

  const sc = data.stop_condition;
  if (!isPlainObject(sc)) {
    err('stop_condition is required and must be a mapping');
  } else {
    if (!Array.isArray(sc.gates)) {
      err('stop_condition.gates must be an array');
    } else if (!sc.gates.every(isNonEmptyString)) {
      err('stop_condition.gates must contain only non-empty strings');
    }
    if (typeof sc.requires_verifier !== 'boolean') {
      err('stop_condition.requires_verifier must be a boolean');
    }
    if (!Number.isInteger(sc.max_consecutive_failures) || sc.max_consecutive_failures < 1) {
      err('stop_condition.max_consecutive_failures must be an integer >= 1');
    }
  }

  if (!Array.isArray(data.acceptance_criteria)) {
    err('acceptance_criteria must be an array');
  } else {
    data.acceptance_criteria.forEach((ac, i) => {
      const at = `acceptance_criteria[${i}]`;
      if (!isPlainObject(ac)) return err(`${at} must be a mapping with id, description, verification`);
      for (const key of Object.keys(ac)) {
        if (!AC_KEYS.has(key)) err(`${at}: unknown field "${key}"`);
      }
      if (!isNonEmptyString(ac.id)) err(`${at}.id is required`);
      if (!isNonEmptyString(ac.description)) err(`${at}.description is required`);

      // 구체적인 판정 방법이 없는 AC는 정지 조건이 될 수 없다 -> dispatch 대상이 아니다.
      const v = ac.verification;
      if (v === undefined || v === null) {
        err(`${at}.verification is required (a criterion without a judgment method cannot be a stop condition)`);
      } else if (!isPlainObject(v)) {
        err(`${at}.verification must be a mapping with type: ${VERIFICATION_TYPES.join(' | ')}`);
      } else {
        for (const key of Object.keys(v)) {
          if (!VERIFICATION_KEYS.has(key)) err(`${at}.verification: unknown field "${key}"`);
        }
        if (!isNonEmptyString(v.type)) {
          err(`${at}.verification.type is required (${VERIFICATION_TYPES.join(' | ')})`);
        } else if (!VERIFICATION_TYPES.includes(v.type)) {
          err(`${at}.verification.type "${v.type}" is unknown (valid: ${VERIFICATION_TYPES.join(', ')})`);
        } else if (v.type === 'gate') {
          if (!isNonEmptyString(v.ref)) err(`${at}.verification.ref is required when type is "gate"`);
          if (v.instruction !== undefined) err(`${at}.verification.instruction is not allowed when type is "gate"`);
        } else {
          // verifier: description만으로 판정 가능하면 instruction은 생략할 수 있다.
          if (v.instruction !== undefined && !isNonEmptyString(v.instruction)) {
            err(`${at}.verification.instruction must be a non-empty string when present`);
          }
          if (v.ref !== undefined) err(`${at}.verification.ref is not allowed when type is "verifier"`);
        }
      }
    });
  }

  // depends_on 은 선행 Task의 canonical id 목록이다. 없으면 [] 과 같다(하위 호환).
  // 여기서는 Task 하나 안에서 결정할 수 있는 것만 본다. 참조 해석과 순환 검사는
  // 여러 Task를 함께 봐야 하므로 taskGraphErrors() 에서 한다.
  if (data.depends_on !== undefined) {
    if (!Array.isArray(data.depends_on)) {
      err('depends_on must be an array of task ids');
    } else {
      const seen = new Set();
      data.depends_on.forEach((dep, i) => {
        if (!isNonEmptyString(dep)) return err(`depends_on[${i}] must be a non-empty task id`);
        if (seen.has(dep)) err(`depends_on: duplicate dependency "${dep}"`);
        seen.add(dep);
        if (dep === data.id) err(`depends_on: "${dep}" depends on itself`);
      });
    }
  }

  if (!Array.isArray(data.evidence)) {
    err('evidence must be an array');
  } else {
    data.evidence.forEach((e, i) => {
      const at = `evidence[${i}]`;
      if (!isPlainObject(e)) return err(`${at} must be a mapping with kind, path`);
      if (!isNonEmptyString(e.kind)) err(`${at}.kind is required`);
      if (!isNonEmptyString(e.path)) err(`${at}.path is required`);
    });
  }

  if (!Array.isArray(data.failure_memo)) {
    err('failure_memo must be an array');
  } else {
    data.failure_memo.forEach((m, i) => {
      const at = `failure_memo[${i}]`;
      if (!isPlainObject(m)) return err(`${at} must be a mapping with attempt, stage, error, lesson`);
      if (!Number.isInteger(m.attempt) || m.attempt < 1) err(`${at}.attempt must be an integer >= 1`);
      if (!isNonEmptyString(m.stage)) err(`${at}.stage is required`);
      if (!isNonEmptyString(m.error)) err(`${at}.error is required`);
      if (!isNonEmptyString(m.lesson)) err(`${at}.lesson is required`);
    });
  }

  if (data.auto_dispatch !== undefined && typeof data.auto_dispatch !== 'boolean') {
    err('auto_dispatch must be a boolean');
  }
  if (data.example !== undefined && typeof data.example !== 'boolean') {
    err('example must be a boolean');
  }

  return errors;
}

/** 파일 하나를 읽어 { file, id, data, errors } 로 만든다. 파싱 실패도 errors로 표현한다. */
export function loadTaskFile(file) {
  const label = basename(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { file, id: label, data: null, errors: [`${label}: cannot read file (${e.code ?? e.message})`] };
  }
  let data;
  try {
    data = parseYaml(text);
  } catch (e) {
    const msg = e instanceof YamlError ? e.message : String(e.message ?? e);
    return { file, id: label, data: null, errors: [`${label}: malformed YAML - ${msg}`] };
  }
  const id = isPlainObject(data) && isNonEmptyString(data.id) ? data.id : label;
  const errors = validateTask(data, id);
  if (isPlainObject(data) && isNonEmptyString(data.id) && data.id !== basename(file).replace(/\.ya?ml$/, '')) {
    errors.push(`${id}: id does not match filename ${basename(file)}`);
  }
  return { file, id, data, errors };
}

/** .loop/tasks/ 의 모든 YAML을 로드한다. YAML이 아닌 파일은 무시한다. */
export function loadAllTasks(dir = TASKS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => loadTaskFile(join(dir, f)));
}

export const isValid = (t) => t.errors.length === 0;
export const isExample = (t) => t.data?.example === true || t.id === 'TASK-EXAMPLE';
export const isAutoDispatchable = (t) => t.data?.auto_dispatch !== false;
export const isPaused = () => existsSync(PAUSE_PATH);

/** 선행 Task 목록. 필드가 없으면 [] 다 — 기존 Task 파일을 고쳐 쓰지 않는다. */
export const dependsOn = (t) => (Array.isArray(t?.data?.depends_on) ? t.data.depends_on : []);

/** 실제로 배정 가능한 실행 Role. .loop/skills/*.md 에서 Runtime 내부 Role을 뺀 것. */
export function executionRoles(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((r) => !RUNTIME_ROLES.includes(r))
    .sort();
}

/**
 * Task 그래프 전체에 대한 결정론적 검사 — LLM은 관여하지 않는다.
 * 없는 Task 참조 · 자기 참조 · 순환을 찾는다. Task 하나만 보고는 알 수 없는 것들이다.
 * @returns {string[]}
 */
export function taskGraphErrors(tasks = loadAllTasks()) {
  const errors = [];
  const byId = new Map(tasks.filter(isValid).map((t) => [t.id, t]));

  for (const t of byId.values()) {
    for (const dep of dependsOn(t)) {
      if (dep === t.id) continue;              // validateTask가 이미 보고했다
      if (!byId.has(dep)) errors.push(`${t.id}: depends_on references unknown task "${dep}"`);
    }
  }

  // 순환 탐지 — Kahn. 남은 노드가 있으면 그 노드들이 순환에 속한다.
  const indegree = new Map();
  const dependents = new Map();
  for (const id of byId.keys()) { indegree.set(id, 0); dependents.set(id, []); }
  for (const t of byId.values()) {
    for (const dep of new Set(dependsOn(t))) {
      if (!byId.has(dep) || dep === t.id) continue;
      indegree.set(t.id, indegree.get(t.id) + 1);
      dependents.get(dep).push(t.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let settled = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    settled += 1;
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (settled !== byId.size) {
    const stuck = [...indegree.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort();
    errors.push(`dependency cycle detected among: ${stuck.join(', ')}`);
  }
  return errors;
}

/**
 * 선행 Task 조건만 따로 본다. run/execute/READY가 **같은 함수**를 쓴다.
 * @returns {{ met: boolean, waiting_on: string[], missing: string[] }}
 */
export function checkDependencies(task, tasks = loadAllTasks()) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const waiting = [];
  const missing = [];
  for (const dep of dependsOn(task)) {
    const d = byId.get(dep);
    if (!d) missing.push(dep);
    else if (!isValid(d)) missing.push(dep);
    else if (d.data.status !== 'DONE') waiting.push(dep);
  }
  return { met: waiting.length === 0 && missing.length === 0, waiting_on: waiting, missing };
}

/**
 * READY는 저장되는 상태가 아니라 Runtime이 계산하는 파생 상태다.
 * V0: status == TODO · 예제 아님 · 구조적으로 유효 · 설정상 차단되지 않음 ·
 *     선행 Task가 전부 DONE.
 *
 * 선행 Task가 끝나지 않은 Task는 **TODO 그대로** 남는다. 새 저장 상태를 만들지 않는다.
 */
export function readyTasks(tasks = loadAllTasks()) {
  if (isPaused()) return [];
  return tasks.filter(
    (t) => isValid(t) && t.data.status === 'TODO' && !isExample(t) && isAutoDispatchable(t)
      && checkDependencies(t, tasks).met
  );
}

/**
 * 상태를 파일에 쓴다 — Task 파일에 대한 유일한 쓰기 경로.
 * 전체를 재직렬화하지 않고 top-level `status:` 한 줄만 바꿔 주석과 서식을 보존한다.
 * temp 파일 + rename으로 원자적으로 교체한다.
 */
export function writeStatus(task, to) {
  const from = task.data.status;
  const verdict = checkTransition(from, to);
  if (!verdict.allowed) {
    return { ok: false, reason: `Transition denied: ${from} -> ${to} (${verdict.reason})` };
  }

  const text = readFileSync(task.file, 'utf8');
  const matches = [...text.matchAll(/^status:[ \t]*(.*)$/gm)];
  if (matches.length !== 1) {
    return { ok: false, reason: `${task.id}: expected exactly one top-level "status:" line, found ${matches.length}` };
  }
  const updated = text.replace(/^status:[ \t]*(.*)$/m, (line, rest) => {
    const comment = rest.match(/(\s+#.*)$/)?.[1] ?? '';
    return `status: ${to}${comment}`;
  });

  const tmp = join(dirname(task.file), `.${basename(task.file)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, updated, 'utf8');
    renameSync(tmp, task.file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, reason: `${task.id}: write failed - ${e.message}` };
  }
  return { ok: true, from, to };
}
