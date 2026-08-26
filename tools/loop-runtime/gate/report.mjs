// gate/report — Gate Report 구성 · 저장 · 재실행 시 이전 증거 보존.
//
// Gate Report는 Runtime이 관찰한 프로세스 사실만 담는다.
// Worker의 self-evaluation은 들어가지 않고, Verifier는 아직 존재하지 않으므로 그 출력도 없다.

import {
  writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, readdirSync, chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const GATE_REPORT_FILE = 'gate-report.json';
export const GATES_DIR = 'gates';
export const GATE_HISTORY_DIR = 'gate-history';
export const REPORT_SCHEMA = 'loop.gate-report/v0';

/** 개별 Gate가 가질 수 있는 상태. Runtime은 이 넷 밖의 값을 만들지 않는다. */
export const GATE_STATUSES = ['PASS', 'FAIL', 'ERROR', 'TIMEOUT'];
/** Gate Run 전체 결과. 개별 Gate가 모두 PASS일 때만 PASS다. */
export const RUN_RESULTS = ['PASS', 'FAIL'];

export const gateDir = (runDir, name) => join(runDir, GATES_DIR, name);
export const reportPath = (runDir) => join(runDir, GATE_REPORT_FILE);

export function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** 파일시스템이 허용하면 산출물을 read-only로 잠근다. Gate 증거는 사후 수정 대상이 아니다. */
export function freeze(path) {
  try { chmodSync(path, 0o444); } catch { /* 지원하지 않으면 무시 */ }
}

/** 이전에 보존된 Gate 실행 기록의 수. */
export function priorGateAttempts(runDir) {
  const dir = join(runDir, GATE_HISTORY_DIR);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

/**
 * --rerun 시 기존 Gate 증거를 파괴하지 않고 gate-history/<n>/ 으로 옮긴다.
 * @returns {string|null} 보존된 디렉터리 이름
 */
export function archivePriorGateEvidence(runDir) {
  const report = reportPath(runDir);
  const gates = join(runDir, GATES_DIR);
  if (!existsSync(report) && !existsSync(gates)) return null;

  const historyRoot = join(runDir, GATE_HISTORY_DIR);
  mkdirSync(historyRoot, { recursive: true });
  let n = priorGateAttempts(runDir) + 1;
  while (existsSync(join(historyRoot, String(n)))) n += 1;
  const dest = join(historyRoot, String(n));
  mkdirSync(dest, { recursive: true });

  if (existsSync(gates)) renameSync(gates, join(dest, GATES_DIR));
  if (existsSync(report)) renameSync(report, join(dest, GATE_REPORT_FILE));
  return `${GATE_HISTORY_DIR}/${n}`;
}

/**
 * Acceptance Criteria와 Gate 결과의 결정론적 매핑.
 * gate 타입 AC는 참조한 Gate의 상태를 그대로 갖는다. verifier 타입은 이 층에서 판정하지 않는다.
 */
export function mapAcceptanceCriteria(task, gateResults) {
  const byName = new Map(gateResults.map((g) => [g.name, g]));
  return task.data.acceptance_criteria.map((ac) => {
    if (ac.verification.type === 'gate') {
      const g = byName.get(ac.verification.ref);
      return {
        id: ac.id,
        verification: 'gate',
        gate: ac.verification.ref,
        // 필수 Gate 집합은 AC ref의 상위집합이므로 미실행은 정상적으로 발생하지 않는다.
        status: g ? g.status : 'ERROR',
      };
    }
    return { id: ac.id, verification: 'verifier', gate: null, status: 'DEFERRED_TO_VERIFIER' };
  });
}

export function summarizeTelemetry(gateResults, durationMs) {
  const count = (s) => gateResults.filter((g) => g.status === s).length;
  return {
    total_duration_ms: durationMs,
    gate_duration_ms_total: gateResults.reduce((a, g) => a + g.duration_ms, 0),
    gate_count: gateResults.length,
    pass_count: count('PASS'),
    fail_count: count('FAIL'),
    error_count: count('ERROR'),
    timeout_count: count('TIMEOUT'),
    stdout_bytes_total: gateResults.reduce((a, g) => a + g.stdout_bytes, 0),
    stderr_bytes_total: gateResults.reduce((a, g) => a + g.stderr_bytes, 0),
    // Gate 실행은 결정론적 프로세스 실행이다. LLM 호출도 토큰 소비도 없다.
    llm_calls: 0,
    llm_tokens: 0,
  };
}

/** @returns {object} 정규화된 Gate Report */
export function buildGateReport({
  runId, taskId, task, required, gateConfig, gateResults, startedAt, finishedAt, attempt, subject,
}) {
  const durationMs = finishedAt - startedAt;
  const result = gateResults.every((g) => g.status === 'PASS') ? 'PASS' : 'FAIL';
  return {
    schema: REPORT_SCHEMA,
    run_id: runId,
    task_id: taskId,
    attempt,

    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,

    // 이 Gate 결과가 어떤 저장소 상태를 실제로 검사했는지. Verifier가 같은 대상인지 확인한다.
    verification_subject: subject,

    required_gates: required.names,
    gate_sources: required.sources,
    // "요구된 Gate가 없음"과 "Gate 설정이 없음"은 다른 사실이다. 둘 다 명시한다.
    no_gates_required: required.names.length === 0,
    configured_gates: gateConfig.names,

    result,
    gates: gateResults,
    acceptance_criteria: mapAcceptanceCriteria(task, gateResults),
    telemetry: summarizeTelemetry(gateResults, durationMs),

    runtime: {
      platform: process.platform,
      node: process.version,
      shell: true,
      executed_by: 'loopctl gate',
    },
  };
}

export function writeGateReport(runDir, report) {
  const path = reportPath(runDir);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  freeze(path);
  return path;
}

export function readGateReport(runDir) {
  const path = reportPath(runDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { corrupt: true };
  }
}
