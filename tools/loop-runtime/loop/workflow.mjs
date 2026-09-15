// Explicit goal files define the authorized scope. Re-entry uses saved plan IDs, never replans completed phases.
//
// V0.4: Triage가 켜져 있으면 이 workflow가 두 가지를 더 한다. 둘 다 **같은 Goal 파일의 권한 안에서만**이다.
//   - Planner가 spec/implementation 분류의 질문만 남기고 멈추면, Triage가 스펙·저장소에서 답을 찾아
//     Goal에 DECISIONS 절로 붙이고 다시 계획한다 (Phase당 max_answers_per_plan 회).
//   - Task 실행이 REPLAN으로 끝나거나 Goal 검증이 실패해 Triage가 REPLAN을 고르면, 남은 Task를 DROPPED로
//     내리고 실패 맥락을 붙여 다시 계획한다 (Phase당 max_replans_per_plan 회).
// 범위 기록(.loop-local/workflows/<hash>.json)의 해시는 원래 Goal 파일 내용만으로 계산한다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LOCAL_DIR, isPaused, loadAllTasks, writeStatus } from '../task-store.mjs';
import { runPlannerOnce } from '../planner/runner.mjs';
import { approvePlan } from '../planner/approval.mjs';
import { loadPlan } from '../planner/store.mjs';
import { executePlan, resolveExecutablePlan, writePlanExecutionReport } from './plan-executor.mjs';
import { runTriageOnce, triageEnabled, triageUsage, renderReplanGoal, renderAnsweredGoal, ANSWERABLE_CATEGORIES } from '../recovery/triage.mjs';

/** Replan 전에 남은 Task를 DROPPED로 내린다. DONE은 그대로 둔다. 전이 표를 우회하지 않는다. */
function supersedePlanTasks(planId) {
  const plan = resolveExecutablePlan(planId);
  if (!plan.ok) return { dropped: [], done: [] };
  const all = loadAllTasks();
  const dropped = [];
  const done = [];
  for (const id of plan.taskIds) {
    const t = all.find((x) => x.id === id);
    if (!t || !t.data) continue;
    if (t.data.status === 'DONE') { done.push(id); continue; }
    if (t.data.status === 'DROPPED') { dropped.push(id); continue; }
    // TODO -> DROPPED · BLOCKED -> DROPPED 는 직접, IN_PROGRESS / REVIEW 는 BLOCKED를 거친다.
    if (['IN_PROGRESS', 'REVIEW'].includes(t.data.status)) {
      const b = writeStatus(t, 'BLOCKED');
      if (!b.ok) throw new Error(`cannot supersede ${id}: ${b.reason}`);
      t.data.status = 'BLOCKED';
    }
    const d = writeStatus(t, 'DROPPED');
    if (!d.ok) throw new Error(`cannot supersede ${id}: ${d.reason}`);
    dropped.push(id);
  }
  return { dropped, done };
}

export async function runWorkflow({ files, config, emit = () => {}, isInterrupted = () => false }) {
  if (!files.length) throw new Error('start requires at least one --file; each file is one authorized phase');
  const goals = files.map((file) => ({ path: resolve(file), goal: readFileSync(file, 'utf8') }));
  if (goals.some((g) => !g.goal.trim())) throw new Error('goal files must not be empty');
  const hash = createHash('sha256').update(JSON.stringify(goals)).digest('hex');
  const dir = join(LOCAL_DIR, 'workflows');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { scope_sha256: hash, approval: 'explicit-start-command', profile: config.profile ?? null, phases: goals.map((g) => ({ file: g.path, plan_id: null, done: false })), created_at: new Date().toISOString() };
  if (state.scope_sha256 !== hash || state.phases.length !== goals.length) throw new Error('workflow scope does not match saved record');
  // 프로필은 범위가 아니라 실행 방식이다. 재개 시 다른 프로필을 써도 같은 범위를 이어간다. 마지막 값만 기록한다.
  state.profile = config.profile ?? null;
  const save = () => { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 2)); renameSync(tmp, path); };
  save();
  const triage = triageEnabled(config);

  for (let i = 0; i < goals.length; i++) {
    if (isPaused() || isInterrupted()) return { result: 'INTERRUPTED', path };
    const phase = state.phases[i];
    if (phase.done) continue;
    phase.superseded ??= [];
    phase.replans ??= 0;
    phase.answers ??= 0;
    // 현재 이 Phase가 Planner에게 주는 Goal. 원문에 Triage의 답이나 replan 맥락이 덧붙을 수 있다.
    phase.goal_text ??= goals[i].goal;

    if (!phase.plan_id) {
      const out = await runPlannerOnce({ goal: phase.goal_text, goalSource: goals[i].path, config, onLaunch: ({ planId }) => { phase.plan_id = planId; save(); } });
      phase.plan_id = out.planId;
      save();
    }
    emit({ event: 'phase', file: phase.file, plan_id: phase.plan_id });
    const loaded = loadPlan(phase.plan_id);
    const questions = loaded.report?.human_questions ?? [];
    if (questions.length) {
      const categories = loaded.report?.human_question_categories ?? questions.map(() => 'other');
      const answerable = triage && questions.every((_, k) => ANSWERABLE_CATEGORIES.has(categories[k]));
      if (answerable && phase.answers < config.limits.triage.max_answers_per_plan) {
        const t = await runTriageOnce({ kind: 'questions', config, planId: phase.plan_id, goal: phase.goal_text, questions, categories });
        emit({ event: 'triage', kind: 'questions', plan_id: phase.plan_id, decision: t.decision, detail: t.reason });
        if (t.decision === 'ANSWER') {
          phase.superseded.push({ plan_id: phase.plan_id, reason: 'questions answered by triage', triage: t.dir ?? null });
          phase.goal_text = renderAnsweredGoal({ goal: phase.goal_text, answers: t.answers });
          phase.answers += 1;
          emit({ event: 'answered', plan_id: phase.plan_id, superseded: phase.plan_id });
          phase.plan_id = null;
          save();
          i -= 1; // 같은 Phase를 다시 계획한다.
          continue;
        }
      }
      return { result: 'NEEDS_HUMAN', path, plan_id: phase.plan_id, detail: questions.join('\n') };
    }
    const approved = approvePlan(phase.plan_id);
    if (!approved.ok) return { result: 'NEEDS_HUMAN', path, detail: approved.reason, plan_id: phase.plan_id };
    const plan = resolveExecutablePlan(phase.plan_id);
    if (!plan.ok) return { result: 'NEEDS_HUMAN', path, detail: plan.reason };

    // replan은 start/quick 아래에서만 가능하다 — 이 명령이 그 Goal에 대한 계획 권한이기 때문이다.
    const runConfig = { ...config, replanCapable: triage, executionGoal: phase.goal_text };
    const run = await executePlan({ planId: phase.plan_id, taskIds: plan.taskIds, config: runConfig, emit, isInterrupted });
    writePlanExecutionReport(phase.plan_id, run);

    let replan = run.result === 'REPLAN' ? { reason: run.detail } : null;
    if (!replan && run.result === 'NEEDS_HUMAN' && run.stopReason === 'GOAL_CHECK_FAILED' && triage) {
      const t = await runTriageOnce({ kind: 'goal', config: runConfig, planId: phase.plan_id, goal: phase.goal_text, goalCheck: run.goalCheck, replanCapable: true });
      emit({ event: 'triage', kind: 'goal', plan_id: phase.plan_id, decision: t.decision, detail: t.reason });
      if (t.decision === 'REPLAN') replan = { reason: `goal check failed: ${run.goalCheck?.reason ?? ''}; triage: ${t.reason}` };
    }
    if (replan) {
      const usage = triageUsage({ planId: phase.plan_id, config });
      if (phase.replans >= usage.limits.max_replans_per_plan) {
        return { result: 'NEEDS_HUMAN', path, plan_id: phase.plan_id, detail: `replan budget exhausted (${phase.replans}/${usage.limits.max_replans_per_plan}); ${replan.reason}` };
      }
      const { dropped, done } = supersedePlanTasks(phase.plan_id);
      phase.replans += 1;
      phase.superseded.push({ plan_id: phase.plan_id, reason: replan.reason, dropped, done });
      phase.goal_text = renderReplanGoal({ goal: phase.goal_text, planId: phase.plan_id, detail: replan.reason, attempt: phase.replans, dropped, done });
      emit({ event: 'replan', attempt: phase.replans, superseded: phase.plan_id, dropped, done });
      phase.plan_id = null;
      save();
      i -= 1; // 같은 Phase를 새 Plan으로 다시 돈다.
      continue;
    }

    phase.done = run.result === 'DONE';
    phase.last_result = run.result;
    save();
    if (!phase.done) return { result: run.result, path, detail: run.detail, plan_id: phase.plan_id };
  }
  return { result: 'DONE', path };
}
