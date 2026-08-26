// loop/reconcile — 사람이 CLI 단계를 직접 이어 붙여 Task를 끝낸 경우의 기록.
//
// 관찰된 문제(OBS-004): `execute`가 NEEDS_HUMAN으로 멈춘 뒤 사람이 `gate` + `verify`를
// 손으로 돌려 Task를 DONE으로 만들면, Task는 DONE인데 "latest execution"은 영원히
// NEEDS_HUMAN으로 남는다.
//
// 표시만 바꾸지 않는다. 원인은 표시가 아니라 **기록의 공백**이다:
// 그 복구를 수행한 실행이 어디에도 기록되지 않았다.
//
// 그래서 여기서 하는 일은 단 하나 — 사람이 몬 실행도 Execution Report로 남긴다.
//   - 앞선 Report는 절대 고쳐 쓰지 않는다. 그것은 그때 실제로 일어난 일의 기록이다.
//   - 새 Report는 `origin: 'manual'` 과 `supersedes: <이전 EXEC-ID>` 를 갖는다.
//   - 사용량은 그 Run의 정본 telemetry에서만 모은다. 없는 값을 지어내지 않는다.
//
// 이것은 resume이 아니다. 사람이 이미 끝낸 일을 사실대로 적을 뿐이며,
// Worker·Gate·Verifier를 다시 돌리지 않고 LLM도 호출하지 않는다.

import {
  allocateExecutionId, buildExecutionReport, buildUsageSummary, writeExecutionReport,
  latestExecutionFor, readActiveMarker,
} from './execution-report.mjs';

/**
 * 이 복구를 기록으로 남겨야 하는가.
 *
 * 오케스트레이터가 몰고 있는 중이면 남기지 않는다 — 그쪽이 자기 Report를 쓴다.
 * 그 외에는 남긴다. 사람이 몬 실행도 실행이다.
 */
export function shouldRecordManualExecution(taskId) {
  const marker = readActiveMarker(taskId);
  if (marker && !marker.corrupt) return { record: false, reason: 'an orchestrated execution owns this task' };
  return { record: true, reason: null };
}

/**
 * 사람이 이어 붙인 단계들을 하나의 Execution Report로 남긴다.
 *
 * @param {{ taskId, run, stages, finalStatus, startedAt, finishedAt, config }} opts
 *   stages — 실제로 사람이 돌린 단계 이름 (예: ['gate', 'verify'])
 * @returns {{ execId, reportPath, report, supersedes }}
 */
export function recordManualExecution({
  taskId, run, stages, finalStatus, startedAt, finishedAt = new Date(), events = [],
}) {
  const prior = latestExecutionFor(taskId);
  // 앞선 실행이 이 Task를 다른 상태로 남겨 두었다면 그것을 대체한다고 명시한다.
  const supersedes = prior && prior.report.final_task_status !== finalStatus ? prior.execId : null;

  const execId = allocateExecutionId(taskId, finishedAt);
  const touchedRuns = new Map(run ? [[run.runId, run.runDir]] : []);

  const report = buildExecutionReport({
    execId,
    taskId,
    startedAt: startedAt ?? finishedAt,
    finishedAt,
    result: finalStatus === 'DONE' ? 'DONE' : 'NEEDS_HUMAN',
    stopReason: 'MANUAL_RECOVERY',
    attempts: run
      ? [{
        attempt: run.manifest?.attempt ?? 1,
        run_id: run.runId,
        worker: null,          // 이 실행에서 Worker를 돌리지 않았다. 앞선 실행의 Run을 이어받았다.
        gate: stages.includes('gate') ? 'PASS' : null,
        verifier: stages.includes('verify') ? 'PASS' : null,
        diagnosis: null,
        action: null,
      }]
      : [],
    events,
    usageSummary: buildUsageSummary(touchedRuns),
    finalStatus,
    guard: { limit: null, stage_transitions: events.length },
    origin: 'manual',
    supersedes,
    stages,
  });

  const reportPath = writeExecutionReport(execId, report);
  return { execId, reportPath, report, supersedes };
}
