// planner/report — Runtime이 쓰는 Plan Report. Plan에 대한 **정본**이다.
//
// Planner의 자기 선언("이건 유효한 계획이다")은 근거가 아니다.
// 여기 적힌 것만이 plan-approve가 읽는 사실이다.

import { writeJson, readJson } from './store.mjs';

export const PLAN_REPORT_SCHEMA = 1;
export const REPORT_FILE = 'plan-report.json';

/**
 * @returns {object} Plan Report (아직 저장하지 않는다)
 */
export function buildPlanReport({
  planId, goal, subjectBefore, subjectAfter, envelope, validation, order, adapter,
}) {
  const proposed = validation.result?.tasks ?? [];
  return {
    schema: PLAN_REPORT_SCHEMA,
    plan_id: planId,
    goal,
    created_at: envelope.started_at,

    adapter,
    model: envelope.model ?? null,

    subject_sha256: subjectBefore.sha256 ?? null,
    repository_subject: subjectBefore,
    repository_subject_after: subjectAfter,
    subject_stable: envelope.repository_subject_stable,

    planner_result: validation.result?.result ?? null,
    planner_result_valid: validation.valid,
    policy_violation: envelope.planner_policy_violation,
    policy_detail: envelope.policy_detail,

    goal_summary: validation.result?.goal_summary ?? null,
    assumptions: validation.result?.assumptions ?? [],
    risks: validation.result?.risks ?? [],
    human_questions: validation.result?.human_questions ?? [],

    task_count: proposed.length,
    proposal_order: order,

    validation: {
      valid: validation.valid && envelope.failures.length === 0,
      errors: [...envelope.failures, ...validation.errors],
      warnings: validation.warnings,
    },

    approvable: Boolean(
      validation.valid
      && envelope.failures.length === 0
      && !envelope.planner_policy_violation
      && validation.result?.result === 'PROPOSED'
      && proposed.length > 0
    ),
    approved: false,
  };
}

export const writePlanReport = (dir, report) => writeJson(dir, REPORT_FILE, report);
export const readPlanReport = (dir) => readJson(dir, REPORT_FILE);

/** 승인 결과를 Report에 반영한다. Report는 Runtime만 쓴다. */
export function markApproved(dir, report, approval) {
  const updated = {
    ...report,
    approved: true,
    approved_at: approval.approved_at,
    created_task_ids: approval.created_task_ids,
  };
  writePlanReport(dir, updated);
  return updated;
}
