// planner/approval — 승인된 Plan을 canonical Task로 실체화한다.
//
// 여기서 **LLM을 호출하지 않는다.** 승인은 결정론적 작업이다.
//
// 순서가 곧 안전장치다:
//   Plan artifact 로드 -> 유효성/정책 확인 -> subject 재계산 및 대조 ->
//   결정론적 재검증 -> canonical ID 발급 -> 의존 관계 치환 ->
//   **전체 Task 집합을 먼저 검증** -> 그 다음에야 파일 쓰기
//
// Runtime이 Task ID를 발급한다. Planner가 고른 이름을 쓰지 않는다.

import { writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import {
  ROOT, TASKS_DIR, loadAllTasks, validateTask, isValid, taskGraphErrors,
} from '../task-store.mjs';
import { loadConfig } from '../config.mjs';
import { computeSubject, subjectRef, sameSubject } from '../subject.mjs';
import { loadGateConfig, checkGateRefs } from '../gate/resolver.mjs';
import { validatePlannerResult, materializedTaskData } from './validator.mjs';
import { renderTaskYaml } from './task-yaml.mjs';
import { loadPlan, writeJson, relFromRoot } from './store.mjs';
import { markApproved } from './report.mjs';

export const TASK_ID_RE = /^TASK-([0-9]{3,})$/;

/**
 * 저장소의 기존 Task ID 규약을 따라 다음 번호를 발급한다.
 * 이미 쓰이는 번호와 이미 존재하는 파일 이름을 모두 피한다.
 */
export function allocateTaskIds(count, existingTasks) {
  const used = new Set(existingTasks.map((t) => t.id));
  let next = 0;
  for (const t of existingTasks) {
    const m = TASK_ID_RE.exec(t.id);
    if (m) next = Math.max(next, Number.parseInt(m[1], 10));
  }
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    let id;
    do {
      next += 1;
      if (next > 999_999) throw new Error('cannot allocate a task id: the TASK-NNN space is exhausted');
      id = `TASK-${String(next).padStart(3, '0')}`;
    } while (used.has(id) || existsSync(join(TASKS_DIR, `${id}.yaml`)) || existsSync(join(TASKS_DIR, `${id}.yml`)));
    used.add(id);
    ids.push(id);
  }
  return ids;
}

const refuse = (reason, detail = []) => ({ ok: false, code: 'REFUSED', reason, detail });

/**
 * Plan 하나를 승인하고 Task 파일을 만든다. AI 호출 없음.
 *
 * @returns {{ ok: true, already?: boolean, planId, approval, created, report }
 *          | { ok: false, code, reason, detail: string[] }}
 */
export function approvePlan(planId, { now = new Date() } = {}) {
  const loaded = loadPlan(planId);
  if (!loaded.ok) return refuse(loaded.reason);
  const { dir, report, plannerResult, envelope } = loaded;

  // --- 1. 정본 artifact가 읽히는가
  for (const [name, value] of [['plan-report.json', report], ['planner-result.json', plannerResult], ['planner-envelope.json', envelope]]) {
    if (value === null) return refuse(`${planId}: ${name} is missing — this plan is not approvable.`);
    if (value.corrupt) return refuse(`${planId}: ${name} is corrupt (${value.error}).`);
  }

  // --- 2. 이미 승인되었는가 (멱등)
  if (loaded.approval && !loaded.approval.corrupt) {
    return {
      ok: true,
      already: true,
      planId,
      approval: loaded.approval,
      created: loaded.approval.created_task_ids ?? [],
      report,
    };
  }

  // --- 3. Planner Result와 정책
  if (!report.planner_result_valid) {
    return refuse(`${planId}: the planner result did not pass runtime validation.`, report.validation?.errors ?? []);
  }
  if (report.policy_violation) {
    return refuse(
      `${planId}: the planner mutated files during planning — this plan cannot be approved.`,
      report.policy_detail ?? []
    );
  }
  if (report.planner_result !== 'PROPOSED') {
    const extra = report.planner_result === 'NEEDS_HUMAN'
      ? ['Answer the questions in `loopctl plan-show` and create a fresh plan with the answers included.']
      : [];
    return refuse(`${planId}: planner result is ${report.planner_result}; only PROPOSED plans can be approved.`, extra);
  }
  const proposal = plannerResult.normalized;
  if (!proposal || !Array.isArray(proposal.tasks) || proposal.tasks.length === 0) {
    return refuse(`${planId}: the plan contains no proposed task.`);
  }

  // --- 4. 저장소 상태가 계획 시점과 같은가 (--force는 없다)
  const current = subjectRef(computeSubject(ROOT));
  if (!current.sha256 || !report.subject_sha256) {
    return refuse(`${planId}: cannot compute a repository subject fingerprint; approval requires git.`);
  }
  if (!sameSubject({ sha256: report.subject_sha256 }, current)) {
    return {
      ok: false,
      code: 'STALE',
      reason: `${planId}: repository state changed since this plan was created.`,
      detail: [
        `plan subject:    ${report.subject_sha256}`,
        `current subject: ${current.sha256}`,
        '',
        'Create a fresh plan against the current project state.',
      ],
    };
  }

  // --- 5. 결정론적 재검증 — 저장된 판정을 믿지 않고 지금 다시 본다.
  const config = loadConfig(true);
  const existingTasks = loadAllTasks();
  const revalidation = validatePlannerResult(
    {
      plan_id: proposal.plan_id,
      result: proposal.result,
      goal_summary: proposal.goal_summary,
      assumptions: proposal.assumptions,
      risks: proposal.risks,
      human_questions: proposal.human_questions,
      tasks: proposal.tasks.map((t) => ({
        proposal_id: t.proposal_id,
        title: t.title,
        request: t.request,
        execution: t.execution,
        depends_on: t.depends_on,
        stop_condition: t.stop_condition,
        acceptance_criteria: t.acceptance_criteria,
      })),
    },
    { planId, config, existingTasks }
  );
  if (!revalidation.valid) {
    return refuse(`${planId}: the plan no longer validates against the current runtime configuration.`, revalidation.errors);
  }

  // --- 6. canonical Task ID 발급 + 제안 의존 관계 치환
  const tasks = revalidation.result.tasks;
  const order = revalidation.order.length === tasks.length
    ? revalidation.order
    : tasks.map((t) => t.proposal_id);
  const byProposal = new Map(tasks.map((t) => [t.proposal_id, t]));

  // 실행 순서대로 번호가 붙도록 위상 순서로 발급한다.
  const ids = allocateTaskIds(order.length, existingTasks);
  const mapping = {};
  order.forEach((pid, i) => { mapping[pid] = ids[i]; });

  const gateConfig = loadGateConfig(config);
  const prepared = [];
  const errors = [];
  for (const pid of order) {
    const p = byProposal.get(pid);
    const id = mapping[pid];
    const dependsOn = p.depends_on.map((d) => mapping[d]);
    if (dependsOn.some((d) => d === undefined)) {
      errors.push(`${pid}: a dependency could not be mapped to a canonical task id`);
      continue;
    }
    const data = materializedTaskData(p, { id, dependsOn });

    // 기존 Task 검증기를 그대로 쓴다. Planner 전용 완화 경로는 없다.
    errors.push(...validateTask(data, id));
    errors.push(...checkGateRefs({ id, data }, gateConfig));

    const file = join(TASKS_DIR, `${id}.yaml`);
    if (existsSync(file)) { errors.push(`${id}: ${relFromRoot(file)} already exists — refusing to overwrite an existing task`); continue; }

    const rendered = renderTaskYaml(data, {
      header: [
        `# ${p.title}`,
        `# Runtime이 ${planId} 승인 시점에 생성했다 (proposal ${pid}). 계획 서술은 여기 남기지 않는다.`,
      ],
    });
    if (!rendered.ok) { errors.push(...rendered.errors); continue; }
    prepared.push({ id, pid, file, text: rendered.text, data, title: p.title });
  }

  // --- 7. 만들어질 Task 그래프 전체를 미리 검증한다 (기존 Task 포함)
  if (errors.length === 0) {
    const simulated = [
      ...existingTasks.filter(isValid),
      ...prepared.map((p) => ({ id: p.id, file: p.file, data: p.data, errors: [] })),
    ];
    errors.push(...taskGraphErrors(simulated));
  }
  if (errors.length > 0) {
    return refuse(`${planId}: the materialized task set is invalid — nothing was written.`, errors);
  }

  // --- 8. 여기서부터 쓰기. temp 파일 + rename.
  mkdirSync(TASKS_DIR, { recursive: true });
  const written = [];
  for (const p of prepared) {
    const tmp = join(dirname(p.file), `.${basename(p.file)}.tmp-${process.pid}`);
    try {
      writeFileSync(tmp, p.text, 'utf8');
      renameSync(tmp, p.file);
      written.push(p);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      // 부분 승인을 성공으로 보고하지 않는다. 이미 쓴 것을 되돌릴 수 있으면 되돌린다.
      const undone = [];
      const stuck = [];
      for (const w of written) {
        try { unlinkSync(w.file); undone.push(relFromRoot(w.file)); } catch { stuck.push(relFromRoot(w.file)); }
      }
      if (stuck.length > 0) {
        return {
          ok: false,
          code: 'RECOVERY_AMBIGUOUS',
          reason: `${planId}: approval failed partway and the runtime could not prove a clean rollback.`,
          detail: [
            `write failed for: ${relFromRoot(p.file)} (${e.message})`,
            `removed:          ${undone.join(', ') || '(none)'}`,
            `STILL PRESENT:    ${stuck.join(', ')}`,
            '',
            'Inspect the files above by hand. The plan is NOT marked approved.',
          ],
        };
      }
      return refuse(`${planId}: approval failed while writing ${relFromRoot(p.file)} (${e.message}).`, [
        `rolled back: ${undone.join(', ') || '(nothing had been written)'}`,
      ]);
    }
  }

  // --- 9. 승인 artifact
  const approval = {
    schema: 1,
    plan_id: planId,
    approved_at: now.toISOString(),
    approved_by: 'human (loopctl plan-approve)',
    llm_invocations: 0,
    repository_subject_at_approval: current,
    proposal_to_task: mapping,
    proposal_order: order,
    created_task_ids: order.map((pid) => mapping[pid]),
    created_files: prepared.map((p) => relFromRoot(p.file)),
    tasks: prepared.map((p) => ({
      proposal_id: p.pid,
      task_id: p.id,
      title: p.title,
      depends_on: p.data.depends_on ?? [],
    })),
  };
  writeJson(dir, 'approval.json', approval, { readOnly: true });
  const updated = markApproved(dir, report, approval);

  return { ok: true, already: false, planId, approval, created: approval.created_task_ids, report: updated };
}
