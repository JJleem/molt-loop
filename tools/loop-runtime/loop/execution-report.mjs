// loop/execution-report — Runtime이 쓰는 실행 요약.
//
// Run artifact를 복사하지 않는다. 정본 Run을 참조만 한다.
// 사용량은 이미 기록된 단계별 telemetry에서만 모은다 — 없는 값을 합성하지 않는다.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from '../task-store.mjs';
import { verificationDirFor } from '../verifier/runner.mjs';

export const EXECUTIONS_DIR = join(LOCAL_DIR, 'executions');
export const ACTIVE_DIR = join(EXECUTIONS_DIR, 'active');
export const REPORT_FILE = 'execution-report.json';
export const REPORT_SCHEMA = 1;

/**
 * 활성 표식이 살아 있다고 볼 수 있는 heartbeat 유예.
 *
 * PID 생존만으로 판단하지 않는다. 부모가 없는 좀비 프로세스는 `kill(pid, 0)` 에 계속
 * 성공하므로, 끝난 실행을 영원히 "실행 중"으로 보이게 만든다(OBS-006에서 실측).
 * Runtime이 스스로 남기는 heartbeat가 정본이고, PID는 보조 신호다.
 */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/** 실행 결과가 아직 나오지 않은 상태. Report의 result와 같은 공간에 두지 않는다. */
export const ACTIVE_STATES = ['RUNNING', 'STALE'];

/** 실행 결과. Task YAML 상태가 아니라 오케스트레이션 결과다. */
export const EXECUTION_RESULTS = [
  'DONE', 'BLOCKED', 'NEEDS_HUMAN', 'LIMIT_REACHED', 'STALLED', 'INTERRUPTED', 'FAILED',
];

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const executionDir = (execId) => join(EXECUTIONS_DIR, execId);
const reportPath = (execId) => join(executionDir(execId), REPORT_FILE);
const freeze = (p) => { try { chmodSync(p, 0o444); } catch { /* 지원 안 하면 무시 */ } };

export function allocateExecutionId(taskId, now = new Date()) {
  const base = `EXEC-${stamp(now)}-${taskId}`;
  let id = base;
  for (let n = 2; existsSync(executionDir(id)); n += 1) {
    if (n > 99) throw new Error(`cannot allocate an execution id for ${base}`);
    id = `${base}-${n}`;
  }
  return id;
}

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

/**
 * 이 실행이 건드린 Run들의 정본 telemetry만 모은다.
 * provider가 주지 않은 값은 만들지 않는다. 완전한 달러 총액을 주장하지 않는다.
 */
export function buildUsageSummary(runDirsByRunId) {
  const invocations = [];
  let gateInvocations = 0;

  for (const [runId, runDir] of runDirsByRunId) {
    const env = readJson(join(runDir, 'runtime-envelope.json'));
    if (env) {
      invocations.push({
        stage: 'worker',
        attempt: env.attempt ?? null,
        run_id: runId,
        adapter: env.adapter ?? null,
        model: env.model ?? null,
        duration_ms: env.duration_ms ?? null,
        tokens: env.usage?.tokens ?? { source: 'unavailable' },
        provider_cost_usd: env.usage?.provider_cost_usd ?? null,
      });
    }
    if (existsSync(join(runDir, 'gate-report.json'))) gateInvocations += 1;

    const venv = readJson(join(verificationDirFor(runDir), 'verifier-envelope.json'));
    if (venv) {
      invocations.push({
        stage: 'verifier',
        attempt: venv.attempt ?? null,
        run_id: runId,
        adapter: venv.adapter ?? null,
        model: venv.model ?? null,
        duration_ms: venv.duration_ms ?? null,
        tokens: venv.usage?.tokens ?? { source: 'unavailable' },
        provider_cost_usd: venv.usage?.provider_cost_usd ?? null,
      });
    }
  }

  const known = invocations.filter((i) => Number.isFinite(i.provider_cost_usd));
  const unknown = invocations.length - known.length;

  // provider가 실제로 준 필드만 같은 종류끼리 더한다. 없는 total을 지어내지 않는다.
  const tokenFields = ['input', 'output', 'cached_input', 'cache_creation_input', 'total'];
  const provided = invocations.filter((i) => i.tokens?.source === 'provider');
  const tokenAggregate = {};
  for (const f of tokenFields) {
    const withField = provided.filter((i) => Number.isFinite(i.tokens[f]));
    if (withField.length > 0) {
      tokenAggregate[f] = withField.reduce((a, i) => a + i.tokens[f], 0);
      tokenAggregate[`${f}_from_invocations`] = withField.length;
    }
  }

  return {
    llm_invocations: invocations.length,
    worker_invocations: invocations.filter((i) => i.stage === 'worker').length,
    verifier_invocations: invocations.filter((i) => i.stage === 'verifier').length,
    // Gate는 결정론적 프로세스 실행이다. 토큰을 쓰지 않는다.
    gate_invocations: gateInvocations,
    provider_cost_usd_known: known.length > 0
      ? Number(known.reduce((a, i) => a + i.provider_cost_usd, 0).toFixed(6))
      : null,
    unknown_cost_invocations: unknown,
    tokens_aggregate: Object.keys(tokenAggregate).length > 0
      ? { source: 'sum-of-provider-reported', ...tokenAggregate }
      : { source: 'unavailable' },
    invocations,
  };
}

export function buildExecutionReport({
  execId, taskId, startedAt, finishedAt, result, stopReason, attempts, events, usageSummary, finalStatus, guard,
  origin = 'orchestrator', supersedes = null, stages = null,
}) {
  return {
    schema: REPORT_SCHEMA,
    execution_id: execId,
    task_id: taskId,
    // 이 실행을 누가 몰았는가. `manual` 은 사람이 CLI 단계를 직접 이어붙인 복구다.
    origin,
    // 사람이 이어받아 끝낸 경우, 그 전에 멈춰 있던 실행. 그 기록을 고쳐 쓰지는 않는다.
    supersedes,
    manual_stages: stages,

    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,

    result,
    stop_reason: stopReason,
    final_task_status: finalStatus,

    attempts,
    events,
    usage_summary: usageSummary,
    stage_transitions: events.length,
    loop_guard: guard,
  };
}

export function writeExecutionReport(execId, report) {
  mkdirSync(executionDir(execId), { recursive: true });
  const p = reportPath(execId);
  writeFileSync(p, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  freeze(p);
  return p;
}

export function readExecutionReport(execId) {
  const p = reportPath(execId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { corrupt: true }; }
}

export function listExecutions() {
  if (!existsSync(EXECUTIONS_DIR)) return [];
  return readdirSync(EXECUTIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('EXEC-'))
    .map((e) => e.name)
    .sort();
}

// ------------------------------------------------------------------
// 활성 실행 표식 — 진행 중인 실행을 Runtime 소유 상태로 드러낸다.
//
// 표식은 실행 시작 시점에 쓰이고 매 단계마다 갱신된다. 종료 시 지워진다.
// 그래서 크래시·세션 단절 후에도 "무엇이 어디까지 갔는가"가 디스크에 남는다.
// ------------------------------------------------------------------

const activeMarkerPath = (taskId) => join(ACTIVE_DIR, `${taskId}.json`);

export function readActiveMarker(taskId) {
  const p = activeMarkerPath(taskId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { corrupt: true, task_id: taskId }; }
}

export function listActiveMarkers() {
  if (!existsSync(ACTIVE_DIR)) return [];
  return readdirSync(ACTIVE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .sort()
    .map((taskId) => ({ taskId, marker: readActiveMarker(taskId) }))
    .filter((m) => m.marker !== null);
}

/**
 * 표식이 살아 있는 실행인지 판정한다. **heartbeat가 정본이다.**
 * PID는 참고로만 보고한다 — 좀비 프로세스가 있으면 PID는 거짓말을 한다.
 *
 * @returns {{ state: 'RUNNING'|'STALE', age_ms: number|null, reason: string }}
 */
export function classifyActiveMarker(marker, { now = Date.now(), staleAfterMs = HEARTBEAT_STALE_MS } = {}) {
  if (!marker || marker.corrupt) {
    return { state: 'STALE', age_ms: null, reason: 'the marker is unreadable' };
  }
  const beat = Date.parse(marker.heartbeat_at ?? marker.started_at ?? '');
  if (!Number.isFinite(beat)) {
    return { state: 'STALE', age_ms: null, reason: 'the marker carries no usable heartbeat' };
  }
  const age = now - beat;
  if (age > staleAfterMs) {
    return {
      state: 'STALE',
      age_ms: age,
      reason: `no heartbeat for ${Math.round(age / 1000)}s (limit ${Math.round(staleAfterMs / 1000)}s)`,
    };
  }
  return { state: 'RUNNING', age_ms: age, reason: `heartbeat ${Math.round(age / 1000)}s ago` };
}

/** Task의 가장 최근 실행 보고서. status/execution 명령이 쓴다. */
export function latestExecutionFor(taskId) {
  const ids = listExecutions().filter((id) => id.endsWith(`-${taskId}`) || id.includes(`-${taskId}-`));
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const r = readExecutionReport(ids[i]);
    if (r && !r.corrupt && r.task_id === taskId) return { execId: ids[i], report: r };
  }
  return null;
}
