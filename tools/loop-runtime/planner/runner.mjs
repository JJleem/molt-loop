// planner/runner — Goal Planner 1회 실행.
//
// Worker와도 Verifier와도 완전히 분리된 새 AI invocation이다.
// 세션도, 대화 기록도, Context도 공유하지 않는다. 이전 Plan의 대화도 이어받지 않는다.
//
// Planner는 읽기 전용이다 — 쓰기 도구를 주지 않고, 실행 전후로 저장소와 control plane을
// 해시로 대조해서 실제로 아무것도 바꾸지 않았음을 Runtime이 직접 확인한다.
//
// 이 파일은 Task 파일을 만들지 않는다. Task 생성은 planner/approval.mjs 만 한다.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, LOOP_DIR, loadAllTasks, executionRoles } from '../task-store.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { fingerprintDir, compareFingerprints } from '../worker/runner.mjs';
import { contextMetrics, outputMetrics, normalizeTokens } from '../worker/telemetry.mjs';
import { loadGateConfig } from '../gate/resolver.mjs';
import { plannerResultSchema, plannerProtocol } from './result.mjs';
import { validatePlannerResult } from './validator.mjs';
import { writePlannerSnapshot } from './context-builder.mjs';
import { allocatePlanId, writeJson, relFromRoot } from './store.mjs';
import { buildPlanReport, writePlanReport } from './report.mjs';

// Planner에게 허용하는 built-in tool. 읽기 전용만 준다.
export const PLANNER_TOOLS = ['Read', 'Grep', 'Glob'];
// 이중 방어 — tool 집합 제한과 별개로 명시적으로 거부한다.
export const PLANNER_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

/**
 * Planner를 한 번 실행하고 .loop-local/plans/PLAN-.../ 에 산출물을 남긴다.
 * Task 파일은 만들지 않는다. 상태도 쓰지 않는다.
 *
 * @param {{ goal, goalSource, config, onLaunch, now }} opts
 * @returns {{ planId, dir, snapshot, envelope, validation, report }}
 */
export async function runPlannerOnce({ goal, goalSource = 'argument', config, onLaunch, now = new Date() }) {
  const adapterName = config.runtime.planner_adapter;
  const adapter = getAdapter(adapterName);
  const availability = await adapter.detect();
  if (!availability.available) {
    throw new Error(`planner adapter "${adapterName}" is not available: ${availability.reason}`);
  }
  if (typeof adapter.runPlanner !== 'function') {
    throw new Error(`adapter "${adapterName}" does not implement runPlanner`);
  }

  const gateConfig = loadGateConfig(config);
  if (gateConfig.errors.length > 0) {
    throw new Error(`gate configuration is broken, refusing to plan:\n  ${gateConfig.errors.join('\n  ')}`);
  }

  const tasks = loadAllTasks();
  const roles = executionRoles();
  const subjectBefore = subjectRef(computeSubject(ROOT));
  const planId = allocatePlanId(now);

  const snapshot = writePlannerSnapshot({
    planId, goal, goalSource, config, tasks, roles, subject: subjectBefore, adapter: adapterName, now,
  });
  const dir = snapshot.dir;
  const timeoutSeconds = config.runtime.planner_timeout_seconds;

  // 실행 전 지문 — 저장소 대상과 control plane 둘 다.
  // Planner에게는 .loop/evidence/ 예외도 없다. 설계자는 아무것도 쓰지 않는다.
  const protectedBefore = fingerprintDir(LOOP_DIR);

  onLaunch?.({ adapter: adapterName, version: availability.version ?? null, planId });

  const startedAt = new Date();
  const proc = await adapter.runPlanner({
    planId,
    goal,
    context: snapshot.context,
    systemPrompt: plannerProtocol({
      planId,
      roles,
      gates: gateConfig.names.map((n) => gateConfig.gates[n]),
      maxTasks: config.limits.max_tasks_per_plan,
      subjectSha256: subjectBefore.sha256,
    }),
    cwd: ROOT,
    timeoutMs: timeoutSeconds * 1000,
    model: config.runtime.planner_model,
    schema: plannerResultSchema(),
    tools: PLANNER_TOOLS,
    deny: PLANNER_DENY,
  });
  const finishedAt = new Date();

  const protectedAfter = fingerprintDir(LOOP_DIR);
  const controlPlane = compareFingerprints(protectedBefore, protectedAfter);
  const subjectAfter = subjectRef(computeSubject(ROOT));
  const subjectStable = sameSubject(subjectBefore, subjectAfter);

  writeFileSync(join(dir, 'stdout.log'), proc.stdout ?? '', 'utf8');
  writeFileSync(join(dir, 'stderr.log'), proc.stderr ?? '', 'utf8');

  // Planner가 저장소나 control plane을 건드렸으면 그 자체로 Plan은 무효다.
  // 되돌리지 않는다 — 자동 rollback은 여전히 범위 밖이다. 바뀐 경로를 정확히 보고한다.
  const policyDetail = [];
  if (controlPlane.violated) {
    policyDetail.push(
      ...controlPlane.modified.map((p) => `modified ${p}`),
      ...controlPlane.added.map((p) => `added ${p}`),
      ...controlPlane.removed.map((p) => `removed ${p}`),
    );
  }
  if (!subjectStable) {
    policyDetail.push(`repository subject changed during planning: ${subjectBefore.sha256} -> ${subjectAfter.sha256}`);
  }
  const policyViolation = controlPlane.violated || !subjectStable;

  const failures = [];
  if (proc.launch_error) failures.push(`planner launch failed: ${proc.launch_error}`);
  if (proc.timed_out) failures.push(`planner timed out after ${timeoutSeconds}s`);
  if (!proc.timed_out && !proc.launch_error && proc.exit_code !== 0) {
    failures.push(`planner exited with code ${proc.exit_code}`);
  }
  if (policyViolation) {
    failures.push(`planner policy violation: the planner mutated files during planning (${policyDetail.join(', ')})`);
  }

  // 결과는 구조화 출력 채널로만 받는다. 대화 텍스트를 Plan으로 긁어내지 않는다.
  const raw = proc.structured_output ?? null;
  if (raw === null) {
    failures.push('planner produced no structured result (the conversational transcript is not a plan)');
  }
  const validation = raw === null
    ? { valid: false, errors: ['no structured planner result was returned'], warnings: [], result: null, order: [] }
    : validatePlannerResult(raw, { planId, config, existingTasks: tasks });
  if (raw !== null && !validation.valid) {
    failures.push(...validation.errors.map((m) => `planner result: ${m}`));
  }

  // Planner가 실제로 돌려준 것을 그대로 보존한다(정규화 전 원본).
  writeJson(dir, 'planner-result.json', {
    received: raw,
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    normalized: validation.result,
  }, { readOnly: true });

  const envelope = {
    plan_id: planId,
    stage: 'planner',
    adapter: adapterName,
    adapter_version: availability.version ?? null,
    model: proc.model ?? null,

    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,

    process: {
      exit_code: proc.exit_code ?? null,
      signal: proc.signal ?? null,
      timed_out: proc.timed_out,
      timeout_seconds: timeoutSeconds,
      launch_error: proc.launch_error ?? null,
    },

    planner_result_valid: validation.valid,
    planner_result_errors: validation.errors,
    planner_policy_violation: policyViolation,
    policy_detail: policyDetail,

    repository_subject_before: subjectBefore,
    repository_subject_after: subjectAfter,
    repository_subject_stable: subjectStable,

    read_only: { tools: PLANNER_TOOLS, denied: PLANNER_DENY },
    control_plane: {
      root: relFromRoot(LOOP_DIR),
      exceptions: [],
      file_count: Object.keys(protectedBefore).length,
      ...controlPlane,
    },

    // Planner 사용량은 Worker/Verifier 사용량과 섞지 않는다. 없는 값은 만들지 않는다.
    usage: {
      stage: 'planner',
      context: contextMetrics(snapshot.context),
      process_output: outputMetrics(proc.stdout, proc.stderr),
      tokens: normalizeTokens(proc.provider_usage),
      adapter: adapterName,
      model: proc.model ?? null,
      provider_cost_usd: proc.adapter_meta?.provider_cost_usd ?? null,
      duration_ms: finishedAt - startedAt,
    },

    adapter_meta: proc.adapter_meta ?? null,
    failures,
  };
  writeJson(dir, 'planner-envelope.json', envelope, { readOnly: true });

  const report = buildPlanReport({
    planId, goal, subjectBefore, subjectAfter, envelope, validation,
    order: validation.order ?? [], adapter: adapterName,
  });
  writePlanReport(dir, report);

  return { planId, dir, snapshot, envelope, validation, report };
}
