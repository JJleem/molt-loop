#!/usr/bin/env node
// loopctl — V0 Loop Runtime CLI.
//
// Runtime은 Task State의 유일한 Writer다. 상태를 바꾸는 경로는 `transition` 하나뿐이며,
// 그 안에서도 transitions.mjs의 표를 통과해야 한다.
// Gate 실행은 결정론적이며 LLM을 호출하지 않는다. Verifier는 Worker와 분리된 새 invocation이다.
// REVIEW -> DONE 전이는 Runtime이 만든 Verification Report가 PASS일 때만 일어난다.

import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ROOT, LOOP_DIR, LOCAL_DIR,
  loadAllTasks, isValid, isExample, isAutoDispatchable, isPaused, readyTasks, writeStatus,
  dependsOn, checkDependencies, taskGraphErrors, executionRoles,
} from './task-store.mjs';
import { STATES, TRANSITIONS, WORKER_REQUESTABLE } from './transitions.mjs';
import { buildContext, writeSnapshot } from './context-builder.mjs';
import { loadConfig } from './config.mjs';
import { runWorkerOnce } from './worker/runner.mjs';
import { detectAll } from './adapters/index.mjs';
import {
  resolveRunRef, checkEligibility, executeGateSuite, deriveVerifyReady,
  readGateReport, archivePriorGateEvidence, loadGateConfig, checkGateRefs,
} from './gate/runner.mjs';
import {
  checkVerifierEligibility, runVerifierOnce, verificationDirFor,
  readVerificationReport, archivePriorVerification,
} from './verifier/runner.mjs';
import { resolveSelfCheckGates, runSelfCheck, SELF_CHECK_DIR } from './gate/self-check.mjs';
import { REPORT_SCHEMA as GATE_REPORT_SCHEMA } from './gate/report.mjs';
import { REPORT_SCHEMA as VERIFICATION_REPORT_SCHEMA } from './verifier/report.mjs';
import { latestRunForTask } from './gate/runner.mjs';
import { assess, checkRetryEligibility, writeRetrySnapshot } from './recovery/retry.mjs';
import { readDiagnosis } from './recovery/diagnose.mjs';
import {
  startFirstAttempt, startRetryAttempt, stageWorker, stageGate, stageVerify,
} from './stages.mjs';
import { executeTask, claimExecution } from './loop/orchestrator.mjs';
import {
  readExecutionReport, latestExecutionFor, executionDir, listActiveMarkers, readActiveMarker,
  classifyActiveMarker, HEARTBEAT_STALE_MS,
} from './loop/execution-report.mjs';
import { recordManualExecution, shouldRecordManualExecution } from './loop/reconcile.mjs';
import { runPlannerOnce } from './planner/runner.mjs';
import { approvePlan } from './planner/approval.mjs';
import { loadPlan, listPlans, resolvePlanRef, PLANS_DIR } from './planner/store.mjs';
import {
  resolveExecutablePlan, executePlan, writePlanExecutionReport, listPlanExecutions,
} from './loop/plan-executor.mjs';
import { PLAN_REPORT_SCHEMA } from './planner/report.mjs';

const rel = (p) => relative(ROOT, p).split('\\').join('/');

// 목록 출력용 한 줄 요약. Planner가 만든 request는 여러 줄일 수 있다.
const oneLine = (s, max) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

// exit code 규약:  0 성공 · 1 요청한 작업이 실패하거나 거부됨 · 2 잘못된 CLI 사용법
const fail = (msg) => { console.error(msg); process.exitCode = 1; };
const usageError = (msg) => { console.error(msg); process.exitCode = 2; };

function reportErrors(tasks) {
  const broken = tasks.filter((t) => !isValid(t));
  if (broken.length === 0) return false;
  console.error('Invalid tasks:');
  for (const t of broken) for (const e of t.errors) console.error(`  ${e}`);
  return true;
}

/** id로 Task 하나를 찾는다. 없거나 유효하지 않으면 null과 함께 에러를 출력한다. */
function requireTask(id) {
  const tasks = loadAllTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    fail(`Task not found: ${id}\n  known: ${tasks.map((t) => t.id).join(', ') || '(none)'}`);
    return null;
  }
  if (!isValid(task)) {
    console.error(`Task is invalid, refusing to proceed:`);
    for (const e of task.errors) console.error(`  ${e}`);
    process.exitCode = 1;
    return null;
  }
  return task;
}

function cmdTasks() {
  const tasks = loadAllTasks();
  if (tasks.length === 0) return console.log('No tasks.');
  for (const t of tasks) {
    if (!isValid(t)) {
      console.log(`${t.id.padEnd(24)} ${'INVALID'.padEnd(12)} ${t.errors.length} error(s)`);
      continue;
    }
    const flags = [
      isExample(t) ? 'example' : null,
      !isAutoDispatchable(t) ? 'no-auto-dispatch' : null,
    ].filter(Boolean);
    const request = oneLine(t.data.request, 60);
    console.log(
      `${t.id.padEnd(24)} ${t.data.status.padEnd(12)} ${request}${flags.length ? `  [${flags.join(', ')}]` : ''}`
    );
  }
  reportErrors(tasks);
}

function cmdShow(id) {
  if (!id) return usageError('usage: loopctl show <TASK>');
  const task = requireTask(id);
  if (!task) return;
  const d = task.data;
  const out = [];
  out.push(`id:      ${d.id}`);
  out.push(`status:  ${d.status}`);
  out.push(`file:    ${rel(task.file)}`);
  out.push(`role:    ${d.execution.role}`);
  out.push('request:');
  for (const l of d.request.split('\n')) out.push(`  ${l}`);
  out.push(`flags:   ${[isExample(task) ? 'example' : null, !isAutoDispatchable(task) ? 'no-auto-dispatch' : null].filter(Boolean).join(', ') || '-'}`);
  // READY는 파생 상태다. 선행 Task를 알아야 하므로 저장소 전체를 기준으로 계산한다.
  const allTasks = loadAllTasks();
  const deps = checkDependencies(task, allTasks);
  out.push(`ready:   ${readyTasks(allTasks).some((t) => t.id === task.id)}`);
  const declaredDeps = dependsOn(task);
  if (declaredDeps.length > 0) {
    out.push(`depends_on: ${declaredDeps.join(', ')}`);
    if (!deps.met) {
      out.push(`  waiting on: ${[...deps.waiting_on, ...deps.missing.map((m) => `${m} (unresolved)`)].join(', ')}`);
    }
  }
  out.push('');
  out.push('stop_condition:');
  out.push(`  gates:                    ${d.stop_condition.gates.join(', ') || '(none)'}`);
  out.push(`  requires_verifier:        ${d.stop_condition.requires_verifier}`);
  out.push(`  max_consecutive_failures: ${d.stop_condition.max_consecutive_failures}`);
  out.push('');
  out.push(`acceptance_criteria (${d.acceptance_criteria.length}):`);
  for (const c of d.acceptance_criteria) {
    const v = c.verification;
    const how = v.type === 'gate' ? `gate:${v.ref}` : `verifier${v.instruction ? ' (+instruction)' : ''}`;
    out.push(`  [${c.id}] ${c.description}\n        판정: ${how}`);
  }
  out.push(`evidence (${d.evidence.length}):`);
  for (const e of d.evidence) out.push(`  ${e.kind}: ${e.path}`);
  out.push(`failure_memo (${d.failure_memo.length}):`);
  for (const m of d.failure_memo) out.push(`  attempt ${m.attempt} ${m.stage}/${m.error}: ${m.lesson}`);
  out.push('');
  out.push(`allowed transitions: ${TRANSITIONS[d.status].join(', ') || '(terminal)'}`);
  console.log(out.join('\n'));
}

function cmdReady() {
  const tasks = loadAllTasks();
  if (isPaused()) {
    console.log(`No ready tasks.  (PAUSE active: ${rel(join(LOCAL_DIR, 'PAUSE'))})`);
    return;
  }
  const ready = readyTasks(tasks);
  if (ready.length === 0) {
    console.log('No ready tasks.');
  } else {
    for (const t of ready) console.log(`${t.id.padEnd(24)} ${t.data.status.padEnd(8)} ${oneLine(t.data.request, 80)}`);
  }
  // 선행 Task를 기다리는 Task는 TODO 그대로 남는다. 왜 READY가 아닌지 보여준다.
  const readySet = new Set(ready.map((t) => t.id));
  const waiting = tasks.filter(
    (t) => isValid(t) && t.data.status === 'TODO' && !isExample(t) && isAutoDispatchable(t)
      && !readySet.has(t.id) && dependsOn(t).length > 0
  );
  if (waiting.length > 0) {
    console.log('');
    console.log('Waiting on dependencies:');
    for (const t of waiting) {
      const d = checkDependencies(t, tasks);
      const blockers = [...d.waiting_on, ...d.missing.map((m) => `${m} (unresolved)`)];
      console.log(`${t.id.padEnd(24)} waiting on: ${blockers.join(', ')}`);
    }
  }
  reportErrors(tasks);
}

/**
 * Gate 참조 preflight — 구조 검증(task-store)과 별개로 Runtime 설정에 대해 확인한다.
 * 예제 Task는 실행 대상이 아니므로 참조 해석을 요구하지 않는다.
 * @returns {{ configErrors: string[], refErrors: string[] }}
 */
function gatePreflight(tasks) {
  let gateConfig;
  try {
    gateConfig = loadGateConfig(loadConfig());
  } catch (e) {
    return { configErrors: [e.message], refErrors: [] };
  }
  const refErrors = [];
  for (const t of tasks) {
    if (!isValid(t) || isExample(t)) continue;
    refErrors.push(...checkGateRefs(t, gateConfig));
  }
  return { configErrors: gateConfig.errors, refErrors };
}

function reportGatePreflight(tasks) {
  const { configErrors, refErrors } = gatePreflight(tasks);
  if (configErrors.length > 0) {
    console.error('Gate configuration errors:');
    for (const e of configErrors) console.error(`  ${e}`);
  }
  if (refErrors.length > 0) {
    console.error('Gate reference errors:');
    for (const e of refErrors) console.error(`  ${e}`);
  }
  return configErrors.length + refErrors.length > 0;
}

/** Task 의존 그래프 검사 — 결정론적이다. LLM을 쓰지 않는다. */
function reportGraph(tasks) {
  const errors = taskGraphErrors(tasks);
  if (errors.length === 0) return false;
  console.error('Task dependency errors:');
  for (const e of errors) console.error(`  ${e}`);
  return true;
}

function cmdValidate() {
  const tasks = loadAllTasks();
  if (tasks.length === 0) return console.log('No tasks.');
  const structural = reportErrors(tasks);
  const gateProblems = reportGatePreflight(tasks);
  const graphProblems = reportGraph(tasks);
  if (structural || gateProblems || graphProblems) process.exitCode = 1;
  else console.log(`OK: ${tasks.length} task(s) valid, gate references resolve, dependency graph is a DAG.`);
}

function cmdTransition(id, to) {
  if (!id || !to) return usageError(`usage: loopctl transition <TASK> <${STATES.join('|')}>`);
  const task = requireTask(id);
  if (!task) return;
  const result = writeStatus(task, to.toUpperCase());
  if (!result.ok) return fail(result.reason);
  console.log(`${task.id}: ${result.from} -> ${result.to}`);
}

function cmdContext(id) {
  if (!id) return usageError('usage: loopctl context <TASK>');
  const task = requireTask(id);
  if (!task) return;
  process.stdout.write(buildContext(task).context);
}

function cmdSnapshot(id) {
  if (!id) return usageError('usage: loopctl snapshot <TASK>');
  const task = requireTask(id);
  if (!task) return;
  const { runId, runDir, manifest } = writeSnapshot(task);
  console.log(`${runId}`);
  console.log(`  dir:     ${rel(runDir)}`);
  console.log(`  context: context.md  sha256=${manifest.context_sha256.slice(0, 16)}...`);
  console.log(`  manifest: manifest.json`);
  console.log('  (no worker was launched — execution is not implemented yet)');
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtNum = (n) => n.toLocaleString('en-US');

function printUsage(usage) {
  console.log('Usage:');
  console.log(`  context: ${fmtBytes(usage.context.bytes)} (${fmtNum(usage.context.characters)} chars, ${usage.context.lines} lines)`);
  const t = usage.tokens;
  if (t.source === 'unavailable') {
    console.log('  tokens: unavailable');
  } else {
    const parts = ['input', 'output', 'cached_input', 'cache_creation_input', 'total']
      .filter((k) => Number.isFinite(t[k]))
      .map((k) => `${k}=${fmtNum(t[k])}`);
    console.log(`  tokens: ${parts.join(' ')} (${t.source})`);
  }
  console.log(`  process output: stdout ${fmtBytes(usage.process_output.stdout_bytes)}, stderr ${fmtBytes(usage.process_output.stderr_bytes)}`);
}

/** run — Task 하나에 대해 Worker를 한 번 실행한다. 재시도하지 않는다. */
async function cmdRun(id, ...flags) {
  if (!id) return usageError('usage: loopctl run <TASK> [--adapter <name>] [--timeout <seconds>] [--model <model>]');
  const opt = (name) => {
    const i = flags.indexOf(`--${name}`);
    return i === -1 ? null : flags[i + 1];
  };

  const task = requireTask(id);
  if (!task) return;

  const config = loadConfig();
  if (opt('adapter')) config.runtime.worker_adapter = opt('adapter');
  if (opt('timeout')) {
    const t = Number(opt('timeout'));
    if (!Number.isInteger(t) || t < 1) return usageError('--timeout must be an integer >= 1 (seconds)');
    config.runtime.worker_timeout_seconds = t;
  }
  if (opt('model')) config.runtime.worker_model = opt('model');

  // 1) 실행 자격 + TODO -> IN_PROGRESS + Snapshot (수동/자동이 같은 함수를 쓴다)
  const start = startFirstAttempt({ task, config });
  if (!start.ok) {
    for (const e of start.errors) console.error(e);
    process.exitCode = 1;
    return;
  }
  console.log(`${task.id}: ${start.claim.from} -> ${start.claim.to}`);
  console.log(`\nRun: ${start.snapshot.runId}`);
  console.log(`Worker: ${config.runtime.worker_adapter}`);
  const snapshot = start.snapshot;

  // 2) Worker 실행 + 전이 — 첫 시도와 재시도가 같은 경로를 쓴다.
  await finishWorkerRun({ task, snapshot, config, attempt: 1 });
}

/**
 * Worker를 실행하고, 관찰한 사실을 보고하고, 요청된 전이를 검증해서 적용한다.
 * `run`(첫 시도)과 `retry`(재시도)가 공유한다. Worker 실행 의미는 attempt 번호 말고 다르지 않다.
 */
async function finishWorkerRun({ task, snapshot, config, attempt }) {
  const stage = await stageWorker({ task, snapshot, config, attempt });
  if (stage.launchError) {
    console.error(`\nWorker could not be launched: ${stage.launchError}`);
    console.error(`Run artifacts: ${rel(snapshot.runDir)}`);
    console.error(`${task.id} remains IN_PROGRESS — no transition was applied.`);
    process.exitCode = 1;
    return;
  }

  const { envelope, workerResult, failures } = stage;
  console.log('\nWorker process finished');
  console.log(`Exit code: ${envelope.process.exit_code ?? '(none)'}${envelope.process.timed_out ? ' (timed out)' : ''}`);
  console.log(`Duration: ${(envelope.duration_ms / 1000).toFixed(1)}s`);

  if (workerResult) {
    console.log('\nWorker Result:');
    console.log(`  outcome: ${workerResult.outcome}`);
    console.log(`  requested_transition: ${workerResult.requested_transition ?? 'null'}`);
  }
  console.log('');
  printUsage(envelope.usage);

  console.log('\nObserved changed files:');
  if (envelope.observed_changes.count === 0) console.log('  (none)');
  else for (const f of envelope.observed_changes.files) console.log(`  ${f}`);

  if (failures.length > 0) {
    console.error('\nRun failed:');
    for (const f of failures) console.error(`  ${f}`);
    console.error(`\nRun artifacts preserved: ${rel(snapshot.runDir)}`);
    console.error(`${task.id} remains IN_PROGRESS — no transition was applied.`);
    console.error(`Diagnose it with: loopctl diagnose ${snapshot.runId}`);
    process.exitCode = 1;
    return;
  }

  // 전이는 stageWorker가 transition engine을 통해 이미 적용했다. 여기서는 보고만 한다.
  if (!stage.ok) {
    console.error(`\n${stage.failures.join('\n')}`);
    console.error(`${task.id} remains IN_PROGRESS.`);
    process.exitCode = 1;
    return;
  }
  const applied = stage.transition;
  if (applied === null) {
    console.log(`\n${task.id} remains IN_PROGRESS — worker requested no transition.`);
    return;
  }
  console.log(`\n${task.id}: ${applied.from} -> ${applied.to}`);
  console.log(applied.to === 'REVIEW'
    ? `Task is awaiting verification. Next: loopctl gate ${snapshot.runId}`
    : 'Task is blocked and needs a human decision.');
}

/** usage — 이미 기록된 Runtime Envelope의 telemetry를 보여준다. 새 계산도 AI 호출도 하지 않는다. */
function cmdUsage(ref) {
  if (!ref) return usageError('usage: loopctl usage <RUN|TASK>');
  // Run ID가 정본이다. Task ID는 Runtime의 결정론적 해석을 거치는 편의 입력일 뿐이다.
  const resolved = resolveRunRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const { run, selectedBy } = resolved;
  if (selectedBy === 'latest-run-for-task') {
    console.log(`Task: ${run.taskId}`);
    console.log(`Resolved Run: ${run.runId}`);
    console.log('');
  }
  const file = join(run.runDir, 'runtime-envelope.json');
  if (!existsSync(file)) return fail(`no runtime envelope for ${run.runId} (${rel(file)})`);
  const env = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${env.run_id}  task=${env.task_id}  adapter=${env.adapter}${env.model ? `  model=${env.model}` : ''}`);
  console.log(`attempt=${env.attempt}  duration=${(env.duration_ms / 1000).toFixed(1)}s  exit=${env.process.exit_code ?? '(none)'}${env.process.timed_out ? '  timed_out' : ''}`);
  console.log(`worker_result_valid=${env.worker_result_valid}  policy_violation=${env.policy_violation}`);
  console.log('');
  printUsage(env.usage);
  console.log(`  observed changed files: ${env.usage.observed_changed_files}`);
  if (env.usage.provider_cost_usd !== null) console.log(`  provider-reported cost: $${env.usage.provider_cost_usd.toFixed(4)}`);
}

const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * gate — 완료된 Worker Run 하나에 대해 필수 결정론적 Gate를 실행한다.
 *
 * LLM을 호출하지 않는다. Task 상태를 바꾸지 않는다. Worker를 다시 부르지 않는다.
 * Gate PASS는 "Verifier 단계로 갈 자격이 생겼다"는 뜻이지 Task 완료가 아니다.
 */
async function cmdGate(ref, ...flags) {
  if (!ref) return usageError('usage: loopctl gate <RUN|TASK> [--rerun]');
  const unknown = flags.filter((f) => f !== '--rerun');
  if (unknown.length > 0) return usageError(`unknown option(s): ${unknown.join(', ')}\nusage: loopctl gate <RUN|TASK> [--rerun]`);
  const rerun = flags.includes('--rerun');

  const resolved = resolveRunRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const { run, selectedBy } = resolved;

  if (!run.taskId) {
    return fail(`run ${run.runId}: manifest has no task_id (${run.manifestError ?? 'corrupt run metadata'})`);
  }
  const task = requireTask(run.taskId);
  if (!task) return;
  if (isExample(task)) return fail(`${task.id} is an example task and is not gateable.`);

  const config = loadConfig();
  const pre = await stageGate({ task, run, config, rerun, onGateFinish: null, dryRun: true });
  if (pre.refused && pre.errors.length > 0) {
    console.error(`Gate execution refused for ${run.runId}:`);
    for (const e of pre.errors) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  if (pre.duplicate) {
    const existing = pre.duplicate;
    console.error(`Gate report already exists for ${run.runId} (gate-report.json).`);
    console.error(existing.corrupt
      ? '  it is corrupt — rerun with --rerun to replace it (the old copy is preserved).'
      : `  previous result: ${existing.result}  (${existing.finished_at})`);
    console.error(`  re-run explicitly with: loopctl gate ${run.runId} --rerun`);
    process.exitCode = 1;
    return;
  }

  const { required } = pre.eligibility;

  if (selectedBy === 'latest-run-for-task') {
    console.log(`Task: ${task.id}`);
    console.log(`Resolved Run: ${run.runId}  (latest completed worker run)`);
  } else {
    console.log(`Run: ${run.runId}`);
    console.log(`Task: ${task.id}`);
  }
  console.log('');
  if (required.names.length === 0) {
    console.log(`Required Gates: 0  (this task declares no deterministic gate)`);
  } else {
    console.log('Required Gates:');
    for (const n of required.names) console.log(`  ${n}`);
  }
  console.log('');

  const nameWidth = Math.max(4, ...required.names.map((n) => n.length));
  const executed = await stageGate({
    task, run, config, rerun,
    onGateFinish: (g) => {
      const suffix = g.status === 'PASS' ? '' : `  ${g.error ?? `exit ${g.exit_code}`}`;
      console.log(`${`[${g.status}]`.padEnd(9)} ${g.name.padEnd(nameWidth)}  ${fmtSecs(g.duration_ms)}${suffix}`);
    },
  });
  if (executed.archived) console.log(`Preserved previous gate evidence: ${executed.archived}/`);
  const report = executed.report;
  const rp = executed.reportPath;

  console.log('');
  console.log(`Gate Result: ${report.result}`);
  if (report.no_gates_required) {
    console.log(`Required Gates: 0 — nothing failed at the deterministic layer.`);
    console.log(`(gates configured in project.yaml: ${report.configured_gates.join(', ') || 'none'})`);
  }
  const gateAcs = report.acceptance_criteria.filter((a) => a.verification === 'gate');
  if (gateAcs.length > 0) {
    console.log('');
    console.log('Gate-based acceptance criteria:');
    for (const a of gateAcs) console.log(`  ${a.id.padEnd(6)} ${a.gate.padEnd(nameWidth)}  ${a.status}`);
  }
  console.log('');
  console.log(`Report: ${rel(rp)}`);
  console.log(`Task remains ${task.data.status}.`);
  if (report.result === 'PASS') {
    console.log(deriveVerifyReady({ task, config }).ready
      ? 'Ready for independent verification.'
      : 'Deterministic layer passed. (verifier is not implemented yet)');
  } else {
    console.log('Verifier is not eligible.');
    console.log(`Diagnose it with: loopctl diagnose ${run.runId}`);
    process.exitCode = 1;
  }
}

/** verify-ready — 저장되지 않는 파생 상태를 계산해서 보여준다. LLM 호출 없음. */
function cmdVerifyReady() {
  const tasks = loadAllTasks();
  const config = loadConfig();
  const candidates = tasks.filter((t) => isValid(t) && !isExample(t) && t.data.status === 'REVIEW');

  const ready = [];
  const gatedButNoVerifier = [];
  const stale = [];
  for (const t of candidates) {
    const v = deriveVerifyReady({ task: t, config });
    if (v.ready) ready.push({ task: t, ...v });
    else if (v.stale && v.report && !v.report.corrupt && v.report.result === 'PASS') {
      stale.push({ task: t, ...v });
    } else if (v.report && !v.report.corrupt && v.report.result === 'PASS' && v.requiresVerifier === false) {
      gatedButNoVerifier.push({ task: t, ...v });
    }
  }

  if (ready.length === 0) console.log('No tasks ready for verifier.');
  for (const r of ready) {
    console.log(`${r.task.id.padEnd(12)} ${r.run.runId.padEnd(40)} ${r.task.data.status.padEnd(8)} GATES PASS`);
  }
  for (const r of gatedButNoVerifier) {
    console.log(`${r.task.id.padEnd(12)} ${r.run.runId.padEnd(40)} ${r.task.data.status.padEnd(8)} GATES PASS  (no verifier required)`);
  }
  // Gate는 통과했지만 그 뒤 저장소가 바뀐 경우 — 조용히 감추지 않고 이유를 보여준다.
  for (const r of stale) {
    console.log(`${r.task.id.padEnd(12)} ${r.run.runId.padEnd(40)} ${r.task.data.status.padEnd(8)} STALE — rerun gates`);
  }
  reportErrors(tasks);
}

/**
 * verify — VERIFY_READY인 Worker Run 하나에 대해 독립 Verifier를 1회 실행한다.
 *
 * Worker 세션을 재개하지 않는다. Worker의 narrative를 넘기지 않는다.
 * Verifier는 읽기 전용이며, 결과가 유효하고 Runtime Verification Report가 PASS일 때만
 * Runtime이 REVIEW -> DONE 전이를 수행한다. Verifier는 전이를 요청할 수 없다.
 */
async function cmdVerify(ref, ...flags) {
  const USAGE_LINE = 'usage: loopctl verify <RUN-ID|TASK-ID> [--rerun] [--adapter <name>] [--model <model>] [--timeout <seconds>]';
  if (!ref) return usageError(USAGE_LINE);
  const VALUED = new Set(['--adapter', '--model', '--timeout']);
  const opt = (n) => { const i = flags.indexOf(`--${n}`); return i === -1 ? null : flags[i + 1]; };
  for (let i = 0; i < flags.length; i += 1) {
    if (VALUED.has(flags[i])) { i += 1; continue; }
    if (flags[i] !== '--rerun') return usageError(`unknown option: ${flags[i]}\n${USAGE_LINE}`);
  }
  const rerun = flags.includes('--rerun');

  const resolved = resolveRunRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const { run, selectedBy } = resolved;
  if (!run.taskId) {
    return fail(`run ${run.runId}: manifest has no task_id (${run.manifestError ?? 'corrupt run metadata'})`);
  }
  const task = requireTask(run.taskId);
  if (!task) return;
  if (isExample(task)) return fail(`${task.id} is an example task and is not verifiable.`);

  const config = loadConfig();
  if (opt('adapter')) config.runtime.verifier_adapter = opt('adapter');
  if (opt('model')) config.runtime.verifier_model = opt('model');
  if (opt('timeout')) {
    const t = Number(opt('timeout'));
    if (!Number.isInteger(t) || t < 1) return usageError('--timeout must be an integer >= 1 (seconds)');
    config.runtime.verifier_timeout_seconds = t;
  }

  const pre = await stageVerify({ task, run, config, rerun, dryRun: true });
  if (pre.refused && pre.errors.length > 0) {
    console.error(`Verifier cannot run for ${run.runId}:`);
    for (const e of pre.errors) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  if (pre.duplicate) {
    const existing = pre.duplicate;
    console.error(`Verification already exists for ${run.runId}.`);
    console.error(existing.corrupt
      ? '  the existing report is corrupt.'
      : `  previous result: ${existing.result}  subject: ${existing.verification_subject_sha256?.slice(0, 16)}...  (${existing.finished_at})`);
    console.error('  Use --rerun to perform another paid verifier invocation.');
    process.exitCode = 1;
    return;
  }
  const eligibility = pre.eligibility;

  if (selectedBy === 'latest-run-for-task') {
    console.log(`Task: ${task.id}`);
    console.log(`Resolved Run: ${run.runId}  (latest completed worker run)`);
  } else {
    console.log(`Run: ${run.runId}`);
    console.log(`Task: ${task.id}`);
  }
  console.log('');
  console.log('Verification Subject:');
  console.log(`  sha256: ${eligibility.subject.sha256}`);
  console.log(`  head:   ${eligibility.subject.head ?? '(no commit)'}`);
  console.log('');
  console.log('Gate Result:');
  console.log(`  ${eligibility.gateReport.result}`);
  console.log('');

  const executed = await stageVerify({
    task, run, config, rerun,
    onLaunch: ({ adapter, version }) => {
      console.log('Launching independent verifier...');
      console.log(`Verifier: ${adapter}${version ? `  (${version})` : ''}`);
    },
  });
  if (executed.launchError) {
    console.error(`\nVerifier could not be launched: ${executed.launchError}`);
    console.error(`${task.id} remains ${task.data.status} — no transition was applied.`);
    process.exitCode = 1;
    return;
  }
  if (executed.archived) console.log(`Preserved previous verification artifacts: ${executed.archived}/`);

  const { verifierEnvelope: env, validation, reportPath: rp } = executed.outcome;
  const report = executed.report;
  console.log('');
  console.log('Verifier process finished');
  console.log(`Exit code: ${env.process.exit_code ?? '(none)'}${env.process.timed_out ? ' (timed out)' : ''}`);
  console.log(`Duration: ${(env.duration_ms / 1000).toFixed(1)}s`);

  console.log('');
  console.log('Verifier Result:');
  console.log(`  ${validation.valid ? validation.result.result : 'INVALID'}`);
  if (!validation.valid) for (const e of validation.errors) console.log(`    ${e}`);

  const verifierAcs = report.acceptance_criteria.filter((a) => a.verification_type === 'verifier');
  if (verifierAcs.length > 0) {
    console.log('');
    console.log('Verifier AC:');
    for (const a of verifierAcs) {
      console.log(`  [${a.status}] ${a.id}`);
      if (a.status !== 'PASS' && a.reason) console.log(`    ${a.reason}`);
    }
  }
  const gateAcs = report.acceptance_criteria.filter((a) => a.verification_type === 'gate');
  if (gateAcs.length > 0) {
    console.log('');
    console.log('Gate AC (deterministic, not re-judged):');
    for (const a of gateAcs) console.log(`  [${a.status}] ${a.id}  gate:${a.gate}`);
  }

  console.log('');
  printUsage(env.usage);
  if (env.usage.provider_cost_usd !== null) console.log(`  provider-reported cost: $${env.usage.provider_cost_usd.toFixed(4)}`);

  console.log('');
  console.log('Verification Result:');
  console.log(`  ${report.result}`);
  for (const b of report.blockers) console.log(`    - ${b}`);
  console.log('');
  console.log(`Report: ${rel(rp)}`);

  if (report.result !== 'PASS') {
    console.log(`\nTask remains ${task.data.status}.`);
    console.log(`Diagnose it with: loopctl diagnose ${run.runId}`);
    process.exitCode = 1;
    return;
  }
  // 전이는 stageVerify가 Verification Report PASS일 때만 transition engine을 통해 적용했다.
  if (!executed.transition) {
    console.error(`\n${executed.errors.join('\n')}`);
    console.error(`${task.id} remains ${task.data.status} despite a PASS verification report.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${task.id}: ${executed.transition.from} -> ${executed.transition.to}`);

  // 사람이 CLI로 이어 붙인 복구도 실행이다. 기록이 없으면 "latest execution"이
  // 멈춰 있던 옛 결과를 계속 가리킨다(OBS-004). 앞선 Report는 고치지 않는다.
  const should = shouldRecordManualExecution(task.id);
  if (should.record) {
    const rec = recordManualExecution({
      taskId: task.id,
      run,
      stages: ['gate', 'verify'],
      finalStatus: executed.transition.to,
      startedAt: new Date(env.started_at),
      events: [
        { stage: 'verifier', run_id: run.runId, result: report.result, verifier_result: report.verifier_result ?? 'INVALID' },
        { stage: 'stop', result: 'DONE', reason: 'MANUAL_RECOVERY' },
      ],
    });
    console.log(`Recorded this manual recovery as ${rec.execId}`);
    if (rec.supersedes) {
      console.log(`  it supersedes ${rec.supersedes}, which stays exactly as it was recorded`);
    }
  }
}

/** verification — 이미 기록된 Verification Report를 보여준다. 새 Verifier를 부르지 않는다. */
function cmdVerification(ref) {
  if (!ref) return usageError('usage: loopctl verification <RUN|TASK>');
  const resolved = resolveRunRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const { run } = resolved;
  const report = readVerificationReport(verificationDirFor(run.runDir));
  if (report === null) return fail(`no verification report for ${run.runId} (run \`loopctl verify ${run.runId}\` first)`);
  if (report.corrupt) return fail(`${run.runId}: verification-report.json is corrupt`);

  console.log(`${report.run_id}  task=${report.task_id}  attempt=${report.attempt}`);
  console.log(`subject: ${report.verification_subject_sha256}  stable=${report.verification_subject_stable}`);
  console.log(`gate: ${report.gate_result}   verifier: ${report.verifier_result ?? 'INVALID'}   result: ${report.result}`);
  console.log('');
  console.log('acceptance criteria:');
  for (const a of report.acceptance_criteria) {
    console.log(`  [${a.status.padEnd(4)}] ${a.id.padEnd(6)} ${a.verification_type}${a.gate ? `:${a.gate}` : ''}`);
    if (a.reason) console.log(`         ${a.reason}`);
  }
  if (report.verifier_reason) {
    console.log('');
    console.log(`verifier reason: ${report.verifier_reason}`);
  }
  if (report.blockers.length > 0) {
    console.log('');
    console.log('blockers:');
    for (const b of report.blockers) console.log(`  - ${b}`);
  }
}

/**
 * status — 운영자용 읽기 전용 요약. LLM을 호출하지 않고, 하위 프로세스도 띄우지 않는다.
 *
 * 새로운 저장 상태를 만들지 않는다. VERIFY READY 같은 항목은 전부 기존 Runtime 함수로
 * 그때그때 파생시킨다. 여기서 상태 판단 로직을 다시 구현하지 않는다.
 */
function cmdStatus() {
  const tasks = loadAllTasks();
  const config = loadConfig();
  const project = config.project?.name ?? '(unnamed project)';

  console.log(`Loop Runtime — ${project}`);
  if (isPaused()) console.log(`PAUSE active: ${rel(join(LOCAL_DIR, 'PAUSE'))}`);
  console.log('');

  if (tasks.length === 0) {
    console.log('No tasks in .loop/tasks/.');
    return;
  }

  const valid = tasks.filter(isValid);
  const readySet = new Set(readyTasks(tasks).map((t) => t.id));
  const verifyReady = [];

  /**
   * 이미 기록된 진단 artifact가 있으면 그것을 읽는다. 없으면 표시하지 않는다.
   * status에서 진단 로직을 다시 구현하지 않고, 새 진단을 만들지도 않는다(읽기 전용).
   */
  const recoveryLine = (runDir) => {
    const d = readDiagnosis(runDir);
    if (!d || d.corrupt || d.failure_class === null) return null;
    return `recovery: ${d.recommended_action.replace(/_/g, ' ')}  (${d.failure_class})`;
  };

  /** 기록된 Execution Report를 읽기만 한다. status에서 오케스트레이션을 다시 계산하지 않는다. */
  const executionLine = (taskId) => {
    const found = latestExecutionFor(taskId);
    if (!found) return null;
    const r = found.report;
    const origin = r.origin === 'manual' ? ' [manual recovery]' : '';
    // Report는 고쳐 쓰지 않는다. 그 뒤에 Task가 움직였다면 그 사실만 덧붙인다.
    const task = tasks.find((t) => t.id === taskId);
    const moved = task && r.final_task_status && task.data.status !== r.final_task_status
      ? `  [superseded — task is now ${task.data.status}]`
      : '';
    return `latest execution: ${r.result}  (${r.stop_reason})${origin}${moved}`;
  };

  /** 진행 중인 실행. Runtime이 남긴 표식만 읽는다 — 프로세스 테이블을 보지 않는다. */
  const activeLine = (taskId) => {
    const marker = readActiveMarker(taskId);
    if (!marker) return null;
    const live = classifyActiveMarker(marker);
    const where = marker.corrupt
      ? ''
      : `  stage: ${marker.stage ?? 'starting'}${marker.run_id ? `  run: ${marker.run_id}` : ''}`
        + `${marker.attempt ? `  attempt: ${marker.attempt}` : ''}`;
    return `execution ${live.state}: ${marker.execution_id ?? '(unknown)'}  (${live.reason})${where}`;
  };

  /** REVIEW인 Task 하나에 대한 파생 사실. 비싼 작업은 하지 않는다(파일 읽기 + git status). */
  const reviewDetail = (t) => {
    const lines = [];
    const v = deriveVerifyReady({ task: t, config });
    if (!v.run) {
      lines.push('latest run: (none)');
      return lines;
    }
    lines.push(`latest run: ${v.run.runId}`);
    const gate = v.report;
    if (gate === null) lines.push('gates: not run');
    else if (gate.corrupt) lines.push('gates: report corrupt');
    else lines.push(`gates: ${gate.result}${gate.no_gates_required ? ' (no gates required)' : ''}${v.stale ? '  [STALE — rerun gates]' : ''}`);

    const vr = readVerificationReport(verificationDirFor(v.run.runDir));
    if (vr && !vr.corrupt) {
      lines.push(`verifier: ${vr.verifier_result ?? 'INVALID'}  (verification: ${vr.result})`);
    } else if (v.ready) {
      lines.push('verifier: ready');
      verifyReady.push({ task: t, run: v.run });
    } else if (!v.requiresVerifier) {
      lines.push('verifier: not required');
    } else {
      lines.push('verifier: not eligible');
    }
    const rec = recoveryLine(v.run.runDir);
    if (rec) lines.push(rec);
    const ex = executionLine(t.id);
    if (ex) lines.push(ex);
    return lines;
  };

  /** Worker 단계에서 멈춘 Task. 실패했다면 기록된 진단을 그대로 보여준다. */
  const inProgressDetail = (t) => {
    const activeNow = activeLine(t.id);
    const run = latestRunForTask(t.id);
    if (!run) return activeNow ? [activeNow, 'latest run: (none)'] : ['latest run: (none)'];
    const lines = activeNow ? [activeNow, `latest run: ${run.runId}`] : [`latest run: ${run.runId}`];
    const d = readDiagnosis(run.runDir);
    if (d && !d.corrupt && d.failure_class !== null && d.stage === 'worker') {
      lines.push(`worker: failed (${d.failure_class})`);
      lines.push(`recovery: ${d.recommended_action.replace(/_/g, ' ')}`);
    }
    const ex = executionLine(t.id);
    if (ex) lines.push(ex);
    return lines;
  };

  const section = (title, rows) => {
    console.log(title);
    if (rows.length === 0) console.log('  none');
    else for (const r of rows) console.log(r);
    console.log('');
  };

  const plain = (t) => {
    const head = `  ${t.id.padEnd(20)} ${oneLine(t.data.request, 52)}`;
    const lines = [activeLine(t.id), executionLine(t.id)].filter(Boolean);
    return lines.length > 0 ? `${head}\n      ${lines.join('\n      ')}` : head;
  };
  const inState = (st) => valid.filter((t) => t.data.status === st && !isExample(t));

  // 진행 중인 실행을 가장 먼저 보여준다. 세션이 끊긴 뒤 가장 먼저 알아야 하는 사실이다.
  const active = listActiveMarkers();
  if (active.length > 0) {
    console.log('ACTIVE EXECUTION');
    for (const { taskId, marker } of active) {
      const live = classifyActiveMarker(marker);
      console.log(`  ${taskId.padEnd(20)} ${live.state}`);
      console.log(`      ${activeLine(taskId)}`);
      if (live.state === 'STALE') {
        console.log(`      the runtime stopped updating this marker; \`loopctl execute ${taskId}\` will reclaim it`);
      }
    }
    console.log(`  (liveness comes from the runtime's own heartbeat, not from process liveness;`
      + ` stale after ${Math.round(HEARTBEAT_STALE_MS / 1000)}s)`);
    console.log('');
  }

  section('READY', valid.filter((t) => readySet.has(t.id)).map(plain));

  const todoNotReady = valid.filter((t) => t.data.status === 'TODO' && !readySet.has(t.id) && !isExample(t));
  if (todoNotReady.length > 0) {
    section('TODO (not dispatchable)', todoNotReady.map((t) => {
      const d = checkDependencies(t, tasks);
      // 새 저장 상태를 만들지 않는다. TODO 그대로 두고 왜 READY가 아닌지만 보여준다.
      const why = !d.met
        ? `waiting on: ${[...d.waiting_on, ...d.missing.map((m) => `${m} (unresolved)`)].join(', ')}`
        : (isAutoDispatchable(t) ? 'paused' : 'auto_dispatch: false');
      return `${plain(t)}  [${why}]`;
    }));
  }

  const inProgress = inState('IN_PROGRESS');
  console.log('IN PROGRESS');
  if (inProgress.length === 0) console.log('  none');
  for (const t of inProgress) {
    console.log(`  ${t.id}`);
    for (const l of inProgressDetail(t)) console.log(`    ${l}`);
  }
  console.log('');

  const review = inState('REVIEW');
  console.log('REVIEW');
  if (review.length === 0) console.log('  none');
  for (const t of review) {
    console.log(`  ${t.id}`);
    for (const l of reviewDetail(t)) console.log(`    ${l}`);
  }
  console.log('');

  section('VERIFY READY', verifyReady.map((v) => `  ${v.task.id.padEnd(20)} ${v.run.runId}`));
  section('BLOCKED', inState('BLOCKED').map(plain));
  section('DONE', inState('DONE').map(plain));

  const other = valid.filter((t) => isExample(t) || (t.data.status === 'DROPPED' && !isExample(t)));
  if (other.length > 0) section('DROPPED / EXAMPLE', other.map(plain));

  // 승인 대기 중인 Plan은 Task 운영 상태가 아니다. 한 줄로만 알린다.
  const pendingPlans = listPlans()
    .map((id) => loadPlan(id))
    .filter((p) => p.ok && p.report && !p.report.corrupt && p.report.approvable && !p.report.approved);
  if (pendingPlans.length > 0) {
    section('UNAPPROVED PLANS', pendingPlans.map((p) => `  ${p.planId.padEnd(24)} ${p.report.task_count} task(s)  — loopctl plan-show ${p.planId}`));
  }

  const graphErrors = taskGraphErrors(tasks);
  if (graphErrors.length > 0) {
    console.log('DEPENDENCY ERRORS');
    for (const e of graphErrors) console.log(`  ${e}`);
    console.log('');
    process.exitCode = 1;
  }

  const broken = tasks.filter((t) => !isValid(t));
  if (broken.length > 0) {
    console.log('INVALID');
    for (const t of broken) console.log(`  ${t.id.padEnd(20)} ${t.errors.length} error(s) — run \`loopctl validate\``);
    console.log('');
    process.exitCode = 1;
  }
}

function cmdVersion() {
  console.log(VERSION_TEXT);
}

function cmdHelp() {
  console.log(HELP);
}

/**
 * diagnose — 실패한 Run을 결정론적으로 진단한다. 읽기 전용이며 **LLM을 호출하지 않는다.**
 * Worker를 띄우지 않는다. retry와 같은 진단 경로를 쓴다(로직을 복제하지 않는다).
 */
function cmdDiagnose(ref) {
  if (!ref) return usageError('usage: loopctl diagnose <RUN|TASK>');
  const resolved = resolveRunRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const { run, selectedBy } = resolved;
  if (!run.taskId) return fail(`run ${run.runId}: manifest has no task_id (corrupt run metadata)`);
  const task = requireTask(run.taskId);
  if (!task) return;

  const config = loadConfig();
  const { diagnosis: d, memo, memoReason, budget } = assess({ task, run, config });

  if (selectedBy === 'latest-run-for-task') {
    console.log(`Task: ${task.id}`);
    console.log(`Resolved Run: ${run.runId}  (latest completed worker run)`);
  } else {
    console.log(`Run: ${run.runId}`);
    console.log(`Task: ${task.id}`);
  }
  console.log('');

  if (d.failure_class === null) {
    console.log('No failure recorded for this run.');
    console.log(`Recommended action: ${d.recommended_action}`);
    return;
  }

  console.log(`Stage: ${d.stage}`);
  console.log(`Failure: ${d.failure_class}`);
  console.log(`Retryable: ${d.retryable ? 'yes' : 'no'}`);
  console.log(`Recommended action: ${d.recommended_action}`);
  console.log(`Reason: ${d.reason}`);

  if (d.failed_gates.length > 0) {
    console.log('');
    console.log('Failed Gates:');
    for (const g of d.failed_gates) console.log(`  ${g.name} — ${g.status}${g.exit_code === null ? '' : ` (exit ${g.exit_code})`}`);
  }
  if (d.failed_criteria.length > 0) {
    console.log('');
    console.log('Failed Criteria:');
    for (const c of d.detail?.failed_criteria_detail ?? []) {
      console.log(`  ${c.id} — ${(c.reason ?? '').split('\n')[0].slice(0, 160)}`);
    }
  }

  console.log('');
  console.log(`Attempts: ${budget.used.attempts} / ${budget.limits.max_attempts}   consecutive failures: ${budget.used.consecutiveFailures} / ${budget.limits.max_consecutive_failures}`);
  console.log(`Failure fingerprint: ${d.failure_fingerprint.slice(0, 16)}`);
  console.log(`Subject bound: ${d.subject_check?.matches ? 'unchanged since the failure' : 'CHANGED or unknown'}`);

  if (memo) {
    console.log('');
    console.log('Failure Memo:');
    console.log(`  ${memo.lesson}`);
    if (memo.recovery_hint) console.log(`  hint: ${memo.recovery_hint}`);
  } else if (memoReason) {
    console.log('');
    console.log(`Failure Memo: not generated (${memoReason})`);
  }

  console.log('');
  if (d.retryable && budget.allowed) {
    console.log(`Next attempt:  Worker attempt ${budget.nextAttempt}`);
    console.log(`  run: loopctl retry ${run.runId}`);
  } else if (d.retryable) {
    console.log('Retry is not available:');
    for (const r of budget.reasons) console.log(`  ${r}`);
  } else {
    console.log(`No worker retry. Recommended action: ${d.recommended_action}`);
  }
}

/**
 * retry — 진단에 근거한 Worker Attempt를 **정확히 한 번** 실행한다.
 * Gate도 Verifier도 자동으로 부르지 않는다. 그 조합은 Step 7의 몫이다.
 */
async function cmdRetry(ref, ...flags) {
  const USAGE_LINE = 'usage: loopctl retry <RUN|TASK> [--adapter <name>] [--timeout <seconds>] [--model <model>]';
  if (!ref) return usageError(USAGE_LINE);
  const VALUED = new Set(['--adapter', '--model', '--timeout']);
  const opt = (n) => { const i = flags.indexOf(`--${n}`); return i === -1 ? null : flags[i + 1]; };
  for (let i = 0; i < flags.length; i += 1) {
    if (VALUED.has(flags[i])) { i += 1; continue; }
    return usageError(`unknown option: ${flags[i]}\n${USAGE_LINE}`);
  }

  const resolved = resolveRunRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const { run } = resolved;
  if (!run.taskId) return fail(`run ${run.runId}: manifest has no task_id (corrupt run metadata)`);
  const task = requireTask(run.taskId);
  if (!task) return;

  const config = loadConfig();
  if (opt('adapter')) config.runtime.worker_adapter = opt('adapter');
  if (opt('model')) config.runtime.worker_model = opt('model');
  if (opt('timeout')) {
    const t = Number(opt('timeout'));
    if (!Number.isInteger(t) || t < 1) return usageError('--timeout must be an integer >= 1 (seconds)');
    config.runtime.worker_timeout_seconds = t;
  }

  const started = startRetryAttempt({ task, run, config });
  if (!started.ok) {
    console.error('Retry refused:');
    for (const e of started.errors) console.error(`  ${e}`);
    const action = started.pre?.assessment?.diagnosis?.recommended_action;
    if (action && !['RETRY', 'RETRY_WITH_HINT'].includes(action)) {
      console.error('');
      console.error(`Recommended action: ${action}`);
    }
    process.exitCode = 1;
    return;
  }
  const pre = started.pre;
  const d = pre.assessment.diagnosis;
  console.log(`Task: ${task.id}`);
  console.log(`Source Run: ${run.runId}`);
  console.log(`Failure: ${d.failure_class}`);
  console.log(`Attempt: ${d.attempt}`);
  if (pre.memos.length > 0) {
    console.log('');
    console.log('Failure Memo:');
    for (const m of pre.memos) console.log(`  [attempt ${m.attempt}] ${m.lesson}`);
  }
  console.log('');
  console.log(`Starting Worker attempt ${pre.nextAttempt}...`);

  // 전이(REVIEW -> IN_PROGRESS)와 Snapshot은 startRetryAttempt가 이미 수행했다.
  if (started.transition) console.log(`${task.id}: ${started.transition.from} -> ${started.transition.to}`);
  const snapshot = started.snapshot;
  console.log(`\nRun: ${snapshot.runId}`);
  console.log(`Worker: ${config.runtime.worker_adapter}   attempt ${pre.nextAttempt}`);

  await finishWorkerRun({ task, snapshot, config, attempt: pre.nextAttempt });
}

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * execute — Task 하나를 정지 조건에 도달할 때까지 자동으로 돌린다.
 *
 * Worker · Gate · Verifier · Diagnose · Retry는 전부 기존 모듈을 그대로 부른다.
 * 다음에 무엇을 할지도, 멈출지 말지도 전부 결정론적으로 정한다 — 추가 LLM 호출은 없다.
 * Task 하나만 실행한다. 여러 Task를 훑지 않는다.
 */
async function cmdExecute(id, ...flags) {
  const USAGE_LINE = 'usage: loopctl execute <TASK> [--timeout <seconds>] [--adapter <name>] [--model <model>]';
  if (!id) return usageError(USAGE_LINE);
  const VALUED = new Set(['--timeout', '--adapter', '--model', '--verifier-adapter', '--verifier-model']);
  const opt = (n) => { const i = flags.indexOf(`--${n}`); return i === -1 ? null : flags[i + 1]; };
  for (let i = 0; i < flags.length; i += 1) {
    if (VALUED.has(flags[i])) { i += 1; continue; }
    return usageError(`unknown option: ${flags[i]}\n${USAGE_LINE}`);
  }

  const task = requireTask(id);
  if (!task) return;
  if (isExample(task)) return fail(`${task.id} is the example task and is never executed.`);
  if (task.data.status === 'DROPPED') return fail(`${task.id} is DROPPED; execution is refused.`);
  if (isPaused()) {
    return fail(`PAUSE is active (${rel(join(LOCAL_DIR, 'PAUSE'))}).\n  Remove that file to execute tasks.`);
  }

  const config = loadConfig();
  if (opt('adapter')) config.runtime.worker_adapter = opt('adapter');
  if (opt('model')) config.runtime.worker_model = opt('model');
  if (opt('verifier-adapter')) config.runtime.verifier_adapter = opt('verifier-adapter');
  if (opt('verifier-model')) config.runtime.verifier_model = opt('verifier-model');
  let deadlineMs = null;
  if (opt('timeout')) {
    const t = Number(opt('timeout'));
    if (!Number.isInteger(t) || t < 1) return usageError('--timeout must be an integer >= 1 (seconds)');
    deadlineMs = Date.now() + t * 1000;
  }

  // Lease가 아니다. 같은 Task를 도는 명백한 중복 오케스트레이터만 막는다.
  const claim = claimExecution(task.id);
  if (!claim.ok) return fail(`Execution refused:\n  ${claim.reason}`);
  if (claim.reclaimed) console.log(`(reclaimed a stale execution marker from ${claim.reclaimed})`);

  // Ctrl+C: 새 단계를 예약하지 않는다. 진행 중인 단계는 기존 취소 동작을 그대로 쓴다.
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n(interrupt requested — finishing the current stage, then stopping. Ctrl+C again to abort now.)');
  };
  process.on('SIGINT', onSigint);

  let currentAttempt = null;
  const emit = (e) => {
    switch (e.stage) {
      case 'worker': {
        if (e.attempt !== currentAttempt) {
          currentAttempt = e.attempt;
          console.log(`\nAttempt ${e.attempt}`);
        }
        console.log('\n[Worker]');
        console.log(`  ${e.failures?.length ? `failed: ${e.failures.join('; ')}` : `success -> ${e.result}`}`);
        console.log(`  Run: ${e.run_id}`);
        break;
      }
      case 'gate':
        console.log('\n[Gate]');
        console.log(`  ${e.result}`);
        for (const g of e.gates) console.log(`    ${g.name} ${g.status}`);
        break;
      case 'verifier':
        console.log('\n[Verifier]');
        console.log(`  ${e.verifier_result}  (verification: ${e.result})`);
        if (e.transition) console.log(`  ${task.id}: ${e.transition}`);
        break;
      case 'diagnose':
        console.log('\n[Diagnose]');
        console.log(`  ${e.result}`);
        console.log(`  Action: ${e.action}`);
        break;
      case 'guard':
        console.log(`\n[Guard] ${e.result} after ${e.transitions} stage transitions`);
        break;
      default:
        break;
    }
  };

  console.log(`Task: ${task.id}`);
  let out;
  try {
    out = await executeTask({
      taskId: task.id, config, emit, deadlineMs, isInterrupted: () => interrupted,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }

  const r = out.report;
  console.log(`\nExecution: ${out.execId}`);
  console.log(`Execution Result: ${r.result}`);
  console.log(`Attempts: ${r.attempts.length}`);
  console.log(`Duration: ${fmtDuration(r.duration_ms)}`);
  console.log(`Task status: ${r.final_task_status}`);

  if (r.result !== 'DONE') {
    const last = r.events.filter((e) => e.stage === 'diagnose').pop();
    if (last) {
      console.log('');
      console.log('Latest failure:');
      console.log(`  Class: ${last.result}`);
      console.log(`  Action: ${last.action}`);
    }
    console.log('');
    console.log(`Stop reason: ${r.stop_reason}`);
    const stopEvent = r.events.filter((e) => e.stage === 'stop').pop();
    if (stopEvent?.detail) console.log(`  ${stopEvent.detail}`);
    console.log('');
    console.log('Inspect:');
    console.log(`  loopctl diagnose ${task.id}`);
    console.log('  loopctl status');
  }
  const u = r.usage_summary;
  console.log('');
  console.log(`LLM invocations: ${u.llm_invocations} (worker ${u.worker_invocations}, verifier ${u.verifier_invocations}) · gate runs: ${u.gate_invocations} (0 tokens)`);
  if (u.provider_cost_usd_known !== null) {
    console.log(`Provider-reported cost (known): $${u.provider_cost_usd_known.toFixed(4)}${u.unknown_cost_invocations > 0 ? `  (+${u.unknown_cost_invocations} invocation(s) with unknown cost)` : ''}`);
  } else if (u.llm_invocations > 0) {
    console.log(`Provider-reported cost: unavailable for all ${u.llm_invocations} invocation(s)`);
  }
  console.log(`Report: ${rel(out.reportPath)}`);

  if (r.result !== 'DONE') process.exitCode = 1;
}

/**
 * execute-plan — 승인된 Plan의 Task를 **한 번에 하나씩** 끝까지 실행한다.
 *
 * 오케스트레이션 판단(다음에 무엇을 실행할지)은 전부 결정론적이며 LLM을 부르지 않는다.
 * Task 하나의 Worker · Gate · Verifier · Diagnose · Retry는 `execute`가 그대로 소유한다.
 * shared working tree이므로 Task를 동시에 실행하지 않는다.
 *
 * 같은 명령을 다시 실행하면 남은 Task부터 이어간다 — Task 상태가 곧 재시작 지점이다.
 */
async function cmdExecutePlan(ref, ...flags) {
  const USAGE_LINE = 'usage: loopctl execute-plan <PLAN> [--timeout <seconds>] [--adapter <name>] [--model <model>]';
  if (!ref) return usageError(USAGE_LINE);
  const VALUED = new Set(['--timeout', '--adapter', '--model', '--verifier-adapter', '--verifier-model']);
  const opt = (n) => { const i = flags.indexOf(`--${n}`); return i === -1 ? null : flags[i + 1]; };
  for (let i = 0; i < flags.length; i += 1) {
    if (VALUED.has(flags[i])) { i += 1; continue; }
    return usageError(`unknown option: ${flags[i]}\n${USAGE_LINE}`);
  }

  const resolvedRef = resolvePlanRef(ref);
  if (!resolvedRef.ok) return fail(resolvedRef.reason);
  const plan = resolveExecutablePlan(resolvedRef.planId);
  if (!plan.ok) return fail(plan.reason);

  if (isPaused()) {
    return fail(`PAUSE is active (${rel(join(LOCAL_DIR, 'PAUSE'))}).\n  Remove that file to execute tasks.`);
  }

  const config = loadConfig();
  if (opt('adapter')) config.runtime.worker_adapter = opt('adapter');
  if (opt('model')) config.runtime.worker_model = opt('model');
  if (opt('verifier-adapter')) config.runtime.verifier_adapter = opt('verifier-adapter');
  if (opt('verifier-model')) config.runtime.verifier_model = opt('verifier-model');
  let deadlineMs = null;
  if (opt('timeout')) {
    const t = Number(opt('timeout'));
    if (!Number.isInteger(t) || t < 1) return usageError('--timeout must be an integer >= 1 (seconds)');
    deadlineMs = Date.now() + t * 1000;
  }

  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n(interrupt requested — finishing the current task, then stopping. Ctrl+C again to abort now.)');
  };
  process.on('SIGINT', onSigint);

  console.log(`Plan: ${plan.planId}`);
  console.log(`Tasks: ${plan.taskIds.join(', ')}`);
  console.log('One task at a time — this runtime shares one working tree.');

  let currentAttempt = null;
  const emit = (e) => {
    switch (e.event) {
      case 'task-start':
        currentAttempt = null;
        console.log(`\n${'='.repeat(56)}`);
        console.log(`Task: ${e.task_id}`);
        break;
      case 'task-end':
        console.log(`\n${e.task_id}: ${e.result}  (${e.execution_id})`);
        break;
      case 'stage':
        if (e.stage === 'worker') {
          if (e.attempt !== currentAttempt) {
            currentAttempt = e.attempt;
            console.log(`\nAttempt ${e.attempt}`);
          }
          console.log('  [Worker] ' + (e.failures?.length ? `failed: ${e.failures.join('; ')}` : `success -> ${e.result}`));
        } else if (e.stage === 'gate') {
          console.log(`  [Gate] ${e.result}  (${e.gates.map((g) => `${g.name} ${g.status}`).join(', ') || 'none required'})`);
        } else if (e.stage === 'verifier') {
          console.log(`  [Verifier] ${e.verifier_result}  (verification: ${e.result})`);
        } else if (e.stage === 'diagnose') {
          console.log(`  [Diagnose] ${e.result} -> ${e.action}`);
        }
        break;
      default:
        break;
    }
  };

  let run;
  try {
    run = await executePlan({
      planId: plan.planId, taskIds: plan.taskIds, config, emit, deadlineMs,
      isInterrupted: () => interrupted,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }

  const written = writePlanExecutionReport(plan.planId, run);
  const u = written.report.usage_summary;

  console.log(`\n${'='.repeat(56)}`);
  console.log(`Plan Execution: ${written.report.plan_execution_id}`);
  console.log(`Plan Result: ${run.result}   stop_reason: ${run.stopReason}`);
  if (run.detail) console.log(`  ${run.detail}`);
  console.log(`Duration: ${fmtDuration(written.report.duration_ms)}`);
  console.log('');
  console.log('Tasks executed this run:');
  if (run.executions.length === 0) console.log('  (none)');
  for (const e of run.executions) {
    console.log(`  ${e.task_id.padEnd(20)} ${e.result.padEnd(12)} attempts=${e.attempts}  ${fmtDuration(e.duration_ms)}  ${e.execution_id}`);
  }
  console.log('');
  console.log(`LLM invocations: ${u.llm_invocations} · gate runs: ${u.gate_invocations}`
    + ` · orchestration llm calls: ${written.report.orchestration_llm_calls}`);
  if (u.provider_cost_usd_known !== null) {
    console.log(`Provider-reported cost (known): $${u.provider_cost_usd_known.toFixed(4)}`
      + `${u.executions_with_unknown_cost > 0 ? `  (+${u.executions_with_unknown_cost} execution(s) with unknown cost)` : ''}`);
  }
  console.log(`Report: ${rel(written.path)}`);

  if (run.result !== 'DONE') {
    console.log('');
    console.log('Inspect:');
    console.log(`  loopctl status`);
    const last = run.executions[run.executions.length - 1];
    if (last) console.log(`  loopctl diagnose ${last.task_id}`);
    console.log(`  re-running \`loopctl execute-plan ${plan.planId}\` resumes from the remaining tasks`);
    process.exitCode = 1;
  }
}

/** execution — 기록된 Execution Report를 보여준다. AI 호출도 상태 변경도 없다. */
function cmdExecution(ref) {
  if (!ref) return usageError('usage: loopctl execution <EXEC-ID|TASK>');
  let execId = null;
  let report = null;
  if (ref.startsWith('EXEC-')) {
    execId = ref;
    report = readExecutionReport(ref);
    if (report === null) return fail(`no execution report for ${ref} (${rel(executionDir(ref))})`);
  } else {
    const found = latestExecutionFor(ref);
    if (!found) return fail(`no execution found for ${ref}`);
    ({ execId, report } = found);
    console.log(`Task: ${ref}`);
    console.log(`Resolved Execution: ${execId}  (latest)`);
    console.log('');
  }
  if (report.corrupt) return fail(`${execId}: execution-report.json is corrupt`);

  console.log(`${report.execution_id}  task=${report.task_id}${report.origin === 'manual' ? '  origin: manual recovery' : ''}`);
  console.log(`result: ${report.result}   stop_reason: ${report.stop_reason}   task status: ${report.final_task_status}`);
  if (report.supersedes) console.log(`supersedes: ${report.supersedes}  (that report is left exactly as it was recorded)`);
  if (Array.isArray(report.manual_stages) && report.manual_stages.length > 0) {
    console.log(`manual stages: ${report.manual_stages.join(' -> ')}`);
  }
  console.log(`duration: ${fmtDuration(report.duration_ms)}   stage transitions: ${report.stage_transitions} / guard ${report.loop_guard.limit}`);
  console.log('');
  console.log('attempts:');
  if (report.attempts.length === 0) console.log('  (none)');
  for (const a of report.attempts) {
    console.log(`  ${String(a.attempt).padEnd(3)} ${a.run_id ?? '(no run)'}`);
    console.log(`      worker: ${a.worker ?? '-'}   gate: ${a.gate ?? '-'}   verifier: ${a.verifier ?? '-'}`
      + `${a.diagnosis ? `   diagnosis: ${a.diagnosis} -> ${a.action}` : ''}`);
  }
  console.log('');
  console.log('timeline:');
  for (const e of report.events) {
    console.log(`  ${e.stage.padEnd(9)} ${e.result ?? ''}${e.run_id ? `  ${e.run_id}` : ''}${e.reason ? `  ${e.reason}` : ''}`);
  }
  const u = report.usage_summary;
  console.log('');
  console.log(`usage: ${u.llm_invocations} llm invocation(s), ${u.gate_invocations} gate run(s)`);
  console.log(`  known provider cost: ${u.provider_cost_usd_known === null ? 'none reported' : `$${u.provider_cost_usd_known.toFixed(4)}`}`
    + `   unknown-cost invocations: ${u.unknown_cost_invocations}`);
  console.log(`  tokens: ${u.tokens_aggregate.source}`);
}

// ============================================================
// Goal Planning — plan / plan-show / plans / plan-approve
//
// `plan` 만이 LLM 단계다. plan-show · plans · plan-approve 는 AI를 호출하지 않는다.
// Planner는 Task를 만들지 않는다. Task를 만드는 것은 plan-approve 하나뿐이다.
// ============================================================

/** 제안 목록을 결정론적 위상 순서로 출력한다. 배열 순서를 근거로 삼지 않는다. */
function printProposals(tasks, order) {
  const byId = new Map(tasks.map((t) => [t.proposal_id, t]));
  const seq = order.length === tasks.length ? order : tasks.map((t) => t.proposal_id);
  for (const pid of seq) {
    const t = byId.get(pid);
    if (!t) continue;
    console.log(`${pid.padEnd(4)}${t.title}`);
    if (t.depends_on.length > 0) console.log(`    depends on: ${t.depends_on.join(', ')}`);
  }
}

function printPlanUsage(usage) {
  console.log('Planner usage:');
  console.log(`  context: ${fmtBytes(usage.context.bytes)} (${fmtNum(usage.context.characters)} chars, ${usage.context.lines} lines)`);
  const t = usage.tokens;
  if (t.source === 'unavailable') {
    console.log('  tokens: unavailable');
  } else {
    const parts = ['input', 'output', 'cached_input', 'cache_creation_input', 'total']
      .filter((k) => Number.isFinite(t[k]))
      .map((k) => `${k}=${fmtNum(t[k])}`);
    console.log(`  tokens: ${parts.join(' ')} (${t.source})`);
  }
  console.log(`  process output: stdout ${fmtBytes(usage.process_output.stdout_bytes)}, stderr ${fmtBytes(usage.process_output.stderr_bytes)}`);
  if (usage.provider_cost_usd !== null) console.log(`  provider-reported cost: $${usage.provider_cost_usd.toFixed(4)}`);
}

/** plan — Goal 하나를 Task 제안으로 분해한다. **이 단계만 AI를 호출한다.** Task를 만들지 않는다. */
async function cmdPlan(...argv) {
  const USAGE_LINE = 'usage: loopctl plan "<GOAL>" [--file <path>] [--adapter <name>] [--model <model>] [--timeout <seconds>]';
  const VALUED = new Set(['--file', '--adapter', '--model', '--timeout']);
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUED.has(a)) {
      if (argv[i + 1] === undefined) return usageError(`${a} requires a value\n${USAGE_LINE}`);
      opts[a.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith('--')) return usageError(`unknown option: ${a}\n${USAGE_LINE}`);
    positional.push(a);
  }

  // Goal은 인자 하나로 받는다. 대화형 마법사는 만들지 않는다.
  let goal = positional.join(' ').trim();
  let goalSource = 'argument';
  if (opts.file) {
    if (goal !== '') return usageError(`give either a quoted goal or --file, not both\n${USAGE_LINE}`);
    const p = join(ROOT, opts.file);
    const target = existsSync(p) ? p : opts.file;
    if (!existsSync(target)) return fail(`goal file not found: ${opts.file}`);
    goal = readFileSync(target, 'utf8').trim();
    goalSource = rel(target);
  }
  if (goal === '') return usageError(USAGE_LINE);

  const config = loadConfig();
  if (opts.adapter) config.runtime.planner_adapter = opts.adapter;
  if (opts.model) config.runtime.planner_model = opts.model;
  if (opts.timeout) {
    const t = Number(opts.timeout);
    if (!Number.isInteger(t) || t < 1) return usageError('--timeout must be an integer >= 1 (seconds)');
    config.runtime.planner_timeout_seconds = t;
  }

  let outcome;
  try {
    outcome = await runPlannerOnce({
      goal,
      goalSource,
      config,
      onLaunch: ({ adapter, version, planId }) => {
        console.log(`Plan: ${planId}`);
        console.log(`Planner: ${adapter}${version ? ` (${version})` : ''}`);
        console.log('');
        console.log('(planning — read-only, one AI invocation, no task is created)');
      },
    });
  } catch (e) {
    return fail(`Planning could not start: ${e.message}`);
  }

  const { planId, dir, envelope, validation, report } = outcome;
  console.log('');
  console.log(`Goal:`);
  for (const l of goal.split('\n')) console.log(`  ${l}`);
  console.log('');
  console.log(`Planner Result:  ${report.planner_result ?? '(none returned)'}`);
  console.log(`Tasks proposed:  ${report.task_count}`);
  console.log('');

  if (report.task_count > 0) {
    printProposals(validation.result.tasks, report.proposal_order);
    console.log('');
  }
  if (report.human_questions.length > 0) {
    console.log('Human questions:');
    for (const q of report.human_questions) console.log(`  - ${q}`);
    console.log('');
  }

  console.log(`Validation: ${report.validation.valid ? 'PASS' : 'FAIL'}`);
  for (const e of report.validation.errors) console.log(`  ${e}`);
  for (const w of report.validation.warnings) console.log(`  warning: ${w}`);
  console.log('');
  printPlanUsage(envelope.usage);
  console.log('');
  console.log(`Artifacts: ${rel(dir)}`);
  console.log('');
  console.log('No tasks have been created.');
  console.log('');

  if (report.approvable) {
    console.log('Review:');
    console.log(`  loopctl plan-show ${planId}`);
    console.log('Approve:');
    console.log(`  loopctl plan-approve ${planId}`);
  } else if (report.planner_result === 'NEEDS_HUMAN') {
    console.log('This plan needs a human decision. Answer the questions above and run');
    console.log('`loopctl plan` again with a revised goal that includes the answers.');
    process.exitCode = 1;
  } else {
    console.log(`This plan is not approvable.  loopctl plan-show ${planId}`);
    process.exitCode = 1;
  }
}

/** plan-show — 기록된 Plan artifact를 읽는다. **AI 호출도 상태 변경도 없다.** */
function cmdPlanShow(ref) {
  if (!ref) return usageError('usage: loopctl plan-show <PLAN>');
  const resolved = resolvePlanRef(ref);
  if (!resolved.ok) return fail(resolved.reason);
  const plan = loadPlan(resolved.planId);
  const { report, plannerResult, envelope, manifest, approval } = plan;
  if (report === null) return fail(`${plan.planId}: plan-report.json is missing.`);
  if (report.corrupt) return fail(`${plan.planId}: plan-report.json is corrupt (${report.error}).`);

  console.log(`Plan:    ${report.plan_id}`);
  console.log(`Created: ${report.created_at}`);
  console.log(`Planner: ${report.adapter}${report.model ? `  model: ${report.model}` : ''}`);
  console.log(`Subject: ${report.subject_sha256 ?? '(unavailable)'}`);
  console.log(`Dir:     ${rel(plan.dir)}`);
  console.log('');
  console.log('Goal:');
  for (const l of String(report.goal).split('\n')) console.log(`  ${l}`);
  console.log('');
  console.log(`Planner Result: ${report.planner_result ?? '(none returned)'}`);
  if (report.goal_summary) console.log(`Summary:        ${report.goal_summary}`);
  console.log('');

  if (report.assumptions.length > 0) {
    console.log('Assumptions:');
    for (const a of report.assumptions) console.log(`  - ${a}`);
    console.log('');
  }
  if (report.risks.length > 0) {
    console.log('Risks:');
    for (const r of report.risks) console.log(`  - ${r}`);
    console.log('');
  }
  if (report.human_questions.length > 0) {
    console.log('Human questions:');
    for (const q of report.human_questions) console.log(`  - ${q}`);
    console.log('');
  }

  const proposal = plannerResult && !plannerResult.corrupt ? plannerResult.normalized : null;
  console.log(`Proposed tasks: ${report.task_count}`);
  if (proposal && Array.isArray(proposal.tasks)) {
    console.log('');
    const byId = new Map(proposal.tasks.map((t) => [t.proposal_id, t]));
    const seq = report.proposal_order.length === proposal.tasks.length
      ? report.proposal_order
      : proposal.tasks.map((t) => t.proposal_id);
    for (const pid of seq) {
      const t = byId.get(pid);
      if (!t) continue;
      const mapped = approval && !approval.corrupt ? approval.proposal_to_task?.[pid] : null;
      console.log(`${pid}  ${t.title}${mapped ? `   -> ${mapped}` : ''}`);
      console.log(`    role:        ${t.execution.role}`);
      console.log(`    depends on:  ${t.depends_on.join(', ') || '(none)'}`);
      const req = t.request.replace(/\s+/g, ' ').trim();
      console.log(`    request:     ${req.length > 100 ? `${req.slice(0, 97)}...` : req}`);
      console.log(`    stop:        gates=[${t.stop_condition.gates.join(', ')}]  requires_verifier=${t.stop_condition.requires_verifier}  max_consecutive_failures=${t.stop_condition.max_consecutive_failures}`);
      console.log(`    acceptance_criteria (${t.acceptance_criteria.length}):`);
      for (const ac of t.acceptance_criteria) {
        const v = ac.verification;
        const how = v.type === 'gate' ? `gate:${v.ref}` : `verifier${v.instruction ? ' (+instruction)' : ''}`;
        console.log(`      [${ac.id}] ${ac.description}`);
        console.log(`            판정: ${how}`);
      }
      console.log('');
    }
  }

  console.log(`Validation: ${report.validation.valid ? 'PASS' : 'FAIL'}`);
  for (const e of report.validation.errors) console.log(`  ${e}`);
  for (const w of report.validation.warnings) console.log(`  warning: ${w}`);
  console.log(`Policy violation: ${report.policy_violation}`);
  for (const d of report.policy_detail ?? []) console.log(`  ${d}`);
  console.log('');

  if (approval && !approval.corrupt) {
    console.log(`Approved: yes  (${approval.approved_at})`);
    for (const t of approval.tasks) {
      console.log(`  ${t.proposal_id} -> ${t.task_id}${t.depends_on.length ? `  depends_on: ${t.depends_on.join(', ')}` : ''}`);
    }
  } else {
    console.log('Approved: no');
    if (report.approvable) console.log(`  loopctl plan-approve ${report.plan_id}`);
  }
  console.log('');

  if (envelope && !envelope.corrupt) {
    printPlanUsage(envelope.usage);
    console.log(`  duration: ${envelope.duration_ms} ms`);
  }
  if (manifest && !manifest.corrupt) {
    console.log('');
    console.log(`Planner snapshot sections: ${manifest.sections.join(' · ')}`);
    console.log(`Excluded from planner context: ${manifest.excluded.join(', ')}`);
    console.log(`  (full context: ${rel(join(plan.dir, 'context.md'))})`);
  }
}

/** plans — 최근 Plan 목록. AI 호출 없음. */
function cmdPlans() {
  const ids = listPlans();
  if (ids.length === 0) return console.log('No plans.  (loopctl plan "<GOAL>")');
  for (const id of ids) {
    const p = loadPlan(id);
    const r = p.report;
    if (!r || r.corrupt) { console.log(`${id.padEnd(26)} ${'CORRUPT'.padEnd(12)}`); continue; }
    const state = r.planner_result ?? 'NO_RESULT';
    const approved = p.approval && !p.approval.corrupt
      ? `approved -> ${(p.approval.created_task_ids ?? []).join(', ')}`
      : (r.approvable ? 'not approved' : (r.validation.valid ? '' : 'invalid'));
    console.log(`${id.padEnd(26)} ${state.padEnd(12)} ${String(r.task_count).padStart(2)} task(s)   ${approved}`);
  }
}

/**
 * plan-approve — 사람의 명시적 승인 경계. **AI를 호출하지 않는다.**
 * Task를 만드는 유일한 명령이며, 만들고 나서 아무것도 실행하지 않는다.
 */
function cmdPlanApprove(ref) {
  if (!ref) return usageError('usage: loopctl plan-approve <PLAN>');
  const resolved = resolvePlanRef(ref);
  if (!resolved.ok) return fail(resolved.reason);

  const outcome = approvePlan(resolved.planId);
  if (!outcome.ok) {
    const head = outcome.code === 'STALE' ? 'Plan approval refused.'
      : outcome.code === 'RECOVERY_AMBIGUOUS' ? 'RECOVERY_AMBIGUOUS'
        : 'Plan approval refused.';
    console.error(head);
    console.error('');
    console.error(`Reason:\n  ${outcome.reason}`);
    for (const d of outcome.detail) console.error(`  ${d}`);
    process.exitCode = 1;
    return;
  }

  if (outcome.already) {
    console.log('Plan already approved.');
    console.log('');
    for (const t of outcome.approval.tasks) console.log(`  ${t.proposal_id} -> ${t.task_id}`);
    console.log('');
    console.log('(no task was created)');
    return;
  }

  console.log('Plan approved.');
  console.log('');
  console.log('Created Tasks:');
  for (const t of outcome.approval.tasks) {
    console.log(`  ${t.task_id}  (${t.proposal_id})  ${t.title}${t.depends_on.length ? `\n      depends_on: ${t.depends_on.join(', ')}` : ''}`);
  }
  console.log('');

  const tasks = loadAllTasks();
  const created = new Set(outcome.created);
  const ready = readyTasks(tasks).filter((t) => created.has(t.id));
  console.log('Ready:');
  if (ready.length === 0) console.log('  none');
  for (const t of ready) console.log(`  ${t.id}`);
  console.log('');
  console.log('Next:');
  console.log(ready.length > 0 ? `  loopctl execute ${ready[0].id}` : '  loopctl status');
  console.log('');
  console.log('(nothing was executed — approval creates tasks and stops there)');

  if (reportErrors(tasks) || reportGraph(tasks)) process.exitCode = 1;
}

async function cmdAdapters() {
  for (const a of await detectAll()) {
    console.log(`${a.name.padEnd(8)} ${a.available ? 'available' : 'unavailable'}  ${a.version ?? a.reason ?? ''}`);
  }
}

/** gates — 설정된 Gate 조회. 실행하지 않는다. */
/**
 * self-check — Worker가 스스로 돌려보는 결정론적 검사. **정본 Gate 실행이 아니다.**
 *
 * 실행 가능한 명령은 project.yaml의 gates 블록에서만 온다. 인자는 Gate 이름일 뿐이며
 * 명령 문자열이 아니다 — 해석되지 않는 이름은 아무것도 실행하지 않고 거부된다.
 * Gate Report를 만들지 않고, Run 디렉터리에 쓰지 않으며, Task 상태를 바꾸지 않는다.
 */
async function cmdSelfCheck(...argv) {
  const USAGE_LINE = 'usage: loopctl self-check [<gate> ...]';
  for (const a of argv) {
    if (a.startsWith('-')) return usageError(`unknown option: ${a}\n${USAGE_LINE}`);
  }
  const config = loadConfig();
  const resolved = resolveSelfCheckGates(config, argv);
  if (!resolved.ok) {
    console.error('self-check refused — nothing was executed:');
    for (const e of resolved.errors) console.error(`  ${e}`);
    process.exitCode = 2;
    return;
  }

  console.log('Self-check (advisory — the runtime reruns gates independently after the worker finishes)');
  console.log(`Gates: ${resolved.defs.map((d) => d.name).join(', ')}`);
  console.log('');

  const { results, passed } = await runSelfCheck({
    config,
    defs: resolved.defs,
    emit: (e) => {
      if (e.event === 'start') console.log(`[${e.name}] ${e.command}`);
    },
  });

  for (const r of results) {
    console.log('');
    console.log(`${r.name}: ${r.status}  exit=${r.exit_code ?? 'none'}  ${(r.duration_ms / 1000).toFixed(1)}s`);
    if (r.error) console.log(`  error: ${r.error}`);
    if (r.status !== 'PASS') {
      if (r.stderr_tail) {
        console.log('  stderr (tail):');
        for (const l of r.stderr_tail.split('\n')) console.log(`    ${l}`);
      }
      if (r.stdout_tail) {
        console.log('  stdout (tail):');
        for (const l of r.stdout_tail.split('\n')) console.log(`    ${l}`);
      }
    }
  }

  console.log('');
  console.log(`Self-check: ${passed ? 'all gates passed' : 'FAILED'}`);
  console.log(`Artifacts: ${rel(SELF_CHECK_DIR)}/  (advisory only — not a gate report)`);
  if (!passed) process.exitCode = 1;
}

function cmdGates() {
  const config = loadConfig();
  const gc = loadGateConfig(config);
  if (gc.names.length === 0) console.log('No gates configured in .loop/project.yaml.');
  for (const name of gc.names) {
    const g = gc.gates[name];
    const timeout = g.timeout_seconds ?? config.runtime.gate_timeout_seconds;
    const detail = g.enabled ? `command=${g.command}` : `disabled${g.reason ? ` (${g.reason})` : ''}`;
    console.log(`${name.padEnd(16)} timeout=${String(timeout).padStart(4)}s  ${detail}${g.cwd ? `  cwd=${g.cwd}` : ''}`);
  }
  const tasks = loadAllTasks();
  if (reportGatePreflight(tasks)) process.exitCode = 1;
}

function cmdDoctor() {
  const required = [
    '.loop/DESIGN.md', '.loop/KERNEL.md', '.loop/project.yaml',
    '.loop/skills/impl.md', '.loop/skills/verifier.md', '.loop/policies/limits.yaml',
    '.loop/skills/planner.md',
    '.loop/tasks', '.loop/evidence',
    '.loop-local/runs', '.loop-local/leases', '.loop-local/staging', '.loop-local/plans',
  ];
  let ok = true;
  for (const p of required) {
    const present = existsSync(join(ROOT, p));
    ok &&= present;
    console.log(`${present ? 'OK  ' : 'MISS'} ${p}`);
  }
  const kernelLines = readFileSync(join(LOOP_DIR, 'KERNEL.md'), 'utf8').split('\n').length;
  console.log(`\nKERNEL.md: ${kernelLines} lines${kernelLines > 120 ? '  <- 너무 큼. 모든 Run의 고정비다.' : ''}`);
  console.log(isPaused() ? 'PAUSE: active' : 'PAUSE: none');
  const tasks = loadAllTasks();
  console.log(`tasks: ${tasks.length} total, ${tasks.filter(isValid).length} valid, ${readyTasks(tasks).length} ready`);
  console.log(`execution roles: ${executionRoles().join(', ') || '(none)'}`);
  const plans = listPlans();
  const unapproved = plans.filter((id) => {
    const p = loadPlan(id);
    return p.ok && p.report && !p.report.corrupt && p.report.approvable && !p.report.approved;
  });
  console.log(`plans: ${plans.length} total, ${unapproved.length} approvable but not approved`);
  const gateProblems = reportGatePreflight(tasks);
  const graphProblems = reportGraph(tasks);
  if (reportErrors(tasks) || gateProblems || graphProblems || !ok) process.exitCode = 1;
}

const RUNTIME_VERSION = 'Loop Runtime V0';

const VERSION_TEXT = [
  RUNTIME_VERSION,
  `node                  ${process.version}`,
  'task schema           1',
  `gate report           ${GATE_REPORT_SCHEMA}`,
  `verification report   ${VERIFICATION_REPORT_SCHEMA}`,
  `plan report           ${PLAN_REPORT_SCHEMA}`,
].join('\n');

const HELP = `${RUNTIME_VERSION}

Usage:
  loopctl <command> [arguments]

Inspect
  status                      전체 상태 요약 (읽기 전용 · AI 호출 없음)
  doctor                      구조 점검
  tasks                       Task 목록
  show <TASK>                 Task 상세
  ready                       Worker 실행 준비된 Task
  verify-ready                Verifier 대기 중인 Task/Run
  gates                       설정된 Gate (실행하지 않음)
  adapters                    Provider Adapter 사용 가능 여부

Plan
  plan "<GOAL>"               Goal -> Task 제안 (읽기 전용 · AI 호출 1회 · Task를 만들지 않음)
                              --file --adapter --model --timeout
  plan-show <PLAN>            기록된 Plan 열람            (AI 호출 없음)
  plans                       Plan 목록                   (AI 호출 없음)
  plan-approve <PLAN>         승인 -> canonical Task 생성  (AI 호출 없음 · 실행하지 않음)

Execute
  run <TASK>                  Worker 1회 실행         --adapter --timeout --model
  gate <RUN|TASK>             결정론적 Gate 실행       --rerun            (AI 호출 없음)
  verify <RUN|TASK>           독립 Verifier 1회 실행   --rerun --adapter --model --timeout
  retry <RUN|TASK>            진단 기반 Worker 재시도 1회  --adapter --timeout --model
  execute <TASK>              DONE 또는 정지 조건까지 Task 루프 실행  --timeout --adapter --model
  self-check [<gate> ...]     설정된 Gate 명령만 참고용으로 실행   (AI 호출 없음 · 판정 아님)
  execute-plan <PLAN>         승인된 Plan의 Task를 한 번에 하나씩 순차 실행  --timeout --adapter --model
                              (오케스트레이션 판단은 결정론적 · 추가 AI 호출 없음)

Inspect Runs
  diagnose <RUN|TASK>         실패 진단 · Failure Memo (읽기 전용 · AI 호출 없음)
  execution <EXEC|TASK>       기록된 Execution Report
  usage <RUN|TASK>            기록된 Worker telemetry
  verification <RUN|TASK>     기록된 Verification Report

Low-level
  validate                    Task 전체 검증
  transition <TASK> <STATE>   Runtime을 통한 유일한 상태 변경 경로
  context <TASK>              Worker Context 출력 (실행하지 않음)
  snapshot <TASK>             Run snapshot 생성

Other
  help                        이 도움말
  version                     Runtime 버전

  states: ${STATES.join(' · ')}
  worker-requestable: ${WORKER_REQUESTABLE.join(' · ')} (요청일 뿐, 적용은 Runtime이 결정)
  exit: 0 성공 · 1 작업 실패/거부 · 2 잘못된 사용법

  Run ID가 정본이다. Task ID는 Runtime이 결정론적으로 해석할 때만 쓸 수 있는 편의 입력이다.
  execute는 Worker -> Gate -> Verifier -> Diagnose -> Retry를 자동으로 잇는다.
  execute-plan은 그 execute를 Plan의 Task에 대해 한 번에 하나씩 순서대로 부른다.
  사람이 필요한 정지에서 즉시 멈추고, 다시 실행하면 남은 Task부터 이어간다.
  계획은 승인 전까지 Task를 만들지 않고, 승인은 Task를 실행하지 않는다.
  선행 Task(depends_on)가 DONE이 아니면 그 Task는 READY가 아니며 run/execute가 거부된다.
  낮은 수준 명령은 디버깅·수동 제어용으로 그대로 남아 있다. Task 하나만 실행한다.`;

const commands = {
  status: cmdStatus, doctor: cmdDoctor,
  tasks: cmdTasks, show: cmdShow, ready: cmdReady, 'verify-ready': cmdVerifyReady,
  gates: cmdGates, adapters: cmdAdapters, 'self-check': cmdSelfCheck,
  plan: cmdPlan, 'plan-show': cmdPlanShow, plans: cmdPlans, 'plan-approve': cmdPlanApprove,
  run: cmdRun, gate: cmdGate, verify: cmdVerify, retry: cmdRetry, execute: cmdExecute,
  'execute-plan': cmdExecutePlan,
  diagnose: cmdDiagnose, execution: cmdExecution,
  usage: cmdUsage, verification: cmdVerification,
  validate: cmdValidate, transition: cmdTransition, context: cmdContext, snapshot: cmdSnapshot,
  help: cmdHelp, version: cmdVersion,
};

const [, , rawCmd, ...args] = process.argv;
// 인자 없이 부르면 help다. 실행은 언제나 명시적이어야 하므로 아무것도 시작하지 않는다.
const cmd = rawCmd === undefined || rawCmd === '--help' || rawCmd === '-h' ? 'help'
  : rawCmd === '--version' || rawCmd === '-v' ? 'version'
    : rawCmd;

const run = commands[cmd];
if (!run) {
  console.error(`unknown command: ${rawCmd}`);
  console.error("run `loopctl help` to see the available commands.");
  process.exitCode = 2;
} else {
  try {
    await run(...args);
  } catch (e) {
    // 예상 가능한 운영자 실수에는 stack trace를 보이지 않는다.
    // 진짜 Runtime 버그는 LOOPCTL_DEBUG=1로 전체 stack을 볼 수 있다. 감추지는 않는다.
    fail(`error: ${e.message}`);
    if (process.env.LOOPCTL_DEBUG) console.error(e.stack);
    else console.error('  (set LOOPCTL_DEBUG=1 for the full stack trace)');
  }
}
