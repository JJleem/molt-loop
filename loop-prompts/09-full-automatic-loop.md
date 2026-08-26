# Loop Runtime V0 — Step 7 Full Automatic Loop Orchestration

The V0 Loop Runtime currently implements all individual execution stages required for a controlled Task loop:

```text
Task
→ Worker
→ REVIEW
→ Deterministic Gates
→ Independent Verifier
→ DONE

```

and deterministic recovery:

```text
Failure
→ Diagnose
→ Failure Memo
→ Retry
→ New Worker Attempt

```

The current operator can manually run:

```text
loopctl run TASK-001
loopctl gate TASK-001
loopctl verify TASK-001

loopctl diagnose TASK-001
loopctl retry TASK-001

```

This step introduces the first **full automatic Task loop**.

The Runtime must orchestrate the existing stages until one of the defined Stop Conditions is reached.

The desired operator experience is:

```text
loopctl execute TASK-001

```

The Runtime then continues automatically through:

```text
Worker
→ Gate
→ Verifier
→ Diagnose
→ Retry
→ Gate
→ Verifier
→ ...

```

until:

```text
DONE

```

or a deterministic stop/escalation condition is reached.

This step does not introduce a Planner.

The user still provides a valid Task.

---

# 1. Core Goal

Implement a small orchestration layer that composes the Runtime capabilities already built.

The Full Loop must:

1. Resolve the current Task state.
2. Determine the next legal Runtime action.
3. Execute exactly that action using existing modules.
4. Re-read authoritative Runtime state after each stage.
5. Continue only when policy allows.
6. Diagnose failures before any retry.
7. Inject existing Failure Memos into retry Workers.
8. Respect all attempt and consecutive-failure limits.
9. Detect simple deterministic stagnation where possible.
10. Stop immediately on non-retryable, ambiguous, blocked, or unsafe conditions.
11. Produce an authoritative execution summary.
12. Never rely on AI session memory to know where the loop currently is.

The orchestrator coordinates existing modules.

It must not reimplement their business logic.

---

# 2. Inspect the Existing Runtime First

Before changing anything, inspect the actual implementation:

- `.loop/[KERNEL.md](http://KERNEL.md)`
- `.loop/project.yaml`
- `.loop/policies/limits.yaml`
- `.loop/tasks/TASK-EXAMPLE.yaml`
- `tools/loop-runtime/loopctl.mjs`
- `tools/loop-runtime/config.mjs`
- `tools/loop-runtime/task-store.mjs`
- `tools/loop-runtime/transitions.mjs`
- `tools/loop-runtime/context-builder.mjs`
- `tools/loop-runtime/subject.mjs`
- `tools/loop-runtime/worker/`
- `tools/loop-runtime/gate/`
- `tools/loop-runtime/verifier/`
- `tools/loop-runtime/recovery/`
- `tools/loop-runtime/adapters/`
- `tools/loop-runtime/[README.md](http://README.md)`
- project-root `loopctl.cmd`
- project-root `loopctl`

Also re-read only the relevant sections of `.loop/[DESIGN.md](http://DESIGN.md)` concerning:

- Stop or Loop
- Stop Conditions
- Retry vs Loop
- Diagnose
- escalation ladder
- Failure Memo
- Context management
- Stalled detection
- Human escalation
- Observability
- Runtime ownership

Do not copy [DESIGN.md](http://DESIGN.md) into Worker or Verifier context.

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

---

# 3. Do Not Reimplement Existing Stages

This requirement is strict.

The orchestration layer must reuse the existing implementations of:

```text
Worker Runner
Gate Runner
Verifier Runner
Diagnosis
Failure Memo
Retry
Task Store
Transition Engine
Subject Fingerprinting
Telemetry

```

Do not create a second implementation of:

```text
run
gate
verify
diagnose
retry

```

inside the automatic loop.

Extract small reusable functions from `loopctl.mjs` only where necessary to prevent CLI code from being called as a subprocess.

Prefer direct module composition.

The CLI is an interface.

Runtime modules are the execution source of truth.

---

# 4. Orchestration Architecture

Introduce a small Loop orchestration layer.

Prefer a structure such as:

```text
tools/loop-runtime/
└─ loop/
   ├─ orchestrator.mjs
   ├─ next-action.mjs
   ├─ stop-evaluator.mjs
   └─ execution-report.mjs

```

Slightly different filenames are acceptable.

Keep the layer intentionally small.

Do not create:

- workflow DSL
- generic DAG engine
- event bus
- queue framework
- agent framework
- state-machine library dependency

The existing Runtime state model is enough for V0.

---

# 5. Add `loopctl execute`

Add:

```text
loopctl execute <TASK-ID>

```

The Task ID is the operator-facing identity.

The orchestrator must resolve canonical Run IDs internally.

Example:

```text
loopctl execute TASK-001

```

The command executes one Task only.

Do not execute every READY Task in the project.

Do not create:

```text
loopctl execute-all
loopctl auto
loopctl daemon

```

in this step.

---

# 6. Execution Must Be Resumable From Runtime State

`execute` must not assume that every Task begins at `TODO`.

It must inspect authoritative Runtime state and continue from a safe known point.

Examples:

## TODO

```text
TODO
→ launch first Worker

```

## REVIEW with no Gate Report for the latest Run

```text
REVIEW
→ run Gates

```

## REVIEW with current Gate PASS and Verifier required

```text
REVIEW
→ launch Verifier

```

## REVIEW with Gate FAIL

```text
REVIEW
→ Diagnose
→ retry if allowed

```

## REVIEW with Verifier FAIL

```text
REVIEW
→ Diagnose
→ retry if allowed

```

## IN_PROGRESS with a completed failed Worker Run

```text
IN_PROGRESS
→ Diagnose
→ retry if allowed

```

## DONE

```text
DONE
→ no-op success

```

Example:

```text
TASK-001 is already DONE.

```

## BLOCKED

Stop.

Do not automatically unblock it.

## DROPPED

Refuse execution.

## Ambiguous IN_PROGRESS

If the Runtime cannot prove the previous Worker attempt has terminated:

```text
RECOVERY_AMBIGUOUS
→ stop

```

Do not guess.

---

# 7. Next Action Resolver

Implement a deterministic next-action resolver.

Conceptually it may return:

```text
RUN_WORKER
RUN_GATES
RUN_VERIFIER
DIAGNOSE
RETRY_WORKER
DONE
STOP_BLOCKED
STOP_NEEDS_HUMAN
STOP_LIMIT
STOP_STALLED
STOP_AMBIGUOUS

```

These are internal orchestration actions.

Do not persist them into Task YAML.

Do not introduce new Task states.

The resolver must use existing Runtime facts.

Do not ask an LLM what to do next.

---

# 8. Canonical Loop

The automatic execution sequence should conceptually be:

```text
while true:

  inspect Runtime state

  determine next action

  if RUN_WORKER:
      invoke existing first Worker path

  if RUN_GATES:
      invoke existing Gate Runner

  if RUN_VERIFIER:
      invoke existing Verifier Runner

  if DIAGNOSE:
      invoke existing deterministic diagnosis

  if RETRY_WORKER:
      invoke existing Retry path

  if DONE:
      stop successfully

  if any stop/escalation condition:
      stop safely

```

After every stage:

```text
re-read state from disk

```

Do not keep a mutable in-memory shadow Task state and assume it remains authoritative.

Durable Runtime artifacts remain the source of truth.

---

# 9. Worker Success Flow

For a normal first attempt:

```text
TODO
↓
Worker
↓
REVIEW
↓
Gate

```

If the Worker returns:

```text
BLOCKED

```

stop immediately.

Do not attempt Gates.

Do not retry a legitimately BLOCKED Task automatically.

---

# 10. Gate Flow

After a Worker reaches REVIEW:

```text
Gate Runner

```

must execute using the existing deterministic Gate implementation.

If:

```text
Gate PASS

```

then:

```text
Verifier required
→ RUN_VERIFIER

```

Do not invoke Diagnose.

If:

```text
Gate FAIL

```

then:

```text
Diagnose

```

and only then determine whether retry is allowed.

If:

```text
Gate ERROR
Gate TIMEOUT

```

preserve the existing recovery classifications.

Do not reinterpret Gate policy inside the orchestrator.

---

# 11. Verifier Flow

After Gate PASS and `VERIFY_READY`:

```text
Independent Verifier

```

If:

```text
Verification PASS

```

the existing Verifier/Runtime finalization path should transition:

```text
REVIEW → DONE

```

The orchestrator should observe `DONE` afterward and stop.

If:

```text
Verifier FAIL

```

then:

```text
Diagnose
→ retry if policy allows

```

Do not weaken the Verifier contract.

Do not reuse the Worker session.

---

# 12. Diagnose Before Retry

Every automatic retry must pass through the existing deterministic Diagnosis layer.

Never:

```text
Gate FAIL
→ immediate Worker

```

Always:

```text
Gate FAIL
↓
Diagnose
↓
Failure Memo
↓
Retry policy
↓
Worker

```

The orchestrator must not construct its own recovery hints.

It must consume the canonical Diagnosis and Failure Memo.

---

# 13. Retry Policy

Automatic retry is permitted only when the canonical Diagnosis recommends:

```text
RETRY
RETRY_WITH_HINT

```

Do not automatically retry:

```text
NEEDS_HUMAN
RERUN_GATES
REPLAN_REQUIRED
NO_ACTION

```

unless the meaning is already deterministically handled by existing Runtime policy.

---

# 14. `RERUN_GATES`

Handle this action carefully.

If Diagnosis says:

```text
RERUN_GATES

```

because the repository subject became stale, do not blindly rerun Gates if the source of the subject change is ambiguous.

If the existing Runtime can deterministically establish that:

- the current Task still owns the current subject
- no unrelated external change occurred
- rerunning Gates is safe

then a Gate rerun may be performed explicitly through existing Gate rerun semantics.

Otherwise:

```text
STOP_AMBIGUOUS

```

or:

```text
NEEDS_HUMAN

```

is correct.

Prefer fail-closed behavior.

Do not hide shared-working-tree ambiguity.

---

# 15. Replan Is Not Implemented

If Diagnosis recommends:

```text
REPLAN_REQUIRED

```

stop the automatic loop.

Example:

```text
Execution stopped.

Task: TASK-001
Reason: REPLAN_REQUIRED

```

Do not call a Planner.

Do not rewrite the Task.

Do not modify Acceptance Criteria.

Goal planning belongs to Step 8.

---

# 16. Human Escalation Is a Stop Condition

For this V0 orchestrator:

```text
NEEDS_HUMAN

```

is an execution outcome, not a new persisted Task status.

Do not add:

```text
status: NEEDS_HUMAN

```

to Task YAML.

The Task remains in its authoritative persisted state such as:

```text
REVIEW
IN_PROGRESS
BLOCKED

```

and the execution result reports:

```text
NEEDS_HUMAN

```

Later a dedicated escalation queue may be introduced.

Not in this step.

---

# 17. Stop Conditions

The Full Loop must explicitly evaluate Stop Conditions after every stage.

At minimum stop on:

```text
Task DONE
Task BLOCKED
Task DROPPED
maximum attempts reached
maximum consecutive failures reached
non-retryable Diagnosis
policy violation
recovery ambiguity
subject safety failure
replan required
stagnation detected
unexpected Runtime inconsistency
operator interruption

```

Do not continue because there are remaining tokens or because the Worker produced output.

---

# 18. Attempt Limits

Reuse existing:

```text
max_attempts
max_consecutive_failures
retry ladder limits

```

from the existing Runtime configuration.

Do not create another independent attempt counter.

Before every paid Worker retry:

```text
check limit

```

If exceeded:

```text
STOP_LIMIT
→ NEEDS_HUMAN

```

No AI invocation should occur after the limit is reached.

---

# 19. Minimal Stagnation Detection

This is the first fully automatic loop, so it needs a deterministic protection against repeating the same failed recovery.

Do not implement full internal tool-call Stall Detection yet.

Use the metadata already created in Step 6.

At minimum inspect:

```text
failure_fingerprint
attempt lineage
subject fingerprint
observed changed-file count
failed gates
failed criteria

```

Detect a simple derived stagnation condition when, for example:

```text
the same failure fingerprint occurs on consecutive attempts
AND
the retry produced no meaningful subject progress

```

or another equally conservative deterministic rule supported by the existing artifacts.

Prefer false negatives over false positives.

Do not classify a Task STALLED from vague similarity.

When deterministic stagnation is established:

```text
STOP_STALLED
→ NEEDS_HUMAN

```

Do not persist:

```text
status: STALLED

```

into Task YAML.

STALLED remains a derived Runtime condition.

---

# 20. Do Not Use an LLM for Stop Decisions

Stop / Continue decisions must be deterministic.

Do not ask:

```text
Claude, should we retry?

```

The AI Worker attempts implementation.

The Runtime decides whether another attempt is allowed.

---

# 21. One Worker Invocation Per Attempt

Each retry must create a fresh Worker Run.

Do not resume the previous Worker session.

Continue preserving:

```text
root_run_id
parent_run_id
attempt number
Failure Memo lineage

```

Each attempt remains auditable independently.

---

# 22. Fresh Gate and Verifier Per Changed Subject

After every retry Worker modifies the subject:

```text
old Gate Report
old Verifier Result

```

are historical only.

The loop must require fresh:

```text
Gate
Verifier

```

for the new Run.

Never carry PASS from Attempt 1 into Attempt 2.

---

# 23. No Previous AI Narrative

Automatic looping must not cause Context history growth.

Retry Worker context remains:

```text
KERNEL
ROLE
TASK
ACCEPTANCE CRITERIA
FAILURE MEMO

```

Do not accumulate:

```text
Worker #1 transcript
Worker #2 transcript
Gate logs
Verifier transcript
interactive session history

```

The existing bounded Failure Memo mechanism remains the only recovery history passed to Workers.

---

# 24. Verifier Isolation Remains Strict

The automatic orchestrator must not inject Failure Memo or previous attempt narrative into the Verifier.

Verifier Context remains exactly based on:

```text
Verifier Contract
Task
Acceptance Criteria
Canonical Diff
Gate Results
Evidence
Runtime Facts

```

Do not change this because automatic retry now exists.

---

# 25. Operator Interruption

Handle Ctrl+C / SIGINT safely.

If the operator interrupts:

```text
loopctl execute TASK-001

```

the orchestrator should:

- stop scheduling new stages
- allow the currently executing subprocess to use existing cancellation behavior
- preserve completed Runtime artifacts
- avoid fabricating success
- report the last authoritative Task state

Do not automatically rollback.

Do not erase Run evidence.

---

# 26. Optional Loop-Level Timeout

If straightforward and useful, support a total execution timeout such as:

```text
loopctl execute TASK-001 --timeout <seconds>

```

This timeout applies to the whole orchestration command.

Do not replace existing:

```text
Worker timeout
Gate timeout
Verifier timeout

```

Those remain independently authoritative.

If a total timeout expires:

```text
STOP_LIMIT

```

or a clearly named orchestration timeout result.

Do not classify it as implementation failure.

If this adds significant complexity, defer it.

---

# 27. Model Overrides

If current `run`, `retry`, or `verify` already support:

```text
--model

```

preserve compatible model override behavior.

Do not add automatic model routing.

Do not escalate to a more expensive model automatically.

A single `execute` invocation should use explicit/default provider settings already supported by the Runtime.

Model optimization belongs later.

---

# 28. Full Loop Usage Telemetry

The Runtime already records:

```text
Worker usage
Gate telemetry
Verifier usage
Retry Worker usage

```

Do not make additional AI calls for loop-level telemetry.

Create a Runtime-authored execution summary that references the existing per-Run telemetry.

Prefer an artifact such as:

```text
.loop-local/executions/EXEC-.../
└─ execution-report.json

```

or another clean Runtime-local location.

Do not duplicate all Run artifacts.

Store references to canonical Runs instead.

---

# 29. Execution Identity

Introduce an orchestration-level ID.

For example:

```text
EXEC-20260826T...

```

One `loopctl execute` invocation gets one Execution ID.

An Execution may contain several Worker Runs:

```text
EXEC-001

Attempt 1
  RUN-A

Attempt 2
  RUN-B

Attempt 3
  RUN-C

```

Do not use provider session IDs as Runtime execution identity.

---

# 30. Execution Report

Create an authoritative Runtime-authored report.

Conceptually:

```json
{
  "schema": 1,
  "execution_id": "EXEC-...",
  "task_id": "TASK-001",

  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 0,

  "result": "DONE",

  "stop_reason": "TASK_DONE",

  "attempts": [
    {
      "attempt": 1,
      "run_id": "RUN-A",
      "worker": "success",
      "gate": "FAIL",
      "verifier": null,
      "diagnosis": "GATE_FAILURE",
      "action": "RETRY_WITH_HINT"
    },
    {
      "attempt": 2,
      "run_id": "RUN-B",
      "worker": "success",
      "gate": "PASS",
      "verifier": "PASS"
    }
  ]
}

```

Allowed execution-level results should remain small.

Prefer:

```text
DONE
BLOCKED
NEEDS_HUMAN
LIMIT_REACHED
STALLED
INTERRUPTED
FAILED

```

These are Execution Report outcomes.

They are not Task YAML states.

---

# 31. Execution Event Timeline

If useful, include a compact deterministic timeline inside the Execution Report.

Example:

```json
{
  "events": [
    {
      "stage": "worker",
      "run_id": "RUN-A",
      "result": "REVIEW"
    },
    {
      "stage": "gate",
      "run_id": "RUN-A",
      "result": "FAIL"
    },
    {
      "stage": "diagnose",
      "run_id": "RUN-A",
      "result": "RETRY_WITH_HINT"
    }
  ]
}

```

Do not create a general Event Journal framework in this step.

This is only an execution summary.

---

# 32. Usage Aggregation

Because automatic execution may involve multiple paid AI calls, expose useful loop-level usage without altering existing per-stage telemetry.

Do not invent provider totals.

Prefer aggregating only values with clear semantics.

At minimum record:

```text
worker_invocations
verifier_invocations
gate_invocations
llm_invocations

```

Where provider cost is explicitly available:

```text
known_provider_cost_usd

```

may be summed.

Also record:

```text
invocations_with_unknown_cost

```

Do not claim a complete dollar total if some stages lack authoritative cost data.

For token metrics, preserve stage/invocation-level provider values.

If aggregating token fields, only sum like-for-like provider fields and clearly mark them as an aggregate of provider-reported values.

Do not synthesize missing token totals.

Example:

```json
{
  "usage_summary": {
    "llm_invocations": 4,
    "worker_invocations": 2,
    "verifier_invocations": 2,
    "gate_invocations": 2,

    "provider_cost_usd_known": 0.42,
    "unknown_cost_invocations": 0
  }
}

```

Do not implement budget enforcement yet.

---

# 33. CLI Output During Execute

Keep live output understandable.

Example:

```text
Execution: EXEC-...
Task: TASK-001

Attempt 1

[Worker]
PASS → REVIEW
Run: RUN-A

[Gate]
FAIL
  test → FAIL

[Diagnose]
GATE_FAILURE
Action: RETRY_WITH_HINT

[Retry]
Starting attempt 2...

Attempt 2

[Worker]
PASS → REVIEW
Run: RUN-B

[Gate]
PASS

[Verifier]
PASS

TASK-001: REVIEW -> DONE

Execution Result: DONE
Attempts: 2
Duration: 2m 14s

```

Do not print full AI transcripts or full test logs.

Existing artifact paths remain available for inspection.

---

# 34. Failure CLI Output

Example:

```text
Execution Result: NEEDS_HUMAN

Task: TASK-001
Attempts: 2

Latest failure:
  Stage: verifier
  Class: VERIFY_FAILED
  Criterion: AC3

Stop reason:
  maximum retry-with-hint attempts reached

Inspect:
  loopctl diagnose TASK-001
  loopctl status

```

Keep it concise.

---

# 35. Exit Codes

Preserve existing CLI tiers where possible.

Suggested:

```text
0
Task reached DONE
or Task was already DONE

1
Execution stopped without DONE:
BLOCKED
NEEDS_HUMAN
LIMIT_REACHED
STALLED
FAILED
INTERRUPTED

2
invalid CLI usage

```

Do not use exit 0 merely because the orchestrator itself did not crash.

The operator requested Task completion.

---

# 36. `status` Integration

If straightforward, allow `loopctl status` to show the latest Execution outcome.

Example:

```text
REVIEW
  TASK-001
    latest run: RUN-...
    latest execution: NEEDS_HUMAN
    recovery: RETRY_WITH_HINT

```

Do not persist another Task state.

Do not duplicate orchestration logic in `status`.

If this complicates the command significantly, defer it.

---

# 37. Execution Inspection

Add a read-only command if useful:

```text
loopctl execution <EXEC-ID|TASK-ID>

```

It displays the stored Execution Report.

It must:

- perform zero LLM calls
- perform no Runtime mutation

If Task ID is supplied, resolve deterministically to the latest Execution.

If adding the command meaningfully increases scope, the JSON artifact alone is sufficient for V0.

---

# 38. Do Not Auto-Execute Multiple Tasks

This Full Loop is per Task.

Do not:

```text
find all READY tasks
→ run all of them

```

yet.

There is no queue/lease/worktree system.

Executing multiple Tasks automatically in one shared working tree would create ambiguity.

Multi-Task scheduling belongs later.

---

# 39. No Parallelism

Run stages sequentially.

Do not run:

- multiple Workers
- Gate and Worker simultaneously
- multiple Verifiers
- multiple retries

in parallel.

The current Runtime uses one shared working tree.

Preserve that assumption.

---

# 40. Shared Working Tree Safety

The strict subject fingerprint behavior is intentional.

If unrelated repository changes occur while `execute` is running:

```text
stop safely

```

Do not ignore them.

Do not automatically stash them.

Do not reset them.

Do not commit them.

Do not attempt automatic merge/reconciliation.

Worktree isolation belongs later.

---

# 41. PAUSE

Inspect whether existing Runtime PAUSE behavior is already implemented.

If the Runtime is paused before `execute` begins:

```text
refuse to start

```

If PAUSE becomes active between stages:

```text
finish the current atomic stage
then stop before launching another paid/side-effecting stage

```

where practical.

Do not create a daemon watcher.

Re-check PAUSE between orchestration stages.

---

# 42. Runtime Integrity

Preserve all existing protection:

```text
Worker protected .loop rules
Verifier read-only rules
Gate Runtime ownership
Subject fingerprints
Single Writer
Transition Engine

```

The orchestrator must not bypass any of them for convenience.

---

# 43. Task Contract Is Immutable During the Loop

Automatic execution must never change:

- request
- Acceptance Criteria
- verification types
- Gate refs
- stop conditions

to force completion.

If the contract becomes impossible or invalid:

```text
NEEDS_HUMAN

```

Do not optimize for passing the tests by weakening the tests.

---

# 44. No Planner

This step receives:

```text
a valid Task

```

It does not receive:

```text
a broad Goal

```

Do not implement:

```text
Goal → Task decomposition

```

Do not create Tasks automatically.

Do not modify dependency graphs.

Planner belongs to Step 8.

---

# 45. No Replan Execution

The existing Diagnosis may recommend:

```text
REPLAN_REQUIRED

```

The Full Loop must stop there.

Do not launch another AI in a planning role.

That is intentionally not available yet.

---

# 46. No Background Execution

`loopctl execute` remains a foreground command.

Do not implement:

- daemon
- detached process
- service
- Windows service
- scheduler
- queue
- webhook

The terminal owns the execution lifecycle.

---

# 47. No Budget Enforcement Yet

Telemetry is already available.

Do not implement:

```text
hard dollar limits
token budgets
provider spending caps

```

in this step.

Existing attempt limits provide the current safety boundary.

The Execution Report should make later Budget policy possible.

---

# 48. No Automatic Provider Switching

If Claude fails:

```text
do not automatically switch to Codex

```

If the selected adapter is unavailable:

```text
stop

```

Provider fallback/routing is policy and belongs later.

---

# 49. Preserve Existing Manual Commands

All existing manual commands must continue working:

```text
loopctl run
loopctl gate
loopctl verify
loopctl diagnose
loopctl retry
loopctl status
loopctl ready
loopctl verify-ready
loopctl usage
loopctl verification

```

`execute` is a composition layer.

It does not replace the lower-level commands.

They remain useful for debugging and manual control.

---

# 50. Do Not Use the CLI as an Internal Subprocess

Avoid implementing:

```text
spawn("loopctl run ...")
spawn("loopctl gate ...")
spawn("loopctl retry ...")

```

from the orchestrator.

Instead, reuse the Runtime functions behind those commands.

CLI-to-CLI orchestration makes state/error handling fragile.

Refactor thin command handlers where necessary so both:

```text
manual CLI
automatic orchestrator

```

call the same Runtime functions.

Preserve behavior exactly.

---

# 51. Deterministic State Reconciliation

Before every next action:

```text
reload Task
reload canonical Run artifacts
reload Gate Report
reload Verification Report
reload Diagnosis where relevant

```

Do not rely on the previous function's return value as the only truth.

Disk-backed Runtime State remains authoritative.

This also makes future process restart/resume easier.

---

# 52. Crash / Restart Safety

This step does not implement Operation Journal recovery.

However, structure execution artifacts so an interrupted `execute` does not destroy lower-level Run state.

If the orchestrator process crashes:

- previously completed Worker Run remains valid
- Gate Report remains valid
- Verification Report remains valid
- Failure Memo remains valid

A later:

```text
loopctl execute TASK-001

```

should inspect current Runtime facts and continue only when the state is unambiguous.

If state is ambiguous:

```text
NEEDS_HUMAN

```

Do not guess.

---

# 53. Avoid Duplicate Paid Calls on Resume

When `execute` resumes:

If the latest canonical Run already has:

```text
valid Gate PASS

```

do not rerun Gates unnecessarily.

If it already has:

```text
valid Verifier PASS and Task DONE

```

do not launch another Verifier.

If it has:

```text
Verifier FAIL + canonical Diagnosis

```

do not pay for another Verifier before handling recovery policy.

Use existing immutable artifacts.

---

# 54. Duplicate Execute Protection

Do not support two simultaneous:

```text
loopctl execute TASK-001

```

processes safely by pretending the current Runtime has leases.

Actual Lease locking is not implemented.

At minimum, use a lightweight local execution marker if necessary to refuse obvious duplicate orchestrators for the same Task.

For example:

```text
.loop-local/executions/active/TASK-001.json

```

Only if this can be implemented safely and cleaned up on normal exit.

Do not claim this is a full Lease system.

If stale ownership cannot be resolved safely:

```text
RECOVERY_AMBIGUOUS

```

Do not implement a general Lease subsystem in this step.

---

# 55. Execution-Level Stop Evaluator

Implement Stop evaluation as a Runtime function.

The stop evaluator should return a structured result such as:

```json
{
  "stop": true,
  "result": "NEEDS_HUMAN",
  "reason": "MAX_ATTEMPTS_REACHED"
}

```

or:

```json
{
  "stop": false
}

```

Do not scatter stopping rules across unrelated CLI branches.

This function will become the basis for later governance.

---

# 56. Explicit Loop Bound

Even if a bug occurs in state resolution, the orchestrator must have a hard deterministic safety bound.

For example:

```text
max orchestration stage transitions

```

derived from the configured attempt limits plus a small fixed allowance.

Do not allow:

```text
while(true)

```

without an independent guard.

If the guard is unexpectedly exceeded:

```text
FAILED
→ RUNTIME_LOOP_GUARD_EXCEEDED

```

No further AI calls.

This is a safety guard, not the primary retry policy.

---

# 57. Minimal Repeated-Failure Stop

Use Step 6 failure fingerprints.

A conservative V0 rule may be:

```text
same failure fingerprint
on consecutive Worker attempts
AND
no meaningful subject change between attempts

```

→ stop as:

```text
STALLED

```

If the existing evidence cannot prove stagnation confidently, do not trigger it.

Attempt limits remain the fallback safety net.

Do not add semantic LLM comparison.

---

# 58. Execution Usage Summary

Build the usage summary strictly from canonical stage artifacts.

For every AI invocation record at least:

```text
stage
attempt
run_id
adapter
model
provider token fields
provider cost if known
duration

```

Do not place this telemetry into future Worker or Verifier Context.

It is operator/runtime metadata only.

---

# 59. Example Successful Automatic Loop

Desired behavior:

```text
> loopctl execute TASK-001

Execution: EXEC-001
Task: TASK-001

Attempt 1

Worker
  success
  RUN-A
  → REVIEW

Gate
  build PASS
  test FAIL

Diagnosis
  GATE_FAILURE
  RETRY_WITH_HINT

Retrying...

Attempt 2

Worker
  success
  RUN-B
  → REVIEW

Gate
  build PASS
  test PASS

Verifier
  PASS

TASK-001
  REVIEW → DONE

Execution Result: DONE
Attempts: 2

```

No operator command is required between stages.

---

# 60. Example Human Escalation

```text
> loopctl execute TASK-002

Execution: EXEC-002

Attempt 1
Worker → REVIEW

Gate → ERROR

Diagnosis
  RECOVERY_AMBIGUOUS
  NEEDS_HUMAN

Execution stopped.

Result: NEEDS_HUMAN
Reason: Gate configuration/environment failure

No retry performed.

```

---

# 61. Example Attempt Limit

```text
Attempt 1
Verifier FAIL

Attempt 2
Verifier FAIL

Attempt 3
Verifier FAIL

Execution stopped.

Result: LIMIT_REACHED
Reason: max_attempts reached

```

No fourth Worker call.

---

# 62. Example Stagnation

```text
Attempt 1
Gate test FAIL
Fingerprint: abc

Attempt 2
Gate test FAIL
Fingerprint: abc
No meaningful subject progress

Execution stopped.

Result: STALLED

```

No automatic third retry merely because max attempts still allows one.

Only apply this when the evidence is deterministic.

---

# 63. Example Resume

Suppose the operator manually ran:

```text
loopctl run TASK-003

```

and the Task is now REVIEW.

Then:

```text
loopctl execute TASK-003

```

should not launch another first Worker.

It should inspect state and continue:

```text
REVIEW
→ Gate
→ Verifier
→ ...

```

Likewise if Gates already passed, continue at Verifier.

---

# 64. CLI Help

Add the real command to Help:

```text
Execute
  execute <TASK>    Run the controlled Task loop until DONE or a stop condition

```

Do not advertise:

```text
execute-all
auto
planner

```

---

# 65. README

Add a concise Full Loop section.

Example:

```text
Automatic Task Execution

.\loopctl execute TASK-001

The Runtime automatically performs:

Worker → Gate → Verifier → Diagnose → Retry

until:

- DONE
- BLOCKED
- limit reached
- stagnation
- unsafe/ambiguous recovery
- human decision required

```

Do not duplicate [DESIGN.md](http://DESIGN.md).

---

# 66. Validation

This step requires strong deterministic orchestration tests.

Use mock Worker and mock Verifier adapters.

Do not spend live LLM tokens on the failure matrix.

Test at least:

## Successful loops

- TODO → Worker → Gate PASS → Verifier PASS → DONE
- first Gate FAIL → Diagnose → Retry → Gate PASS → Verifier PASS → DONE
- first Verifier FAIL → Diagnose → Retry → Gate PASS → Verifier PASS → DONE
- multiple allowed attempts ending DONE

## Resume

- execute from TODO
- execute from REVIEW before Gate
- execute from REVIEW after Gate PASS
- execute from REVIEW after Gate FAIL
- execute from REVIEW after Verifier FAIL
- execute from failed IN_PROGRESS Worker attempt
- already DONE → no-op success
- BLOCKED → stop
- DROPPED → refuse

## Stop behavior

- max attempts reached
- max consecutive failures reached
- POLICY_VIOLATION
- RECOVERY_AMBIGUOUS
- Gate ERROR
- ambiguous Gate TIMEOUT
- stale subject
- REPLAN_REQUIRED
- NEEDS_HUMAN
- Task becomes BLOCKED
- deterministic stagnation
- orchestration hard-loop guard

## Retry correctness

- Diagnose always occurs before retry
- RETRY invokes Worker without invented hint
- RETRY_WITH_HINT injects canonical Failure Memo
- same contract preserved across attempts
- attempt numbers increment
- lineage root/parent IDs correct
- old Gate/Verifier PASS not reused for changed subject

## Context isolation

- previous Worker narrative absent
- previous stdout absent
- Failure Memo only in Worker retry context
- Failure Memo absent from Verifier
- [DESIGN.md](http://DESIGN.md) absent
- unrelated Tasks absent

## Paid-call safety

- no Worker call after attempt limit
- no Worker call after NEEDS_HUMAN
- no Verifier call after Gate FAIL
- no duplicate Verifier on resume when authoritative result already exists
- no unnecessary Worker on REVIEW resume
- Diagnose uses zero LLM calls

## Execution Report

- Execution ID created
- attempts recorded
- Run IDs canonical
- stop reason correct
- duration recorded
- usage references correct
- known provider cost aggregate correct where available
- unknown cost explicitly represented
- no fabricated token totals

## Interruption / duplicate safety

- interruption preserves existing artifacts
- no success fabricated
- duplicate same-Task execute refused where protection is implemented
- stale marker handled conservatively

## Regression

All previous deterministic suites must remain green:

- recovery
- gate
- verifier
- CLI
- Worker behavior
- Task validation
- subject fingerprinting
- telemetry
- wrappers

No real Claude/Codex calls should be used for the main orchestration test suite.

After deterministic tests pass, perform at most one small controlled live `execute` invocation only if it provides meaningful end-to-end confidence.

Do not spend repeated real model calls for failure testing.

Remove all temporary Tasks, Runs, execution reports, and files afterward.

Verify:

- `.loop/[DESIGN.md](http://DESIGN.md)` byte-identical
- `TASK-EXAMPLE.yaml` unchanged
- no test fixtures remain

---

# 67. Final Report

When finished, report only:

- Runtime files created or modified
- orchestration architecture
- `execute` command behavior
- next-action model
- resume behavior by Task state
- Stop Condition model
- automatic retry rules
- stagnation rule
- attempt/loop guards
- Execution Report schema
- execution-level usage summary
- operator interruption behavior
- duplicate-execution behavior
- confirmation that existing stage modules were reused rather than reimplemented
- confirmation that Diagnose / orchestration decisions use zero additional LLM calls
- deterministic test results
- controlled live-test result if one was performed
- anything intentionally deferred to Step 8 Planner

Do not proceed to Goal Planning, Task generation, Task decomposition, Replan execution, queue scheduling, parallel Workers, or daemon mode.

The Full Automatic Loop must operate on one already-defined Task only.