# Loop Runtime V0 — Step 8 Goal Planner and Task Proposal Layer

The V0 Loop Runtime now supports a complete controlled execution loop for one already-defined Task:

```text
Task
→ Worker
→ Gate
→ Independent Verifier
→ Diagnose
→ Failure Memo
→ Retry
→ DONE or controlled stop

```

The operator can run:

```text
loopctl execute TASK-001

```

and the Runtime automatically continues until the Task reaches `DONE` or a deterministic stop condition.

The remaining manual responsibility is Task creation.

This step introduces the first **Goal Planner**.

The desired user experience becomes:

```text
Human Goal
↓
AI Planner
↓
Structured Task Proposal
↓
Runtime Validation
↓
Human Approval
↓
Runtime creates canonical Tasks

```

This step does **not** automatically execute the generated Tasks.

This step does **not** automatically approve an AI-generated plan.

This step does **not** implement multi-Task scheduling.

---

# 1. Core Goal

Implement a planning layer that allows the operator to provide a high-level Goal such as:

```text
Allow users to upload OBJ, STL, and GLB files,
convert them to PLY, and inspect the results in the browser.

```

The Planner should decompose that Goal into a bounded set of independently executable Tasks.

The Planner must propose:

- Task boundaries
- Task requests
- Acceptance Criteria
- verification methods
- required Runtime Gates
- execution role
- dependency relationships
- assumptions
- risks

The Planner does not directly create or edit Task YAML files.

The Runtime validates and materializes approved Tasks.

---

# 2. Existing Runtime Is Authoritative

Before making any changes, inspect the actual current implementation:

- `.loop/[KERNEL.md](http://KERNEL.md)`
- `.loop/project.yaml`
- `.loop/policies/limits.yaml`
- `.loop/tasks/`
- `.loop/skills/`
- `tools/loop-runtime/loopctl.mjs`
- `tools/loop-runtime/stages.mjs`
- `tools/loop-runtime/task-store.mjs`
- `tools/loop-runtime/transitions.mjs`
- `tools/loop-runtime/context-builder.mjs`
- `tools/loop-runtime/subject.mjs`
- `tools/loop-runtime/worker/`
- `tools/loop-runtime/gate/`
- `tools/loop-runtime/verifier/`
- `tools/loop-runtime/recovery/`
- `tools/loop-runtime/loop/`
- `tools/loop-runtime/adapters/`
- `tools/loop-runtime/[README.md](http://README.md)`
- project-root `loopctl`
- project-root `loopctl.cmd`

Also re-read only the relevant parts of `.loop/[DESIGN.md](http://DESIGN.md)` concerning:

- Runtime ownership
- Task model
- Stop Conditions
- Acceptance Criteria
- Project Adapter
- Human escalation
- Context management

Do not copy [DESIGN.md](http://DESIGN.md) into Planner context.

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

---

# 3. Planner Is Not a State Writer

This requirement is strict.

The Planner must never directly:

```text
write .loop/tasks/*.yaml
modify Task state
modify Acceptance Criteria of existing Tasks
modify project.yaml
modify policies
modify KERNEL
execute Tasks

```

The Planner returns only a structured proposal.

Conceptually:

```text
Planner
↓
plan-result.json

Runtime
↓
validate

Human
↓
approve

Runtime
↓
Task files

```

Maintain:

```text
Worker   ≠ State Writer
Verifier ≠ State Writer
Planner  ≠ State Writer

Runtime = State Writer

```

---

# 4. Human Approval Is Mandatory

Do not automatically materialize Planner output.

Creating a Plan and approving a Plan must be separate operations.

Desired flow:

```text
loopctl plan "<GOAL>"

```

produces a proposal.

Then:

```text
loopctl plan-show PLAN-...

```

allows inspection.

Then:

```text
loopctl plan-approve PLAN-...

```

materializes Tasks.

Without:

```text
plan-approve

```

no Task files are created.

Do not add implicit approval.

Do not add automatic execution after approval.

---

# 5. Planning Architecture

Introduce a small planning layer.

Prefer a structure similar to:

```text
tools/loop-runtime/
└─ planner/
   ├─ runner.mjs
   ├─ result.mjs
   ├─ context-builder.mjs
   ├─ validator.mjs
   ├─ approval.mjs
   └─ report.mjs

```

Slightly different filenames are acceptable if they fit the current Runtime better.

Reuse existing:

- adapter registry
- telemetry patterns
- subject fingerprinting
- Runtime configuration
- Task validation
- Gate resolution

Do not create a second Task validator.

Do not create a separate agent framework.

---

# 6. Planner Invocation

Use a fresh AI invocation for every Plan.

Do not reuse:

- Worker session
- Verifier session
- interactive Claude session
- previous Planner conversation

Use the actual installed provider CLI.

Claude Code is currently the functioning provider.

Use only CLI flags verified against the installed version.

Do not invent flags.

Prefer the same isolated scripted execution principles already used by Worker and Verifier.

Where supported and compatible, prevent implicit project/session context such as:

- prior chat history
- auto-memory
- unrelated skills
- interactive session state

from contaminating the Planner invocation.

Do not weaken existing Worker or Verifier isolation.

---

# 7. Planner Must Be Read-Only

The Planner is an architect/reviewer, not an implementation Worker.

It may inspect the repository.

Prefer allowing only read-only capabilities such as:

```text
Read
Grep
Glob

```

where supported by the actual provider CLI.

Do not allow:

```text
Edit
Write
NotebookEdit
destructive Bash
production operations

```

If limited read-only shell access is not already safely supported, do not add unrestricted Bash merely for Planner convenience.

The Runtime must independently verify that:

```text
repository subject before Planner
==
repository subject after Planner

```

and that Runtime-controlled `.loop/` files did not change.

Any Planner mutation is a policy violation.

---

# 8. Planner Input Isolation

Create a dedicated Planner Snapshot.

Do not reuse Worker or Verifier Context.

The Planner may receive:

```text
--- PLANNER CONTRACT ---

--- GOAL ---

--- PROJECT FACTS ---

--- AVAILABLE ROLES ---

--- AVAILABLE GATES ---

--- TASK CONTRACT ---

--- EXISTING TASK SUMMARY ---

--- PLANNING LIMITS ---

--- RUNTIME FACTS ---

```

Do not include:

- [DESIGN.md](http://DESIGN.md)
- previous Worker narratives
- Worker stdout
- Verifier narratives
- Failure Memo history
- previous AI chat sessions
- full Run history
- unrelated Gate logs
- execution transcripts

---

# 9. Goal Input

Add:

```text
loopctl plan "<goal>"

```

Example:

```text
loopctl plan "Add OBJ/STL/GLB to PLY conversion and a browser viewer."

```

Support a normal multi-word quoted Goal.

If straightforward, optionally support:

```text
loopctl plan --file goal.md

```

but this is not required.

Do not add an interactive wizard in this step.

---

# 10. Plan Identity

Every Planner invocation receives a Runtime-owned Plan ID.

Example:

```text
PLAN-20260826T...

```

The Planner must echo the supplied Plan ID in its structured Result.

The Planner must not invent the canonical Plan ID.

Provider session IDs are not Runtime Plan identities.

---

# 11. Repository Subject Binding

Bind every Plan to the repository state it was created against.

Use the existing deterministic subject-fingerprinting infrastructure where practical.

Store:

```text
planner subject before
planner subject after

```

The subject must not change during planning.

The Plan Report must contain the authoritative subject fingerprint.

Before approval:

```text
current subject
==
Plan subject

```

must hold.

If the repository changed after planning:

```text
Plan approval refused:
repository state changed since this plan was created.

Create a fresh plan.

```

Do not approve a stale Plan.

Do not add `--force`.

---

# 12. Planner Project Facts

Provide the Planner with bounded authoritative project facts.

Include useful information such as:

- project root
- configured project name
- available Runtime roles
- configured Gates
- which Gates are enabled
- current Task schema
- Acceptance Criteria verification schema
- existing active Task IDs/status/request summaries
- relevant Runtime limits

Do not provide every Run artifact.

Do not duplicate the entire repository into the prompt.

The Planner may use read-only repository tools to inspect relevant source files.

---

# 13. Existing Task Awareness

The Planner should receive a compact summary of existing non-example Tasks.

For example:

```text
TASK-001 | DONE | Add upload pipeline
TASK-002 | TODO | Add PLY viewer

```

Include only information needed to avoid duplicate planning.

Do not include:

- Worker histories
- Failure Memos
- Gate logs
- Verifier transcripts

The Planner must not modify existing Tasks.

---

# 14. Planner Result Contract

Define a structured Planner Result.

Prefer a shape conceptually similar to:

```json
{
  "plan_id": "PLAN-...",
  "result": "PROPOSED",

  "goal_summary": "Implement multi-format 3D conversion and inspection.",

  "assumptions": [
    "Conversion runs locally on the existing backend."
  ],

  "risks": [
    "Large binary assets may require later performance work."
  ],

  "tasks": [
    {
      "proposal_id": "P1",
      "title": "Implement OBJ to PLY conversion",

      "request": "Implement OBJ to PLY conversion using the existing conversion architecture.",

      "execution": {
        "role": "impl"
      },

      "depends_on": [],

      "stop_condition": {
        "gates": [],
        "requires_verifier": true,
        "max_consecutive_failures": 2
      },

      "acceptance_criteria": [
        {
          "id": "AC1",
          "description": "A valid OBJ file can be converted to PLY.",
          "verification": {
            "type": "verifier",
            "instruction": "Inspect the implementation and evidence for an explicit OBJ to PLY conversion path."
          }
        }
      ]
    }
  ],

  "human_questions": []
}

```

The exact field order is not important.

The contract is.

---

# 15. Planner Result States

Support only a small explicit result set.

Prefer:

```text
PROPOSED
NEEDS_HUMAN
REFUSED

```

## PROPOSED

A complete Task proposal exists.

## NEEDS_HUMAN

Planning cannot safely continue without a human decision.

Examples:

- architecture tradeoff
- unclear product behavior
- missing security decision
- production constraint
- impossible verification requirement

## REFUSED

The Goal cannot be represented safely within the Planner contract.

Do not use natural-language success/failure interpretation.

---

# 16. Human Questions

When:

```text
result: NEEDS_HUMAN

```

the Planner may return bounded:

```json
"human_questions": [
  "Should conversion run client-side or server-side?"
]

```

Do not create Tasks that silently assume a critical architecture/product decision when a human decision is required.

Do not implement interactive answer/resume planning in this step.

The user may rerun:

```text
loopctl plan "<revised goal including the answer>"

```

later.

---

# 17. Planner Task IDs Are Proposal IDs Only

The Planner must not assign final Task IDs.

It may only generate local proposal IDs:

```text
P1
P2
P3

```

Dependencies within the proposal reference these IDs.

Example:

```json
{
  "proposal_id": "P3",
  "depends_on": ["P1", "P2"]
}

```

At approval time, Runtime allocates canonical Task IDs.

Example:

```text
P1 → TASK-20260826-001
P2 → TASK-20260826-002
P3 → TASK-20260826-003

```

Use the repository's existing Task-ID convention if one already exists.

Do not trust AI-generated canonical IDs.

---

# 18. Minimal Task Dependency Support

A multi-Task Plan needs deterministic prerequisites.

If the current persisted Task schema does not already support dependencies, add exactly one minimal schema extension:

```yaml
depends_on: []

```

This is the only Task-schema expansion allowed in this step.

Rules:

- `depends_on` is an array of canonical Task IDs.
- duplicate dependencies are invalid.
- self-dependency is invalid.
- missing dependency Task is invalid.
- circular dependency graphs are invalid.

Do not introduce:

- arbitrary dependency expressions
- optional dependencies
- OR dependencies
- weighted dependencies
- dependency conditions

---

# 19. Planner Dependency Validation

Within Planner Results:

```text
depends_on

```

references proposal IDs.

Validate:

- referenced proposal exists
- no self-reference
- no duplicates
- no cycles
- all tasks are reachable as a valid DAG

Do not ask an LLM to detect cycles.

Use deterministic graph validation.

---

# 20. Materialized Dependencies

During approval:

```text
proposal IDs
↓
Runtime canonical Task IDs

```

must be resolved before writing files.

Example:

```text
P1 → TASK-001
P2 → TASK-002

```

Then:

```yaml
# TASK-002
depends_on:
  - TASK-001

```

Runtime owns the mapping.

Store the mapping in the Plan approval artifact.

---

# 21. READY Must Respect Dependencies

Update derived READY calculation if dependency support is added.

A Task is READY when:

```text
status == TODO
AND all depends_on Tasks are DONE
AND existing readiness conditions pass

```

Do not persist READY.

A Task whose prerequisite is not DONE remains:

```text
TODO

```

but is not derived READY.

Example:

```text
TASK-002
status: TODO
depends_on: [TASK-001]

TASK-001 status != DONE
→ TASK-002 is not READY

```

---

# 22. `run` and `execute` Must Respect Dependencies

Do not allow the operator to bypass dependency checks.

For example:

```text
loopctl execute TASK-002

```

must refuse if:

```text
TASK-001 != DONE

```

Example:

```text
TASK-002 is not ready.

Waiting on:
  TASK-001

```

Use the shared Runtime readiness logic.

Do not duplicate dependency checks in multiple CLI handlers.

---

# 23. Cross-Task Validation

Extend deterministic validation/doctor behavior where necessary.

Detect:

- missing dependency Task
- self-dependency
- dependency cycle

Do not make an LLM validate the Task graph.

If existing Tasks contain no dependency field, treat them as:

```yaml
depends_on: []

```

for backward compatibility.

Do not rewrite all existing Task files merely to add an empty field.

---

# 24. Planner Task Granularity

The Planner should produce Tasks that are:

- independently understandable
- independently executable
- small enough to be verified
- large enough to represent a meaningful change
- bounded to one coherent responsibility

Avoid one giant Task such as:

```text
Build the entire application.

```

Avoid excessive microtasks such as:

```text
Create one variable.
Rename one function.
Add one import.

```

The Planner should prefer the smallest set of Tasks that forms a clear executable plan.

---

# 25. Plan Size Limit

Add or use a deterministic maximum number of proposed Tasks.

Prefer a small configurable limit such as:

```yaml
planning:
  max_tasks_per_plan: 12

```

or another location consistent with the existing limit configuration.

Use existing configuration conventions.

Do not scatter limits.

If the Planner returns more than the configured maximum:

```text
Plan validation failed:
too many proposed Tasks.

```

Do not silently truncate the Plan.

Do not ask another AI to reduce it automatically.

---

# 26. Role Validation

Every:

```text
execution.role

```

must refer to an actual installed Role Skill.

For V0, this will likely be:

```text
impl

```

Do not allow the Planner to invent:

```text
backend_architect_v9
security_super_agent

```

unless corresponding Runtime role configuration actually exists.

Unknown roles invalidate the proposal.

---

# 27. Gate Validation

The Planner must receive authoritative available Gate information.

It must not invent Gate names.

Every:

```text
stop_condition.gates[]

```

and every:

```text
verification.type: gate
verification.ref

```

must resolve to configured Runtime Gates.

For newly approved executable Tasks, a required Gate must also be executable/enabled.

Do not approve a Plan that depends on a disabled Gate.

If no deterministic Gate currently exists for a criterion, the Planner may use:

```text
verification.type: verifier

```

when independent reasoning is genuinely appropriate.

Do not invent:

```text
ref: magical_test

```

just to make a criterion look deterministic.

---

# 28. Acceptance Criteria Validation

Every proposed Task must satisfy the existing Acceptance Criteria schema.

Reuse the existing Task validator.

Do not create a Planner-specific weakened validation path.

Each criterion must have:

```text
id
description
verification
verification.type

```

Gate criteria require valid Gate refs.

Verifier criteria use the existing Verifier contract.

Unknown fields/types are rejected.

---

# 29. Task Contract Must Be Complete Before Approval

A Task Proposal cannot rely on:

```text
"We will figure out the completion condition later."

```

Every approved Task must already have a valid Stop Condition and judgeable Acceptance Criteria.

If the Planner cannot produce them:

```text
NEEDS_HUMAN

```

is preferable to creating an unjudgeable Task.

---

# 30. Planner Cannot Modify Runtime Policy

Do not allow Planner output to contain or change:

- max global attempts
- Runtime budgets
- role permissions
- provider configuration
- Gate commands
- Runtime policies
- KERNEL
- project configuration

It may only propose Tasks within the existing Runtime contract.

---

# 31. Plan Artifacts

Store Planner artifacts separately from Runtime Tasks.

Prefer:

```text
.loop-local/plans/
└─ PLAN-.../
   ├─ context.md
   ├─ manifest.json
   ├─ planner-result.json
   ├─ planner-envelope.json
   └─ plan-report.json

```

After approval:

```text
approval.json

```

may also be stored.

Do not copy Planner conversation history into Task files.

---

# 32. Planner Envelope

Store Runtime-observed Planner facts separately from Planner claims.

Prefer:

```json
{
  "plan_id": "PLAN-...",
  "adapter": "claude",
  "model": "...",

  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 0,

  "process": {
    "exit_code": 0,
    "timed_out": false
  },

  "planner_result_valid": true,
  "planner_policy_violation": false,

  "usage": {}
}

```

Maintain:

```text
Planner claim
!=
Runtime observation

```

---

# 33. Planner Telemetry

Track Planner usage without another LLM call.

Record:

- context bytes/chars/lines
- duration
- stdout/stderr size where applicable
- adapter
- actual model if provider reports it
- provider token fields when available
- provider cost when available

Do not synthesize missing totals.

If unavailable:

```json
{
  "tokens": {
    "source": "unavailable"
  }
}

```

Planner usage remains separate from Worker and Verifier usage.

---

# 34. Structured Output

Do not parse conversational text as the Plan.

Use an actual structured-output mechanism supported by the installed provider.

If Claude's verified structured-output / JSON-schema mechanism is available, use it.

Otherwise use another deterministic provider-supported mechanism.

Do not scrape:

```text
"Here are the tasks I recommend..."

```

from stdout.

---

# 35. Planner Result Validation

Validate at least:

- correct Plan ID
- supported result value
- non-empty Goal summary where required
- task list present for PROPOSED
- empty/no executable Tasks for NEEDS_HUMAN where appropriate
- unique proposal IDs
- valid Task requests
- valid roles
- valid Stop Conditions
- valid Acceptance Criteria
- valid verification types
- valid Gate refs
- enabled required Gates
- valid dependency references
- no dependency cycles
- Plan size limit
- no forbidden Runtime-policy fields
- no canonical Task IDs supplied as authoritative state

Do not heuristically repair malformed Plans.

---

# 36. Runtime Plan Report

Create a Runtime-authored canonical Plan Report.

Example:

```json
{
  "schema": 1,
  "plan_id": "PLAN-...",
  "goal": "...",
  "subject_sha256": "...",

  "planner_result": "PROPOSED",
  "planner_result_valid": true,
  "policy_violation": false,

  "task_count": 4,

  "validation": {
    "valid": true,
    "errors": []
  },

  "approved": false
}

```

Do not treat the Planner's own declaration:

```text
"This is a valid plan."

```

as authoritative.

Runtime validation is authoritative.

---

# 37. `loopctl plan`

Add:

```text
loopctl plan "<GOAL>"

```

Expected output:

```text
Plan: PLAN-...
Planner: claude

Goal:
  Add OBJ/STL/GLB conversion and a viewer.

Planner Result:
  PROPOSED

Tasks: 4

P1  Add common conversion interface
P2  Add OBJ conversion
    depends on: P1
P3  Add STL conversion
    depends on: P1
P4  Add browser viewer
    depends on: P2, P3

Validation: PASS

Provider usage:
  ...

No Tasks have been created.

Review:
  loopctl plan-show PLAN-...

Approve:
  loopctl plan-approve PLAN-...

```

Do not create Tasks yet.

---

# 38. `loopctl plan-show`

Add:

```text
loopctl plan-show <PLAN-ID>

```

This command:

- performs zero LLM calls
- performs no Runtime mutation
- reads the canonical Plan artifacts
- displays Goal
- assumptions
- risks
- Task proposals
- dependencies
- Acceptance Criteria summary
- validation result
- approval status
- planning usage summary

Do not print enormous prompt/context files by default.

---

# 39. Optional `loopctl plans`

If straightforward, add:

```text
loopctl plans

```

showing recent Plans:

```text
PLAN-001  PROPOSED     4 tasks   not approved
PLAN-002  NEEDS_HUMAN  0 tasks
PLAN-003  PROPOSED     3 tasks   approved

```

Zero LLM calls.

If this meaningfully expands scope, defer it.

---

# 40. `loopctl plan-approve`

Add:

```text
loopctl plan-approve PLAN-...

```

This is the explicit human approval boundary.

Before writing any Task:

1. Load canonical Plan artifacts.
2. Verify Planner Result validity.
3. Verify no Planner policy violation.
4. Verify Plan is `PROPOSED`.
5. Recompute repository subject.
6. Ensure subject matches Plan subject.
7. Re-run deterministic Plan validation.
8. Allocate canonical Task IDs.
9. Resolve proposal dependencies to canonical IDs.
10. Validate the final materialized Task graph.
11. Only then write Tasks.

Approval performs zero LLM calls.

---

# 41. Canonical Task Allocation

Runtime assigns all Task IDs.

Use the repository's existing Task naming convention if one exists.

IDs must be:

- deterministic enough for operator use
- collision-safe
- unique

Do not let the Planner choose existing Task filenames.

Store the mapping:

```json
{
  "proposal_to_task": {
    "P1": "TASK-001",
    "P2": "TASK-002"
  }
}

```

inside:

```text
approval.json

```

---

# 42. Approved Task Initial State

New Tasks created from an approved Plan should start as:

```text
status: TODO

```

Dependencies determine derived readiness.

Do not create:

```text
status: BLOCKED

```

merely because a Task has an incomplete dependency.

A dependent Task remains:

```text
TODO

```

but is not READY until prerequisites are DONE.

---

# 43. No Auto Execution After Approval

After:

```text
loopctl plan-approve PLAN-...

```

stop.

Do not automatically call:

```text
loopctl execute ...

```

Do not automatically process the first READY Task.

Print something like:

```text
Plan approved.

Created Tasks:
  TASK-001
  TASK-002
  TASK-003

Ready:
  TASK-001

Next:
  loopctl execute TASK-001

```

The execution decision remains explicit.

---

# 44. Plan Approval Must Be Idempotent

Do not create duplicate Tasks if:

```text
loopctl plan-approve PLAN-...

```

is called twice.

If already approved:

```text
Plan already approved.

P1 → TASK-001
P2 → TASK-002

```

Return without creating new files.

---

# 45. Approval Write Safety

Pre-validate the complete Task set before writing any canonical Task file.

Use temporary files + rename where practical.

Do not silently leave the Plan reported as fully approved if only part of the Task set was written.

Do not implement a full Operation Journal in this step.

If a partial filesystem failure occurs and safe rollback cannot be proven:

```text
RECOVERY_AMBIGUOUS

```

and report the exact affected files.

Do not fabricate successful approval.

---

# 46. Stale Plan Handling

A Plan is bound to the repository subject from planning time.

If:

```text
current subject != plan subject

```

then:

```text
loopctl plan-approve

```

must refuse.

Example:

```text
Plan approval refused.

Reason:
repository state changed since PLAN-... was created.

Create a fresh plan against the current project state.

```

Do not automatically re-run the Planner.

Do not add `--force`.

---

# 47. Planner Mutation Handling

If the Planner modifies:

```text
source files
.loop/
Runtime files

```

during planning:

```text
planner_policy_violation: true

```

The Plan is invalid.

Do not approve it.

Do not automatically revert the mutation.

Automatic recovery/rollback is still outside scope.

Report the changed paths clearly.

---

# 48. Goal Ambiguity

Do not require the Planner to ask a human about every small ambiguity.

The Planner may make bounded implementation assumptions where they do not change core product or architecture meaning.

Those assumptions must be listed in:

```text
assumptions[]

```

However, use:

```text
NEEDS_HUMAN

```

for genuinely blocking decisions such as:

- client vs server security boundary
- destructive migration
- irreversible architecture choice
- production policy
- legal/security requirement
- materially different product behaviors

---

# 49. No Planner Self-Approval

The Planner Result must not contain:

```text
approved: true

```

as an authoritative instruction.

Even if such a field appears unexpectedly, Runtime validation rejects it as an unknown/forbidden field.

Only:

```text
loopctl plan-approve

```

creates approval.

---

# 50. No Planner Execution

The Planner must not:

```text
call Worker
call Gate
call Verifier
call execute

```

Planning is proposal generation only.

Do not let Planner use Runtime CLI commands that mutate execution state.

---

# 51. No Automatic Goal Loop

Do not implement:

```text
Goal
→ Plan
→ Approve
→ Execute every Task

```

automatically.

This step ends at approved Task creation.

Multi-Task execution belongs to a later stage.

---

# 52. No Replan Execution

Step 6/7 may produce:

```text
REPLAN_REQUIRED

```

Do not automatically route those failures to this Planner yet.

This Planner handles new high-level Goals only.

Automatic Replan is intentionally deferred.

---

# 53. No Multi-Task Scheduler

Even though Plans now contain dependencies, do not add:

```text
loopctl execute-plan
loopctl execute-all
queue
scheduler

```

The operator still runs one Task at a time.

Dependency-aware READY exists only to make the Plan safe.

---

# 54. No Parallelism

Do not execute or plan concurrent Workers.

No:

- parallel Task execution
- Worktree creation
- leases
- scheduling
- daemon

The project still has one shared working tree.

---

# 55. Plan Ordering

For display purposes, provide a deterministic topological ordering of proposed Tasks.

Example:

```text
P1
├─ P2
├─ P3
└─ P4 after P2/P3

```

Do not rely on the Planner's array order as the sole dependency truth.

Use deterministic graph ordering.

If multiple valid ordering choices exist, use proposal order as a stable tie-breaker.

---

# 56. Task Approval and Existing Tasks

Do not overwrite existing Tasks.

Canonical ID allocation must avoid collisions.

The Planner's proposal should not be allowed to mutate or replace an existing Task because its title/request looks similar.

Existing Tasks are Runtime state.

If the Planner appears to duplicate an existing unfinished Task, validation may warn the operator, but do not automatically merge Tasks.

---

# 57. Plan Warnings

Runtime validation may produce non-fatal warnings such as:

```text
Possible overlap with existing TASK-004.

```

Warnings do not automatically invalidate a Plan.

However, do not use an LLM for overlap detection in V0.

Only produce deterministic warnings where supportable.

If deterministic overlap detection is not useful, defer it.

---

# 58. Planner Timeout

Add/use a Planner timeout consistent with current Runtime configuration.

For example:

```yaml
runtime:
  planner_timeout_seconds: 600

```

Do not create complex cancellation policy.

On timeout:

- preserve Planner artifacts
- do not create Tasks
- record timeout
- report failure

Do not retry automatically.

---

# 59. Planner Model Override

If consistent with existing CLI conventions, support:

```text
loopctl plan "<GOAL>" --model <model>

```

Do not hard-code a model.

Record the actual provider-reported model.

Do not implement automatic model routing.

---

# 60. Planner Usage Does Not Enter Task Context

Planner telemetry and narrative must not later be injected into Worker Context.

Approved Worker Context remains:

```text
KERNEL
ROLE
TASK
ACCEPTANCE CRITERIA
FAILURE MEMO

```

Do not add:

```text
PLAN NARRATIVE
PLANNER REASONING
PLANNER TOKEN USAGE

```

to Worker snapshots.

---

# 61. Planner Narrative Does Not Enter Verifier Context

The Independent Verifier must never see Planner reasoning merely because the Task originated from a Plan.

Verifier Context remains unchanged.

The approved Task contract is authoritative.

Planner narrative is historical planning metadata only.

---

# 62. Approved Task Contract Is the Boundary

Once approved:

```text
Plan Proposal
↓
canonical Task

```

the Task becomes the execution contract.

Worker and Verifier do not need to know:

```text
why the Planner chose this decomposition

```

unless that information was explicitly encoded in:

```text
request
Acceptance Criteria

```

Keep planning history out of execution Context.

---

# 63. CLI Help

Add actual commands to help.

Example:

```text
Plan
  plan "<GOAL>"          Generate a read-only Task proposal
  plan-show <PLAN>       Inspect a Plan
  plan-approve <PLAN>    Materialize an approved Plan into Tasks
  plans                  List Plans, if implemented

```

Do not advertise future:

```text
execute-plan
auto-plan
replan

```

commands.

---

# 64. `status`

Do not overload the normal Task `status` command with full Plan details.

If straightforward, it may display a compact line such as:

```text
UNAPPROVED PLANS
  PLAN-001  4 tasks

```

but this is optional.

Keep Task operational status readable.

---

# 65. README

Add a concise Goal Planning section.

Example:

```text
Goal Planning

.\loopctl plan "Add OBJ/STL/GLB conversion and a browser viewer"

.\loopctl plan-show PLAN-...

.\loopctl plan-approve PLAN-...

.\loopctl ready

.\loopctl execute TASK-...

```

Clearly state:

```text
Planning does not create Tasks until explicit approval.
Approval does not execute Tasks.

```

Do not duplicate [DESIGN.md](http://DESIGN.md).

---

# 66. Backward Compatibility

Existing manually authored Tasks without:

```text
depends_on

```

must continue working.

Treat missing:

```text
depends_on

```

as:

```text
[]

```

Do not rewrite existing Task files automatically.

All existing:

```text
run
gate
verify
diagnose
retry
execute

```

behavior must remain unchanged for dependency-free Tasks.

---

# 67. No New Persisted Task States

Do not add:

```text
PLANNED
WAITING
DEPENDENCY_BLOCKED
APPROVED

```

as Task statuses.

Persisted Task states remain the existing set.

Dependency waiting is derived.

Plan approval status belongs to Plan artifacts, not Task status.

---

# 68. Planning Is One LLM Invocation

A normal:

```text
loopctl plan "<goal>"

```

should perform at most one intended Planner AI invocation.

Do not:

- call a second Planner to critique the first
- ask another model to validate the Plan
- use AI consensus
- ask Worker to review the Plan

Runtime Plan validation is deterministic.

---

# 69. Deterministic Approval Uses Zero LLM Calls

This is strict:

```text
loopctl plan-show
loopctl plan-approve
loopctl plans
dependency validation
cycle detection
Task ID allocation

```

must use zero LLM calls.

Only:

```text
loopctl plan

```

is an LLM stage.

---

# 70. Validation

Build strong deterministic Planner tests using the existing mock adapter pattern.

Do not spend real AI tokens on the failure matrix.

Test at least:

## Planner Result

- valid PROPOSED Plan
- valid NEEDS_HUMAN
- valid REFUSED
- malformed structured output
- wrong Plan ID
- unknown result type
- duplicate proposal ID
- missing Task request
- unknown role
- invalid Stop Condition
- invalid Acceptance Criteria
- unknown verification type
- unknown Gate ref
- disabled required Gate
- too many Tasks
- forbidden Runtime-policy field

## Dependencies

- no dependencies
- valid linear dependency
- valid branching dependency
- duplicate dependency
- missing proposal reference
- self dependency
- direct cycle
- multi-node cycle
- deterministic topological order

## Planner Isolation

- Planner cannot modify source
- Planner cannot modify `.loop`
- subject unchanged
- no prior Worker narrative
- no Failure Memo
- no Verifier narrative
- no [DESIGN.md](http://DESIGN.md)
- no session history in Planner Snapshot

## Approval

- valid Plan approval
- canonical Task IDs allocated by Runtime
- proposal IDs correctly mapped
- dependencies rewritten to canonical IDs
- every Task passes existing validator
- stale Plan refused
- invalid Plan refused
- NEEDS_HUMAN cannot be approved
- policy-violation Plan cannot be approved
- second approval is idempotent
- existing Task collision avoided
- no partial approval reported as success

## Dependency-Aware Runtime

- dependency-free old Task remains READY
- TODO Task waiting on dependency is not READY
- dependency becomes READY after prerequisite DONE
- `run` refuses unmet dependency
- `execute` refuses unmet dependency
- missing persisted dependency detected
- persisted Task cycle detected by doctor/validation
- existing Runtime execution remains unchanged for old Tasks

## Telemetry

- Planner usage captured
- exact provider tokens captured when available
- unavailable provider usage represented correctly
- Planner cost stored separately
- no telemetry enters Worker Context
- no Planner narrative enters Verifier Context

## Paid Call Safety

- plan-show = zero LLM calls
- plan-approve = zero LLM calls
- dependency validation = zero LLM calls
- no Planner retry automatically
- no Worker invocation during plan
- no Task execution during approval

## Regression

All previous deterministic suites must remain green:

- loop
- recovery
- verifier
- gate
- CLI
- Task validation
- Worker
- telemetry
- subject fingerprinting
- wrappers

Do not use a real provider for deterministic failure cases.

After deterministic tests pass, perform at most one small controlled live Planner invocation if useful.

The live test should verify:

```text
Goal
→ structured Plan
→ Runtime validation
→ no Task written before approval

```

If approval is also tested live, use temporary Tasks and remove them afterward.

Verify:

- `.loop/[DESIGN.md](http://DESIGN.md)` remains byte-identical
- `TASK-EXAMPLE.yaml` remains unchanged
- no fixture Tasks/Plans remain
- no product code was modified by Planner

---

# 71. Final Report

When finished, report only:

- Runtime files created or modified
- Planner architecture
- Planner provider/adapter
- actual Planner CLI integration method
- Planner Snapshot contents
- explicit excluded context
- Planner Result schema
- Plan validation rules
- dependency model
- dependency-aware READY behavior
- Plan artifact layout
- Plan subject-binding behavior
- approval flow
- Task-ID allocation/mapping
- new CLI commands
- Planner telemetry
- confirmation that only `plan` invokes an LLM
- deterministic test results
- controlled live test result if performed
- anything intentionally deferred beyond Step 8

Do not proceed to:

- automatic Plan execution
- multi-Task scheduling
- Planner-driven execution
- automatic Replan
- Task decomposition during failure recovery
- Worktrees
- Leases
- queues
- daemon mode
- parallel Workers
- background execution
- budget enforcement
- model routing
- provider fallback
- Monitor / Meta Loop

The Goal Planner must end at:

```text
Goal
→ Task Proposal
→ Runtime Validation
→ Human Approval
→ Canonical Tasks

```

and no further.