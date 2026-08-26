// planner/store — Plan artifact의 위치와 읽기/쓰기.
//
// Plan은 Runtime Task State가 아니다. 그래서 `.loop/tasks/` 가 아니라
// Run 산출물과 같은 `.loop-local/` 아래에 둔다 (subject fingerprint에서 제외되는 자리다).
// 계획을 만드는 행위가 검증 대상 저장소 상태를 바꾸면 안 되기 때문이다.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, LOCAL_DIR } from '../task-store.mjs';

export const PLANS_DIR = join(LOCAL_DIR, 'plans');
export const PLAN_ID_RE = /^PLAN-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$/;

export const relFromRoot = (p) => relative(ROOT, p).split('\\').join('/');

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Plan ID는 Runtime이 발급한다. provider session id는 Plan identity가 아니다. */
export function allocatePlanId(now = new Date()) {
  const base = `PLAN-${stamp(now)}`;
  let id = base;
  for (let n = 2; existsSync(join(PLANS_DIR, id)); n += 1) {
    if (n > 99) throw new Error(`cannot allocate a plan id for ${base}`);
    id = `${base}-${n}`;
  }
  return id;
}

export const planDir = (planId) => join(PLANS_DIR, planId);
export const planExists = (planId) => existsSync(planDir(planId));

export function createPlanDir(planId) {
  const dir = planDir(planId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(dir, name, value, { readOnly = false } = {}) {
  const p = join(dir, name);
  writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (readOnly) { try { chmodSync(p, 0o444); } catch { /* filesystem이 지원하지 않으면 무시 */ } }
  return p;
}

/** 없으면 null, 깨졌으면 { corrupt: true }. 조용히 고치지 않는다. */
export function readJson(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { corrupt: true, error: e.message, path: relFromRoot(p) };
  }
}

/** Plan 하나의 정본 artifact 묶음. LLM 호출 없음. */
export function loadPlan(planId) {
  const dir = planDir(planId);
  if (!existsSync(dir)) return { ok: false, reason: `Plan not found: ${planId}` };
  return {
    ok: true,
    planId,
    dir,
    manifest: readJson(dir, 'manifest.json'),
    plannerResult: readJson(dir, 'planner-result.json'),
    envelope: readJson(dir, 'planner-envelope.json'),
    report: readJson(dir, 'plan-report.json'),
    approval: readJson(dir, 'approval.json'),
  };
}

/** 최신순 Plan 목록. 디렉터리 이름이 timestamp라서 사전순 역순이 곧 최신순이다. */
export function listPlans() {
  if (!existsSync(PLANS_DIR)) return [];
  return readdirSync(PLANS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PLAN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * Plan 참조 해석. 전체 ID 또는 유일하게 해석되는 접두사를 받는다.
 * 모호하면 고르지 않는다.
 */
export function resolvePlanRef(ref) {
  if (!ref) return { ok: false, reason: 'a plan id is required' };
  if (planExists(ref)) return { ok: true, planId: ref };
  const matches = listPlans().filter((p) => p.startsWith(ref));
  if (matches.length === 1) return { ok: true, planId: matches[0] };
  if (matches.length === 0) {
    const known = listPlans().slice(0, 5);
    return { ok: false, reason: `Plan not found: ${ref}${known.length ? `\n  recent: ${known.join(', ')}` : ''}` };
  }
  return { ok: false, reason: `ambiguous plan reference "${ref}": ${matches.join(', ')}` };
}
