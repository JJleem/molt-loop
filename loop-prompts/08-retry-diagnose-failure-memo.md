# Loop Runtime V0 — Step 6 Diagnose, Failure Memo, and Manual Retry

The V0 Loop Runtime currently implements:

```text
Task
→ Worker
→ REVIEW
→ Deterministic Gates
→ Independent Verifier
→ DONE

```

It also provides the operator-facing CLI:

```text
loopctl status
loopctl run
loopctl gate
loopctl verify
loopctl usage

```

However, a failed Worker, Gate, or Verifier still requires manual reasoning before another Worker attempt can begin.

This step introduces:

```text
Failure
→ Diagnose
→ Failure Memo
→ Explicit Retry
→ New Worker Attempt

```

This step does **not** implement the fully automatic loop.

The operator must still explicitly request a retry.

---

# 1. Goal

Implement a deterministic failure diagnosis and retry layer that allows the Runtime to:

1. Identify why a Run failed.
2. Classify the failure.
3. Decide whether another Worker attempt is appropriate.
4. Distill only the useful failure lesson into a bounded Failure Memo.
5. Preserve immutable diagnosis artifacts.
6. Create a new Worker attempt linked to the failed attempt.
7. Inject the Failure Memo into the new Worker Snapshot.
8. Enforce retry / consecutive-failure limits.
9. Refuse unsafe or ambiguous recovery.
10. Preserve Worker, Gate, and Verifier isolation.

The intended flow is:

```text
Worker #1
↓
Gate or Verifier failure
↓
Diagnose
↓
Failure Memo
↓
operator runs retry
↓
Worker #2
↓
REVIEW

```

After Worker #2 reaches REVIEW, the operator still runs:

```text
loopctl gate ...
loopctl verify ...

```

manually.

Automatic chaining belongs to Step 7.

---

# 2. Inspect the Existing Runtime First

Before changing anything, inspect the actual current implementation:

- `.loop/[KERNEL.md](http://KERNEL.md)`
- `.loop/project.yaml`
- `.loop/policies/limits.yaml`
- `.loop/tasks/TASK-EXAMPLE.yaml`
- `tools/loop-runtime/loopctl.mjs`
- `tools/loop-runtime/task-store.mjs`
- `tools/loop-runtime/transitions.mjs`
- `tools/loop-runtime/context-builder.mjs`
- `tools/loop-runtime/config.mjs`
- `tools/loop-runtime/subject.mjs`
- `tools/loop-runtime/worker/`
- `tools/loop-runtime/gate/`
- `tools/loop-runtime/verifier/`
- `tools/loop-runtime/adapters/`
- `tools/loop-runtime/[README.md](http://README.md)`
- project-root `loopctl.cmd`
- project-root `loopctl`

Also re-read only the relevant sections of `.loop/[DESIGN.md](http://DESIGN.md)` concerning:

- Diagnose
- failure classification
- escalation ladder
- Failure Memo
- Context management
- Stop Conditions
- retry limits
- Human Escalation

Do not copy [DESIGN.md](http://DESIGN.md) into Worker context.

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

---

# 3. Core Principle: Retry Is Not a Loop

Preserve this distinction:

```text
Retry
= repeat an attempt

Loop
= inspect failure, classify it, change the next attempt's information or approach

```

Do not implement:

```text
failure
→ blindly run Worker again

```

A retry must have a Runtime diagnosis.

Every retry must be traceable to:

```text
source Run
→ diagnosis
→ Failure Memo
→ next Run

```

---

# 4. Diagnose Must Be Runtime-Owned

The first V0 Diagnose implementation must be deterministic.

Do not invoke another LLM merely to diagnose a failure.

Diagnosis should be derived from existing Runtime artifacts such as:

- Worker Runtime Envelope
- Worker Result validation errors
- Worker process facts
- protected-path violations
- Gate Report
- Gate statuses
- Gate stderr/stdout metadata
- Verification Report
- Verifier Result
- failed Acceptance Criteria
- subject-staleness facts
- provider/process termination facts

Do not ask Claude or Codex:

> Why did this fail?

for this step.

A Worker retry itself may consume LLM tokens.

Diagnosis and Failure Memo generation must consume zero LLM tokens.

---

# 5. Diagnosis Architecture

Introduce a small diagnosis/recovery layer.

Prefer a structure similar to:

```text
tools/loop-runtime/
├─ recovery/
│  ├─ diagnose.mjs
│  ├─ failure-memo.mjs
│  ├─ retry.mjs
│  └─ limits.mjs

```

Slightly different filenames are acceptable if they better match the existing Runtime.

Do not create a workflow engine or large recovery framework.

This layer should be reusable later by the Full Automatic Loop.

---

# 6. Failure Classification

Use a small explicit classification model inspired by the Runtime design.

Support the failure classes that can actually be observed by the current implementation.

Prefer classifications such as:

```text
PROCESS_CRASH
TIMEOUT
SCHEMA_FAILURE
GATE_FAILURE
VERIFY_FAILED
PERMISSION_DENIED
RECOVERY_AMBIGUOUS

```

Use existing Runtime-specific terminal conditions where they are already authoritative, for example:

```text
STALE_VERIFICATION_SUBJECT
POLICY_VIOLATION

```

Do not invent dozens of failure types.

Each diagnosis must record:

```text
stage
failure_class
retryable
recommended_action
reason

```

Example:

```json
{
  "stage": "gate",
  "failure_class": "GATE_FAILURE",
  "retryable": true,
  "recommended_action": "RETRY_WITH_HINT",
  "reason": "Gate test exited with code 1."
}

```

---

# 7. Stage-Specific Diagnosis

The Runtime must identify the actual failed stage.

At minimum support:

```text
worker
gate
verifier

```

## Worker failures

Examples:

```text
process non-zero
→ PROCESS_CRASH

worker timeout
→ TIMEOUT

missing / malformed Worker Result
→ SCHEMA_FAILURE

protected Runtime mutation
→ POLICY_VIOLATION / PERMISSION_DENIED

```

## Gate failures

Example:

```text
normal command exit != 0
→ GATE_FAILURE

```

Do not treat all Gate outcomes identically.

A Gate `ERROR` caused by malformed configuration or missing execution environment is generally not evidence that implementation code should be retried.

A Gate `TIMEOUT` may be ambiguous.

Prefer conservative recovery classification.

## Verifier failures

A valid Verifier result with failed verifier criteria:

```text
→ VERIFY_FAILED

```

A malformed Verifier Result:

```text
→ SCHEMA_FAILURE

```

Verifier process failure:

```text
→ PROCESS_CRASH or TIMEOUT

```

Verifier policy mutation:

```text
→ PERMISSION_DENIED / POLICY_VIOLATION

```

---

# 8. Recovery Action Model

Each diagnosis should recommend one of a small set of actions:

```text
RETRY
RETRY_WITH_HINT
RERUN_GATES
REPLAN_REQUIRED
NEEDS_HUMAN
NO_ACTION

```

Only implement actual Worker retry behavior for:

```text
RETRY
RETRY_WITH_HINT

```

Other actions are recommendations in Step 6.

Do not implement Replan yet.

Do not implement Decompose yet.

Do not implement automatic Human Escalation queues yet.

Examples:

```text
Worker process crash
→ RETRY

Gate FAIL
→ RETRY_WITH_HINT

Verifier FAIL
→ RETRY_WITH_HINT

stale verification subject
→ RERUN_GATES

protected Runtime mutation
→ NEEDS_HUMAN

ambiguous environment/configuration failure
→ NEEDS_HUMAN

```

---

# 9. Failure Memo

Create a distilled Failure Memo for retryable failures.

The Failure Memo must not contain the previous Run's entire history.

Do not inject:

- full Worker conversation
- full stdout
- full stderr
- full Gate logs
- full Verifier transcript
- previous Worker summary
- previous Worker reasoning
- previous AI chat/session history

Instead store only the information needed to avoid repeating the same failure.

A conceptual Failure Memo:

```json
{
  "source_run_id": "RUN-...",
  "attempt": 1,
  "stage": "verifier",
  "failure_class": "VERIFY_FAILED",

  "lesson": "AC3 is not satisfied: malformed input handling is missing.",

  "failed_gates": [],

  "failed_criteria": [
    {
      "id": "AC3",
      "reason": "No malformed-input handling is visible in the implementation."
    }
  ],

  "recovery_hint": "Add explicit malformed-input validation before conversion.",

  "evidence_refs": [
    "verification/verification-report.json"
  ]
}

```

Keep the Memo compact.

---

# 10. Failure Memo Must Be Evidence-Grounded

Do not invent a recovery hint unsupported by the failure evidence.

For Gate failures, use facts such as:

```text
gate name
status
exit code
bounded stderr excerpt when useful

```

For Verifier failures, use:

```text
failed criterion ID
Verifier reason

```

For Worker Result failures, use:

```text
specific schema validation error

```

If the Runtime cannot safely determine a useful lesson:

```text
recommended_action: NEEDS_HUMAN

```

Do not hallucinate a diagnosis merely to make Retry possible.

---

# 11. Bounded Error Excerpts

If stderr/stdout text is included in a Failure Memo, keep it bounded.

For example:

```text
maximum 2–4 KB

```

or another small deterministic cap.

Prefer:

```text
last relevant bounded lines

```

over full logs.

Do not include megabytes of test output in the next Worker Context.

Full logs remain available in Run artifacts.

Failure Memo is a distilled navigation artifact, not a log archive.

---

# 12. Failure Memo Persistence

Preserve immutable diagnosis artifacts under the failed Run.

Prefer:

```text
.loop-local/runs/RUN-FAILED/
└─ recovery/
   ├─ diagnosis.json
   └─ failure-memo.json

```

These artifacts should be Runtime-authored.

Do not overwrite them silently.

If diagnosis already exists for the same immutable failure evidence, reuse it.

If explicit recomputation is supported, preserve history rather than silently replacing previous artifacts.

Keep V0 simple.

---

# 13. Task `failure_memo` Field

The Task schema already contains:

```yaml
failure_memo: []

```

Do not weaken or remove this field.

However, do not introduce unsafe full-YAML rewrites merely to append Runtime-generated memo data.

Inspect the existing Task Store.

If Runtime-generated Failure Memos can be safely persisted into Task state without losing comments/formatting or weakening Single Writer guarantees, it may be done.

Otherwise, prefer immutable Run-scoped Failure Memo artifacts and have the Context Builder derive retry context from attempt lineage.

Do not create a large Task-storage rewrite solely for this feature.

The important invariant is:

```text
next Worker Attempt receives the distilled Failure Memo

```

not a specific storage implementation.

---

# 14. Retry Lineage

Every retry Run must identify where it came from.

Add deterministic lineage metadata.

Prefer fields similar to:

```json
{
  "run_id": "RUN-NEW",
  "task_id": "TASK-001",

  "attempt": 2,

  "lineage": {
    "root_run_id": "RUN-FIRST",
    "parent_run_id": "RUN-FAILED",
    "retry_reason": "VERIFY_FAILED",
    "failure_memo": "RUN-FAILED/recovery/failure-memo.json"
  }
}

```

The exact manifest shape may differ.

Do not use previous session IDs as lineage.

Runtime Run IDs are authoritative.

---

# 15. Attempt Numbers

Retry attempts must increment deterministically.

Example:

```text
Worker #1
attempt: 1

Worker #2
attempt: 2

Worker #3
attempt: 3

```

Do not determine attempt number from the AI.

Do not trust Worker-provided attempt values.

Runtime owns attempt numbering.

---

# 16. Retry Limits

Enforce existing Task and Runtime limits.

Inspect the actual current configuration before adding new fields.

Use existing values where present, such as:

```text
max_attempts
max_consecutive_failures
retry_max

```

Do not duplicate limits across multiple configuration files unnecessarily.

A retry must be refused when the applicable limit has been reached.

Example:

```text
Retry denied.

Task: TASK-001
Attempts: 3 / 3

Recommended action: NEEDS_HUMAN

```

Do not silently exceed the configured retry budget.

---

# 17. Consecutive Failure Handling

Track consecutive failures deterministically.

Do not implement full tool-call-level Stall Detection yet.

This step does not need to inspect repeated internal Claude tool calls.

However, preserve enough information for future stall detection:

- attempt count
- failure class
- failure fingerprint
- changed-file count
- failed Gates
- failed criteria

A repeated identical failure may be visible in diagnosis history.

If retry limits are reached, stop.

Do not automatically keep retrying because the Worker keeps producing output.

---

# 18. Failure Fingerprint

Create a deterministic fingerprint for a diagnosis when practical.

For example, hash a normalized representation of:

```text
stage
failure_class
failed gate names/statuses
failed criterion IDs
stable normalized error reason

```

Do not include timestamps.

The fingerprint should help later identify:

```text
same failure repeated across attempts

```

This is metadata only in Step 6.

Do not implement a complete Stall Engine yet.

---

# 19. Retry Eligibility

Add a strict preflight before launching another paid Worker invocation.

A retry must have:

- a valid Task
- a canonical source Run
- a completed / terminated failed attempt
- a deterministic Diagnosis
- a retryable recommended action
- a valid Failure Memo
- remaining retry/attempt budget
- no unresolved policy violation
- no ambiguous Runtime state
- no incompatible Task state
- a safe current repository subject

Do not launch an AI before preflight passes.

---

# 20. Repository Subject Safety Before Retry

The Runtime currently uses strict Verification Subject fingerprints.

Preserve that safety model.

For Gate or Verifier failures that have an authoritative subject fingerprint:

```text
current repository subject
must match
the failed Run's authoritative subject

```

before starting a Worker retry.

If the working tree has changed independently since the failure:

```text
RECOVERY_AMBIGUOUS

```

and refuse the Worker retry.

Example:

```text
Retry refused:
repository state changed since the failed verification attempt.

Recommended action:
inspect changes and re-establish a known subject.

```

Do not layer a new retry onto unrelated working-tree changes.

---

# 21. Fail-Closed When Recovery Safety Is Unknown

For earlier Worker failures where no Gate-bound verification subject exists, use the strongest deterministic evidence currently available.

If the Runtime cannot establish that another Worker attempt is safe:

```text
failure_class: RECOVERY_AMBIGUOUS
recommended_action: NEEDS_HUMAN

```

Do not guess.

Do not automatically reset or discard repository changes.

Automatic rollback belongs to a later Recovery layer.

---

# 22. Retry State Transitions

Use the existing transition engine.

Do not bypass it.

For a retry after Gate or Verifier failure:

```text
REVIEW
→ IN_PROGRESS
→ new Worker attempt

```

must use the existing legal:

```text
REVIEW -> IN_PROGRESS

```

transition.

When the new Worker succeeds:

```text
IN_PROGRESS -> REVIEW

```

continues through the existing Worker Result path.

If the Worker becomes blocked:

```text
IN_PROGRESS -> BLOCKED

```

continues through existing Runtime semantics.

---

# 23. Worker-Stage Retry

A Worker execution failure may leave the Task:

```text
IN_PROGRESS

```

If the Worker process has definitively terminated and the diagnosis is retryable, a new retry attempt may begin while keeping the Task `IN_PROGRESS`.

Do not force an artificial:

```text
IN_PROGRESS -> TODO -> IN_PROGRESS

```

cycle merely to reuse the normal `run` command.

Implement a dedicated retry path.

Do not weaken normal:

```text
loopctl run

```

eligibility.

`run` should remain the normal first-attempt entry point.

---

# 24. Retry Must Be a Separate Command

Add an explicit operator command:

```text
loopctl retry <RUN-ID|TASK-ID>

```

Run ID remains canonical.

Task ID may resolve to the latest retry-eligible failed Run only when deterministic.

Print the selected source Run.

Example:

```text
Task: TASK-001
Source Run: RUN-...
Failure: VERIFY_FAILED
Attempt: 1

Failure Memo:
  AC3 malformed-input handling is missing.

Starting Worker attempt 2...

```

This command performs exactly one new Worker attempt.

---

# 25. Add `diagnose`

Add a read-only command:

```text
loopctl diagnose <RUN-ID|TASK-ID>

```

This command:

- performs zero LLM calls
- resolves the failed Run
- generates or reads canonical Diagnosis
- generates or reads the Failure Memo
- prints a concise operator summary

Example:

```text
Task: TASK-001
Run: RUN-...

Stage: verifier
Failure: VERIFY_FAILED
Retryable: yes
Recommended action: RETRY_WITH_HINT

Failed Criteria:
  AC3 — malformed input handling is missing

Next attempt:
  Worker attempt 2

```

Do not launch the Worker from `diagnose`.

---

# 26. Retry Automatically Performs Diagnose Preflight

The operator should not be required to run:

```text
diagnose

```

manually before every retry.

`loopctl retry` should internally:

```text
resolve failure
→ diagnose
→ validate retry policy
→ generate/reuse Failure Memo
→ launch one new Worker attempt

```

The separate `diagnose` command exists for inspection.

Do not duplicate diagnosis logic between the two commands.

---

# 27. Retry Worker Context

The new Worker Snapshot should continue to use:

```text
KERNEL
ROLE
TASK
ACCEPTANCE CRITERIA
FAILURE MEMO

```

The Failure Memo section must now contain Runtime-generated lessons from the relevant retry lineage.

Do not inject:

- previous Worker stdout
- previous Worker summary
- previous Worker notes
- previous Worker transcript
- full Gate logs
- full Verifier transcript
- previous AI session history

Example:

```text
--- FAILURE MEMO ---

Attempt 1
Stage: verifier
Failure: VERIFY_FAILED

Lesson:
AC3 failed because malformed input handling is not implemented.

Recovery Hint:
Add explicit malformed-input handling and ensure the behavior is visible
in the implementation and relevant tests.

```

Keep this bounded.

---

# 28. Multiple Failure Memos

If multiple attempts have failed, the next Worker may receive multiple distilled Failure Memos.

Do not carry the complete historical Run contents.

Example:

```text
Attempt 1:
Test gate failed because parser returned an empty output.

Attempt 2:
Verifier found missing malformed-input handling.

```

Since V0 attempt limits are intentionally small, a short memo chain is acceptable.

Do not inject unlimited historical memos.

If a configured attempt cap exists, the memo chain naturally remains bounded by it.

---

# 29. Verifier Isolation Must Remain Unchanged

Failure Memo is Worker recovery context.

Do not inject Failure Memo into the independent Verifier Snapshot.

The Verifier must continue to receive only:

- Task
- Acceptance Criteria
- Canonical Diff
- Gate Results
- Evidence
- Runtime Facts

Do not let prior failure narratives bias the Verifier.

Preserve existing input isolation exactly.

---

# 30. Gate Isolation Must Remain Unchanged

The Gate Runner does not need Failure Memo.

Do not alter Gate commands based on AI-generated recovery text.

Gate commands remain Runtime-controlled deterministic configuration.

A new Worker attempt reaches REVIEW.

The operator then runs:

```text
loopctl gate <new Run>

```

normally.

---

# 31. No Automatic Gate or Verifier Invocation

This is strict.

After:

```text
loopctl retry TASK-001

```

the Runtime may launch one Worker attempt.

If that Worker succeeds:

```text
Task → REVIEW

```

Then stop.

Do not automatically:

```text
run Gates
launch Verifier
retry again

```

Step 7 will compose the entire loop.

---

# 32. No Automatic Replan

Do not implement an AI Planner/Replanner in this step.

If recovery has escalated beyond allowed retries, Diagnosis may report:

```text
recommended_action: REPLAN_REQUIRED

```

but it must stop there.

Do not call another AI to rewrite the Task.

Do not modify Acceptance Criteria automatically.

Do not decompose the Task.

---

# 33. No Acceptance Criteria Mutation

A retry must not weaken the contract.

Do not allow Worker or Runtime recovery logic to modify:

- Acceptance Criteria
- verification type
- Gate refs
- stop conditions

merely to make a retry pass.

The same Task contract remains authoritative across attempts.

If the contract itself is wrong or impossible:

```text
NEEDS_HUMAN

```

is the correct outcome.

---

# 34. Failure Memo Is Not a Contract Change

A Failure Memo is recovery guidance.

It does not change:

```text
Goal
Acceptance Criteria
Stop Condition

```

The next Worker still has to satisfy the original Task.

Do not treat:

```text
recovery_hint

```

as a replacement Acceptance Criterion.

---

# 35. Runtime Artifacts

A failed Run may now look like:

```text
.loop-local/runs/RUN-ATTEMPT-1/
├─ context.md
├─ manifest.json
├─ worker-result.json
├─ runtime-envelope.json
├─ gates/
├─ gate-report.json
├─ verification/
│  └─ ...
│
└─ recovery/
   ├─ diagnosis.json
   └─ failure-memo.json

```

The retry Run:

```text
.loop-local/runs/RUN-ATTEMPT-2/
├─ context.md
├─ manifest.json
├─ worker-result.json
└─ runtime-envelope.json

```

must reference Attempt 1 through lineage metadata.

Do not copy every previous artifact into the new Run directory.

---

# 36. Diagnosis Schema

Prefer a canonical shape similar to:

```json
{
  "schema": 1,

  "task_id": "TASK-001",
  "run_id": "RUN-...",

  "stage": "verifier",
  "failure_class": "VERIFY_FAILED",

  "retryable": true,
  "recommended_action": "RETRY_WITH_HINT",

  "failure_fingerprint": "...",

  "attempt": 1,
  "remaining_attempts": 2,

  "failed_gates": [],
  "failed_criteria": ["AC3"],

  "reason": "Verifier rejected AC3.",

  "source_artifacts": [
    "verification/verification-report.json"
  ]
}

```

Only include fields supported by actual Runtime evidence.

Do not fabricate values.

---

# 37. Failure Memo Schema

Prefer a small shape such as:

```json
{
  "schema": 1,

  "source_run_id": "RUN-...",
  "attempt": 1,

  "stage": "verifier",
  "failure_class": "VERIFY_FAILED",

  "lesson": "AC3 failed because malformed-input handling is missing.",

  "recovery_hint": "Implement explicit malformed-input handling.",

  "failed_gates": [],

  "failed_criteria": [
    {
      "id": "AC3",
      "reason": "No malformed-input handling is visible."
    }
  ],

  "evidence_refs": [
    "verification/verification-report.json"
  ],

  "failure_fingerprint": "..."
}

```

Keep it intentionally small.

---

# 38. Retry Telemetry

Existing Worker telemetry must continue to work for every retry attempt.

A retry Worker invocation is a real paid Worker invocation.

Record its usage exactly as for Attempt 1:

- context size
- provider token usage when available
- provider cost when available
- duration
- adapter
- model
- output size

Do not combine usage across attempts yet.

Do not synthesize a Task total yet.

Lineage must make future aggregation possible.

---

# 39. Diagnosis Telemetry

Diagnose and Failure Memo generation are deterministic Runtime operations.

They must record:

```text
LLM tokens: 0

```

conceptually.

Do not perform additional LLM calls.

A `diagnose` command should have effectively zero AI cost.

---

# 40. Operator Status

If straightforward, extend:

```text
loopctl status

```

to expose derived recovery information.

Example:

```text
REVIEW
  TASK-001
    latest run: RUN-...
    gates: FAIL
    recovery: RETRY_WITH_HINT

```

or:

```text
IN PROGRESS
  TASK-002
    latest run: RUN-...
    worker: failed
    recovery: RETRY

```

For a non-retryable failure:

```text
REVIEW
  TASK-003
    recovery: NEEDS HUMAN

```

Do not persist new Task states.

Do not duplicate diagnosis logic inside `status`.

Read existing canonical diagnosis artifacts / recovery derivation.

If this meaningfully complicates Step 6, defer the presentation change.

---

# 41. Friendly Operator Errors

Examples:

```text
Retry refused:
TASK-001 has no retryable failed Run.

```

```text
Retry refused:
maximum attempts reached (3/3).

Recommended action: NEEDS_HUMAN

```

```text
Retry refused:
repository state changed since RUN-....

Recommended action: NEEDS_HUMAN

```

```text
Retry refused:
latest failure is Gate ERROR, not an implementation failure.

Recommended action:
fix Gate configuration and rerun Gates.

```

Do not emit stack traces for expected operator mistakes.

Preserve existing debug behavior for unexpected internal errors.

---

# 42. Exit Codes

Preserve existing CLI tiers.

Prefer:

```text
0
diagnosis succeeded / retry Worker invocation completed successfully

1
retry denied or Worker attempt failed

2
invalid CLI usage

```

Do not change existing Gate/Verifier exit semantics.

---

# 43. Preserve Runtime Integrity

Do not regress:

- Runtime Single Writer
- `.loop` protected paths
- Worker integrity checking
- Verifier read-only integrity
- subject fingerprints
- Gate report binding
- canonical Verification Report
- DONE transition rules

A retry Worker gets the same permissions as an ordinary Worker.

Do not loosen protection because it is a retry.

---

# 44. Preserve Current Worker Adapter Behavior

Do not rewrite provider adapters unnecessarily.

Retry should reuse the existing Worker execution layer.

Do not create:

```text
retry-specific Claude adapter

```

The Retry layer should prepare:

```text
new Snapshot
+
Failure Memo
+
lineage

```

and invoke the normal Worker Runner through existing adapter infrastructure.

---

# 45. Preserve Current Provider Isolation

The Runtime-launched Worker and Verifier must continue using the existing explicit isolated invocation behavior.

Do not accidentally load interactive-session history or project instructions that are not part of the Runtime-built Snapshot.

Do not weaken Verifier read-only mode.

---

# 46. Preserve Current Gate/Verifier Behavior

Do not modify the meaning of:

```text
Gate PASS
Verifier PASS
DONE

```

Retry exists only because some earlier stage failed.

A successful retry Worker still goes to:

```text
REVIEW

```

not DONE.

It must pass a fresh Gate run and fresh Verifier evaluation later.

Previous Gate PASS / Verifier PASS artifacts must never be reused for a changed retry subject.

---

# 47. Previous Verification Becomes Historical

When a retry Worker modifies the repository:

- old Gate Reports remain historical evidence
- old Verifier Results remain historical evidence
- they do not apply to the new subject
- `VERIFY_READY` must be recomputed for the new Run

Do not overwrite old Reports.

Do not carry old PASS status onto the retry Run.

---

# 48. Explicitly Out of Scope

Do not implement:

- automatic Worker → Gate chaining
- automatic Gate → Verifier chaining
- automatic Verifier FAIL → Retry chaining
- unlimited retries
- automatic loop daemon
- Replan execution
- Task decomposition
- Planner
- automatic Acceptance Criteria changes
- parallel Workers
- Git Worktree automation
- lease locking
- rollback
- automatic mutation restoration
- Budget enforcement
- model selection optimization
- Monitor
- Meta Loop
- Queue
- Web UI
- Database
- scheduling
- background execution

Those belong to later steps.

---

# 49. CLI After This Step

The operator flow should become:

```text
loopctl status

loopctl run TASK-001
loopctl gate TASK-001
loopctl verify TASK-001

```

If Gate or Verifier fails:

```text
loopctl diagnose TASK-001

```

Then:

```text
loopctl retry TASK-001

```

Then again:

```text
loopctl gate TASK-001
loopctl verify TASK-001

```

The operator still controls each stage.

---

# 50. Validation

Use deterministic mocks for almost all recovery tests.

Do not spend real AI tokens on failure-path testing.

Test at least:

## Diagnose

- Worker process crash classification
- Worker timeout classification
- malformed Worker Result classification
- Worker policy violation classification
- Gate FAIL classification
- Gate ERROR handling
- Gate TIMEOUT handling
- Verifier FAIL classification
- malformed Verifier Result classification
- Verifier timeout/process failure
- stale subject classification
- recovery ambiguity
- zero LLM calls during Diagnose

## Failure Memo

- Gate Failure Memo
- Verifier Failure Memo
- Worker schema Failure Memo
- bounded stdout/stderr excerpt
- no Worker transcript
- no full Gate logs
- no Verifier transcript
- stable failure fingerprint
- immutable source artifact references

## Retry

- REVIEW → IN_PROGRESS retry
- Worker-failure retry while already IN_PROGRESS
- attempt increment
- root/parent Run lineage
- Failure Memo appears in retry Worker Snapshot
- previous Worker narrative absent
- retry success returns Task to REVIEW
- retry blocked result moves Task to BLOCKED
- retry process failure remains diagnosable
- retry denied after maximum attempts
- retry denied after policy violation
- retry denied after repository subject drift
- retry denied for non-retryable Gate ERROR
- retry denied when no canonical failed Run exists
- Task ID resolves deterministically
- Run ID remains canonical

## Regression

- existing `run` first-attempt semantics unchanged
- Worker telemetry unchanged
- Gate tests unchanged
- Verifier tests unchanged
- Gate Report behavior unchanged
- Verification Report behavior unchanged
- DONE behavior unchanged
- `status`, `help`, wrappers unchanged
- `.loop/[DESIGN.md](http://DESIGN.md)` byte-identical
- `TASK-EXAMPLE.yaml` unchanged

Use mock adapters for retry Worker execution where possible.

After deterministic tests pass, one small controlled live retry may be performed only if it provides useful integration confidence.

Do not consume repeated live model calls just to test failure paths.

Remove temporary fixtures and Runs afterward.

---

# 51. Final Report

When finished, report only:

- Runtime files created or modified
- failure classification model
- diagnosis schema
- Failure Memo schema
- recovery action model
- retry eligibility rules
- attempt / lineage model
- retry limit enforcement
- repository-subject safety behavior
- new CLI commands
- retry Worker context changes
- confirmation that Diagnose uses zero LLM calls
- retry telemetry behavior
- validation/test results
- anything intentionally deferred to Step 7

Do not proceed to automatic Worker → Gate → Verifier → Retry orchestration.

Do not implement the Full Automatic Loop.