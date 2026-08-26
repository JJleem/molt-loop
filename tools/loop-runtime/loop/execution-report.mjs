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
}) {
  return {
    schema: REPORT_SCHEMA,
    execution_id: execId,
    task_id: taskId,

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

/** Task의 가장 최근 실행 보고서. status/execution 명령이 쓴다. */
export function latestExecutionFor(taskId) {
  const ids = listExecutions().filter((id) => id.endsWith(`-${taskId}`) || id.includes(`-${taskId}-`));
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const r = readExecutionReport(ids[i]);
    if (r && !r.corrupt && r.task_id === taskId) return { execId: ids[i], report: r };
  }
  return null;
}
