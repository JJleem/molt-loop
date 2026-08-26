The V0 Runtime foundation, Task model, transition engine, Context Builder, Snapshot system, Acceptance Criteria verification schema, Worker execution layer, Runtime Envelope, integrity checks, and passive usage telemetry are now implemented.

The current Worker flow is approximately:

```text
Task
→ Snapshot
→ AI Worker
→ Structured Worker Result
→ Runtime validation
→ REVIEW

```

Before making any changes, inspect the current Runtime implementation and configuration, including:

- `.loop/[KERNEL.md](http://KERNEL.md)`
- `.loop/project.yaml`
- `.loop/tasks/TASK-EXAMPLE.yaml`
- `.loop/skills/[impl.md](http://impl.md)`
- `.loop/skills/[verifier.md](http://verifier.md)`
- `.loop/policies/limits.yaml`
- `tools/loop-runtime/loopctl.mjs`
- `tools/loop-runtime/config.mjs`
- `tools/loop-runtime/task-store.mjs`
- `tools/loop-runtime/transitions.mjs`
- `tools/loop-runtime/context-builder.mjs`
- `tools/loop-runtime/yaml-lite.mjs`
- `tools/loop-runtime/worker/runner.mjs`
- `tools/loop-runtime/worker/result.mjs`
- `tools/loop-runtime/worker/telemetry.mjs`
- `tools/loop-runtime/worker/adapters/`
- `tools/loop-runtime/[README.md](http://README.md)`

Also re-read only the relevant sections of `.loop/[DESIGN.md](http://DESIGN.md)` concerning:

- Feedback / Evidence
- Gate vs Verifier
- Stop conditions
- Independent verification
- Runtime State ownership
- Observability
- minimum implementation

Do not copy [DESIGN.md](http://DESIGN.md) into Runtime prompts or Worker context.

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

# Goal of This Step

Implement the first deterministic **Gate Runner**.

The Runtime must be able to take a Task currently awaiting verification and execute the deterministic checks required by that Task.

The intended flow after this step is:

```text
Worker
→ REVIEW
→ Gate Runner
   ├─ build
   ├─ lint
   ├─ test
   └─ Task-specific deterministic gates
→ PASS / FAIL

```

This step does **not** implement the independent AI Verifier.

This step does **not** implement automatic retry.

This step does **not** mark a Task `DONE`.

A Task remains in `REVIEW` after Gate execution, regardless of Gate PASS or FAIL.

Gate PASS only means:

> The deterministic verification layer passed and this Task/Run may become eligible for the future Verifier step.

Gate FAIL means:

> Verification has not succeeded. The Task is not DONE and no Verifier should run yet.

Do not automatically transition `REVIEW -> IN_PROGRESS` on Gate failure in this step because the retry/rework loop has not been implemented yet.

---

# 1. Gate Architecture

Introduce a small deterministic Gate execution layer.

Prefer a structure similar to:

```text
tools/loop-runtime/
├─ gate/
│  ├─ runner.mjs
│  ├─ resolver.mjs
│  └─ report.mjs

```

You may use slightly different filenames if they better match the existing Runtime.

Keep the implementation small and explicit.

Do not create a plugin framework, dependency injection container, workflow engine, or large class hierarchy.

The Gate Runner must not use an LLM.

---

# 2. Gate Definitions

Gate definitions come from the Runtime-controlled project configuration.

Use the existing `.loop/project.yaml`.

A configured Gate may look conceptually like:

```yaml
gates:
  build:
    command: npm run build

  lint:
    command: npm run lint

  test:
    command: npm test

```

Use the actual existing configuration shape where possible.

Do not invent build, lint, or test commands that do not exist.

Do not create fake application Gates just to make the schema look complete.

If the repository currently has no real build/test/lint commands, preserve that fact.

Use temporary deterministic fixtures for Runtime testing instead of inventing permanent project commands.

---

# 3. Resolve Required Gates

A Task's required deterministic Gates must be derived from two sources.

## A. Task stop condition

For example:

```yaml
stop_condition:
  gates:
    - build
    - test

```

## B. Gate-based Acceptance Criteria

For example:

```yaml
acceptance_criteria:
  - id: AC1
    description: PLY conversion is covered by the conversion test.
    verification:
      type: gate
      ref: test

```

The Runtime must calculate the union of:

```text
stop_condition.gates
+
all acceptance_criteria[].verification.ref
where verification.type == "gate"

```

Remove duplicates while preserving deterministic ordering.

Do not simply execute every Gate defined in `project.yaml`.

Execute only Gates required by the Task.

---

# 4. Gate Reference Validation

Every Gate reference used by a valid executable Task must resolve to an actual configured Gate.

For example:

```yaml
verification:
  type: gate
  ref: conversion_test

```

must fail deterministic preflight if no Gate named `conversion_test` exists.

Example error:

```text
TASK-001: unknown gate reference "conversion_test"

```

Also reject unknown Gate references appearing in:

```yaml
stop_condition:
  gates:

```

Do not silently ignore unknown Gates.

Do not silently convert an unknown Gate into a Verifier criterion.

Do not invent a Gate command.

Where practical, expose this validation through the existing `validate` or `doctor` command as well as Gate execution preflight.

---

# 5. Gate Eligibility

A Gate Run must operate against a specific completed Worker Run.

The Task must:

- be structurally valid
- have status `REVIEW`
- not be the example Task
- have a valid corresponding Worker Run
- have a valid Worker Result
- have no unresolved Worker policy violation
- have resolvable required Gate references

Do not run Gates against a `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`, or `DROPPED` Task.

Do not create a new Worker Run during Gate execution.

Do not invoke the AI Worker again.

---

# 6. Identify the Worker Run Deterministically

Gate results must be associated with a specific Worker Run, not only with a Task ID.

Prefer a command interface that makes this relationship explicit.

For example:

```bash
node tools/loop-runtime/loopctl.mjs gate RUN-20260825T...

```

The Runtime should derive the Task ID from that Run's manifest/envelope.

If you also provide a Task-oriented convenience command such as:

```bash
node tools/loop-runtime/loopctl.mjs gate TASK-001

```

it may select the latest eligible Worker Run only if that selection is deterministic and unambiguous.

The Run ID remains the canonical identity.

Do not accidentally apply Gate results from one Worker Run to another.

---

# 7. Gate Execution

Each required Gate must execute as a Runtime-owned subprocess.

For each Gate, record at minimum:

- gate name
- configured command
- start time
- finish time
- duration
- exit code
- signal if any
- timeout state
- stdout size
- stderr size
- final Gate status

The Gate Runner must use the actual project working directory unless the Gate configuration explicitly defines another safe working directory.

Use a platform-appropriate execution mechanism.

Inspect the actual current environment rather than assuming POSIX-only shell behavior.

Do not ask the Worker to run the Gate.

Runtime itself must execute it.

---

# 8. Gate Status Model

For V0, keep Gate states small and deterministic.

A single Gate may result in:

```text
PASS
FAIL
ERROR
TIMEOUT

```

Suggested meaning:

```text
PASS
command executed and exited with code 0

FAIL
command executed normally and exited non-zero

ERROR
the Runtime could not correctly launch or execute the configured Gate

TIMEOUT
the Gate exceeded its configured/default timeout

```

The overall Gate Run is:

```text
PASS

```

only if every required Gate is `PASS`.

Any:

```text
FAIL
ERROR
TIMEOUT

```

means the overall Gate Run did not pass.

Do not ask an LLM to classify Gate output.

Exit/process facts are authoritative.

---

# 9. Gate Timeout

Add a simple deterministic Gate timeout if one does not already exist.

Prefer a minimal Runtime setting such as:

```yaml
runtime:
  gate_timeout_seconds: 300

```

or an equivalent location consistent with the existing configuration.

If useful, an individual Gate may override the default timeout, but do not add complex timeout policy unless necessary.

A timeout must be explicit in the Gate Report.

Do not automatically retry timed-out Gates.

---

# 10. Gate Evidence

Gate output is stronger Evidence than a Worker claim.

The Runtime must generate authoritative Gate artifacts.

Do not treat Worker-submitted evidence references as Gate PASS.

For each Gate, preserve enough information to reproduce or diagnose the result.

Prefer storing authoritative Gate artifacts under the corresponding Run directory:

```text
.loop-local/runs/RUN-.../
├─ context.md
├─ manifest.json
├─ worker-result.json
├─ runtime-envelope.json
│
├─ gates/
│  ├─ build/
│  │  ├─ stdout.log
│  │  ├─ stderr.log
│  │  └─ result.json
│  │
│  └─ test/
│     ├─ stdout.log
│     ├─ stderr.log
│     └─ result.json
│
└─ gate-report.json

```

The exact structure may differ slightly if the current Run layout suggests a cleaner option.

Do not place authoritative Gate truth only inside Worker-writable Evidence locations.

Worker-provided Evidence and Runtime-generated Gate Evidence must remain conceptually separate.

---

# 11. Gate Report

Create one canonical `gate-report.json` for the Run.

A conceptual shape is:

```json
{
  "run_id": "RUN-...",
  "task_id": "TASK-001",

  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 0,

  "required_gates": [
    "build",
    "test"
  ],

  "result": "PASS",

  "gates": [
    {
      "name": "build",
      "status": "PASS",
      "command": "npm run build",
      "exit_code": 0,
      "timed_out": false,
      "duration_ms": 4312,
      "stdout_bytes": 1234,
      "stderr_bytes": 0
    }
  ]
}

```

You may add hashes or other deterministic Runtime facts if useful.

Do not add Worker self-evaluation to this file.

Do not add Verifier output because Verifier does not exist yet.

---

# 12. Gate Report Immutability / Re-run Behavior

Do not silently overwrite an existing Gate Report for the same Run.

Choose an explicit deterministic policy.

Preferred V0 behavior:

- if a completed Gate Report already exists, refuse by default
- allow an explicit re-run flag such as `--rerun` if straightforward
- if rerunning, preserve prior Gate evidence rather than silently destroying it

If adding safe rerun history significantly expands scope, simply refuse duplicate Gate execution in V0 and document that limitation.

Prefer correctness and auditability over convenience.

---

# 13. Task State Behavior

Gate execution must not introduce new persisted Task states.

Continue using only:

```text
TODO
IN_PROGRESS
REVIEW
DONE
BLOCKED
DROPPED

```

Do not add:

```text
GATE_PASS
GATE_FAIL
VERIFY_READY
STALLED

```

as persisted states.

Those are derived Runtime conditions.

After Gate execution:

```text
PASS → Task remains REVIEW
FAIL → Task remains REVIEW

```

Do not mark `DONE`.

Do not automatically return the Task to `IN_PROGRESS`.

Do not automatically launch another Worker.

Those behaviors belong to later retry/diagnose stages.

---

# 14. Derived Verify-Ready State

Implement or prepare the derived concept:

```text
VERIFY_READY

```

A Task/Run is `VERIFY_READY` when:

- persisted Task status is `REVIEW`
- the associated Worker Result is valid
- no Worker policy violation exists
- all required deterministic Gates have a canonical Gate Report
- overall Gate result is `PASS`
- the Task requires Verifier evaluation

Do not persist `VERIFY_READY` into Task YAML.

If straightforward, add:

```bash
node tools/loop-runtime/loopctl.mjs verify-ready

```

Expected output example:

```text
TASK-001    RUN-...    REVIEW    GATES PASS

```

If none:

```text
No tasks ready for verifier.

```

This command must perform no LLM call.

---

# 15. Gate-Based Acceptance Criteria Mapping

The Gate Report must make it possible to determine which Acceptance Criteria were deterministically satisfied.

Example:

```yaml
- id: AC1
  verification:
    type: gate
    ref: test

```

If `test` is PASS, AC1's deterministic Gate condition is PASS.

If `test` is FAIL, ERROR, or TIMEOUT, AC1 is not satisfied.

Do not ask the future Verifier to reinterpret deterministic Gate results.

The future Verifier should receive these Gate facts directly.

If useful, the Gate Report may include a derived mapping such as:

```json
{
  "acceptance_criteria": [
    {
      "id": "AC1",
      "gate": "test",
      "status": "PASS"
    }
  ]
}

```

Keep this derived mapping deterministic.

---

# 16. Gate Execution Order

Use a deterministic execution order.

Prefer the order derived from the Task configuration.

For V0, execute Gates sequentially.

Do not implement parallel Gate execution yet.

Decide one explicit failure policy:

Preferred V0 behavior:

```text
run every required Gate

```

even if an earlier Gate fails, so the Runtime obtains a complete deterministic diagnostic report in one execution.

However, if there is a strong repository-specific reason to fail fast, document it clearly.

Do not dynamically ask an AI whether another Gate should run.

---

# 17. Gate Telemetry

Gate execution itself consumes zero LLM tokens.

Record deterministic Gate telemetry such as:

- total Gate duration
- per-Gate duration
- process exit codes
- stdout/stderr sizes
- timeout count
- pass/fail/error count

Do not make any additional AI call for telemetry.

Do not inject Gate telemetry into future Worker Context automatically.

Gate Results will later be passed to the Verifier because they are verification facts, not because they are telemetry.

Keep usage accounting conceptually separate:

```text
Worker usage
→ LLM token/cost telemetry

Gate usage
→ process/time telemetry, zero LLM tokens

```

---

# 18. CLI Commands

Add a Gate execution command.

Preferred canonical form:

```bash
node tools/loop-runtime/loopctl.mjs gate RUN-...

```

Keep the existing:

```bash
node tools/loop-runtime/loopctl.mjs gates

```

command for configured Gate inspection if it already exists.

If `verify-ready` is implemented, also support:

```bash
node tools/loop-runtime/loopctl.mjs verify-ready

```

Keep output concise.

Example successful execution:

```text
Run: RUN-...
Task: TASK-001

Required Gates:
  build
  test

[PASS] build    4.2s
[PASS] test     8.7s

Gate Result: PASS

Task remains REVIEW.
Ready for independent verification.

```

Example failure:

```text
[PASS] build    4.2s
[FAIL] test     6.1s

Gate Result: FAIL

Task remains REVIEW.
Verifier is not eligible.

```

Do not print full build/test logs by default.

Store them in Run artifacts.

---

# 19. No LLM Calls

This requirement is strict.

Gate execution must not invoke:

- Claude
- Codex
- OpenAI API
- Anthropic API
- any other LLM

Running:

```text
loopctl gate ...

```

must consume zero AI tokens.

Do not ask the Worker to interpret test output.

Do not ask an AI to determine whether a command succeeded.

Use deterministic process facts.

---

# 20. Worker Bash Permissions

The previous Worker implementation observed that Claude Code under `acceptEdits` may deny Bash commands.

Do not loosen Worker Bash permissions solely to implement Gates.

The architecture should remain:

```text
Worker
→ implementation work

Runtime Gate Runner
→ authoritative build/test/lint execution

```

If Worker Bash permissions require later refinement for implementation productivity, defer that to a separate policy decision.

Do not solve it by granting unrestricted shell access in this step.

---

# 21. Configuration Safety

Gate commands are Runtime-controlled configuration.

The Worker must not be able to rewrite Gate commands through Task output.

Do not accept a command string from:

- Worker Result
- Worker stdout
- Task narrative
- Acceptance Criterion description

Only execute commands resolved through Runtime-owned Gate configuration.

Continue preserving the Single Writer / control-plane boundary.

---

# 22. Failure Handling

Handle at least:

- Task is not in REVIEW
- Run does not exist
- Run belongs to another Task
- invalid Worker Result
- Worker policy violation exists
- no required Gates
- unknown Gate reference
- malformed Gate configuration
- executable/shell launch failure
- non-zero Gate exit
- Gate timeout
- Gate report already exists
- corrupted or missing Run metadata
- Gate result directory write failure

Make failures explicit.

Do not silently skip a required Gate.

Do not fabricate PASS.

---

# 23. No-Gate Tasks

Handle Tasks with zero deterministic Gates explicitly.

For example, a Task might have only:

```yaml
verification:
  type: verifier

```

criteria.

Do not invent a Gate.

For such a Task, the Gate phase may deterministically produce:

```text
Gate Result: PASS
Required Gates: 0

```

meaning:

> There were no deterministic Gates required, so nothing failed at this layer.

This may make the Task eligible for the future Verifier.

Represent this case explicitly in `gate-report.json`.

Do not confuse "no Gates required" with "Gate configuration missing".

---

# 24. Preserve Existing Usage Telemetry

Do not regress Worker telemetry added in Step 3.

Existing Worker usage should remain intact:

- context metrics
- stdout/stderr size
- provider token usage when available
- provider cost when available
- duration
- model
- changed-file observation

Gate telemetry must be additive and must not alter historical Worker token data.

Do not synthesize a combined cost yet.

Cross-stage aggregation belongs later.

---

# 25. Preserve Existing Runtime Behavior

Existing commands must continue working:

```text
tasks
show
ready
validate
transition
context
snapshot
gates
doctor
adapters
run
usage

```

Do not regress:

- Task schema validation
- Acceptance Criteria validation
- transition enforcement
- Snapshot hashing
- Worker Result validation
- Runtime Envelope
- protected `.loop` checks
- usage telemetry
- example Task protections

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

---

# 26. Explicitly Out of Scope

Do not implement:

- AI Verifier execution
- Task `DONE` automation
- Retry
- Failure Memo generation
- automatic `REVIEW -> IN_PROGRESS`
- Diagnose
- Replan
- Decompose
- automatic Worker relaunch
- Lease locking
- Git Worktree automation
- parallel Workers
- parallel Gates
- Budget enforcement
- Cost limits
- Risk Engine
- Independent Monitor
- Meta Loop
- Production deployment
- Database
- Web UI
- Queue daemon

Those belong to later steps.

---

# 27. Validation

Test the Gate layer with deterministic fixtures and zero LLM calls.

Test at least:

- valid Gate reference resolution
- unknown Gate reference rejection
- required Gate union/deduplication
- successful single Gate
- multiple Gates all PASS
- one Gate FAIL
- Gate process ERROR
- Gate timeout
- zero-Gate Task
- gate-based Acceptance Criterion PASS mapping
- gate-based Acceptance Criterion FAIL mapping
- Gate execution rejected for non-REVIEW Task
- invalid/missing Worker Run rejection
- Worker policy-violation Run rejection
- duplicate Gate execution protection
- Gate Report generation
- stdout/stderr artifact generation
- Gate telemetry
- `verify-ready` PASS case if implemented
- `verify-ready` rejection when Gates fail
- existing Worker usage telemetry remains unchanged

Use temporary fixtures where required.

Do not invoke Claude or Codex during deterministic Gate tests.

Remove temporary Tasks, test artifacts, Gate Reports, and fixture files afterward unless intentionally retained as documentation.

Ensure `TASK-EXAMPLE.yaml` returns to its original state after testing.

Verify `.loop/[DESIGN.md](http://DESIGN.md)` is byte-identical after completion.

---

# Final Report

When finished, report only:

- Runtime files created or modified
- Gate configuration shape used
- Gate resolution rules
- Gate CLI commands
- Gate eligibility rules
- Gate Report schema
- Gate Evidence/artifact layout
- Gate status model
- zero-Gate behavior
- `verify-ready` behavior if implemented
- Gate telemetry fields
- confirmation that Gate execution uses zero LLM calls
- validation/test results
- any limitations intentionally deferred to the Verifier/retry steps

Do not proceed to Verifier execution, automatic retry, or Task DONE automation.