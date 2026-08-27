# Local Project Instructions

This file defines how the interactive Claude session should operate inside projects that use the Loop Runtime.

It is a local operator guide.

It must not replace the Product Spec, Phase Goal, Runtime Task contract, Gate, or Verifier.

---

# Product Source of Truth

The project specification is:

`docs/PRODUCT-SPEC.md`

Treat that document as the product direction and scope reference.

Do not silently broaden the product beyond the specification.

Do not attempt to implement the entire future product scope at once.

Development proceeds incrementally through the Phase Goals stored under:

`phase-prompt/`

Follow the currently approved Phase Goal.

If the Product Spec and a Phase Goal appear inconsistent in a way that affects implementation, stop and surface the conflict instead of guessing.

---

# System Map

If `docs/SYSTEM-MAP.md` exists, treat it as the persistent high-level map of the project:
what the system is, what is actually implemented, how work flows through it, where the
external dependency boundary sits, and which detailed document to read next.

Before planning or executing a new Phase, read:

- `docs/SYSTEM-MAP.md`, if it exists
- the relevant architecture, Phase, sign-off, and field-note documents

Update `docs/SYSTEM-MAP.md` only when:

- a Phase reaches final DONE, or
- a meaningful architecture boundary changes.

Do not update it for every Task.

Never describe PLANNED, DEFERRED, or CANDIDATE functionality as implemented.

An installed dependency is not an implemented feature. A package in the manifest, a
successful preflight, or a sample that ran once is not `DONE`. Only integration into the
product path, with its validation passing, is `DONE`.

Do not let the System Map absorb detailed documentation. It is an index that links to the
detailed documents, not a replacement for them.

When updating it, do not overwrite history: a later Phase does not erase what earlier
Phases established, and Current / Planned / Deferred must stay distinguishable.

If `docs/SYSTEM-MAP.md` does not exist, do not invent one from assumption. It is created
from repository evidence during Bootstrap, or at the first Phase boundary that produces
real architecture. See `prompts/PROJECT-BOOTSTRAP.md`.

---

# Loop Runtime

Use the Loop Runtime for planned implementation work.

Primary commands:

- `.\loopctl status`
- `.\loopctl ready`
- `.\loopctl plan`
- `.\loopctl plan-show`
- `.\loopctl plan-approve`
- `.\loopctl execute-plan`
- `.\loopctl execute`
- `.\loopctl execution`
- `.\loopctl usage`
- `.\loopctl doctor`

`execute-plan` is the normal way to run an approved Plan. It calls the same
`execute` loop for one Task at a time, in Runtime READY order.

Do not act as the scheduler yourself. Picking Tasks one by one and calling
`execute` on each is the manual fallback, not the default: the Runtime already
owns READY evaluation, dependency order, and the stop conditions.

`self-check` exists for the Worker, not for this session. It runs configured
Gate commands for reference only and never decides completion.

Do not bypass Runtime-controlled behavior:

- Task state
- dependencies
- READY evaluation
- Gates
- Verifier
- recovery rules
- retry limits
- approval boundaries
- subject-integrity checks

Do not directly mark Tasks as DONE.

Do not modify `.loop/DESIGN.md`.

Runtime-launched Planner, Worker, and Verifier contexts are intentionally isolated from this interactive Claude session.

Do not inject this file, interactive conversation history, or unrelated project context into Runtime snapshots unless the Runtime itself explicitly includes them.

---

# Project Planning

New project planning should follow:

```text
Project idea / topic
↓
docs/PRODUCT-SPEC.md
↓
phase-prompt/01-*.md
↓
phase-prompt/02-*.md
↓
...
↓
phase-prompt/Goal.md
```

The Phase files are Goal-level inputs for the Runtime Planner.

Do not manually replace the Runtime Planner by turning Phase prompts into hardcoded Task lists unless explicitly asked.

---

# Phase Workflow

For each Phase:

1. Read the corresponding Goal file under `phase-prompt/`, and `docs/SYSTEM-MAP.md` if it exists.
2. Use the Goal file as the Goal for `loopctl plan`.
3. Run `plan-show`.
4. Stop before approval and let the user review the Plan.
5. After explicit approval, run `plan-approve`.
6. Inspect `loopctl ready`.
7. Run `loopctl execute-plan <PLAN-ID>`.
8. Let the Runtime own everything inside that:
   - Task selection and READY order
   - Worker
   - Gate
   - Verifier
   - Diagnose
   - Failure Memo
   - Retry
9. After execution reaches a stable result, inspect:
   - execution result
   - attempts
   - usage
   - provider-reported cost metric
   - recovery events
10. Continue until all Tasks for the current Phase are DONE.
11. When the Phase reaches final DONE, update `docs/SYSTEM-MAP.md` if it exists and any of
    these actually changed: system flow, major components, external dependency boundary,
    validation model, known boundaries, decision history, or Phase status.
12. Do not begin the next Phase early.

Do not automatically approve a Plan unless the user explicitly asks.

Do not automatically execute a newly approved Plan unless the user explicitly asks to proceed.

If the user asks to continue the entire currently approved Phase, run
`loopctl execute-plan <PLAN-ID>`. It runs one Task at a time until:

- all Plan Tasks are DONE, or
- the Runtime reaches a stop that requires human judgment.

Re-running the same command after a human stop skips the Tasks that are already
DONE and continues from the remaining ones. It does not need a resume flag.

Do not execute Tasks concurrently while they share the same working tree.
The Runtime refuses it, and so should this session.

---

# Runtime Subject Integrity

Runtime subject integrity has priority over interactive convenience.

Do not modify project files while:

- `loopctl execute` or `loopctl execute-plan` is active
- a Gate is running
- a Verifier is running
- a Task is awaiting verification against an already-created Gate subject
- another Runtime operation depends on the current repository subject remaining unchanged

This includes modifications to:

- product source files
- tests
- documentation
- `CLAUDE.local.md`
- `docs/LOOP-RUNTIME-FIELD-NOTES.md`
- Phase prompts
- configuration
- unrelated repository files

Do not create, edit, delete, rename, format, or otherwise mutate repository files during these periods.

If a change is necessary, wait until the current Runtime operation reaches a stable point first.

Do not work around subject fingerprinting.

Do not automatically stash, reset, commit, discard, or hide changes merely to make Runtime continue.

If subject integrity becomes stale, preserve Runtime's fail-closed behavior and use the supported recovery path.

---

# Loop Runtime Field Observation

This project is also a real-world field test of the Loop Runtime.

After meaningful events such as:

- `loopctl plan`
- `loopctl plan-approve`
- `loopctl execute-plan`
- `loopctl execute`
- retry or recovery
- `NEEDS_HUMAN`
- `STALLED`
- ambiguous stop
- unexpectedly expensive execution
- false or suspicious PASS / FAIL
- unexpected subject-staleness
- repeated Worker capability limitations
- repeated manual recovery friction

review the Runtime outcome for meaningful observations.

If the result reveals a:

- Runtime limitation
- Planner limitation
- workflow friction point
- weak Acceptance Criterion
- false PASS / FAIL
- unnecessary retry
- unexpectedly high provider-reported cost
- context problem
- missing capability
- avoidable human intervention
- shared-working-tree problem
- misleading CLI / status representation

record it in:

`docs/LOOP-RUNTIME-FIELD-NOTES.md`

Do not wait for the user to explicitly request the note.

However, observation recording must never interfere with Runtime subject integrity.

Do not modify project files while a Loop Runtime execution, Gate, or Verifier is active, or while a Task is awaiting verification.

If an observation is discovered during an active or incomplete execution, defer writing it until the Runtime reaches a stable point for that operation.

Runtime subject integrity takes precedence over immediate note-taking.

If necessary, retain the observation temporarily in the interactive conversation and write it after the Runtime operation is safely complete.

---

# Field Note Quality

Do not record every product bug as a Runtime issue.

Product problems include:

- incorrect domain logic
- broken UI
- failed product operation
- parser or classifier bugs
- integration bugs
- missing product behavior

These belong to normal Tasks, Gates, Verifier, Diagnose, and Retry.

Runtime / Planner observations include cases such as:

- Planner Acceptance Criteria allow a required verification to be deferred
- Worker repeatedly lacks a capability required for efficient self-checking
- Runtime subject becomes stale because unrelated interactive files changed
- Task decomposition causes disproportionate cost without useful isolation
- Verifier repeatedly consumes excessive context or time
- manual recovery leaves stale execution-report presentation
- valid recovery requires unnecessary human intervention
- context appears to grow unnecessarily across Tasks

Only this second category belongs in `docs/LOOP-RUNTIME-FIELD-NOTES.md`.

---

# Field-Test Principle

Do not optimize or extend the Loop Runtime based only on speculation.

Prefer:

```text
Observation
→ repeated evidence
→ candidate improvement
→ Runtime V1 decision
```

over:

```text
Idea
→ immediate Runtime modification
```

Do not interrupt product development to redesign the Runtime unless the Runtime is genuinely preventing safe progress.

Record evidence first.

Do not modify Runtime source code merely because an improvement idea was discovered.

---

# Field Note Evidence

When available, record:

- Date
- Phase / Goal
- Plan ID
- Task ID
- Run ID
- Execution ID
- Runtime stage
- command executed
- actual behavior
- expected behavior
- current workaround
- impact
- possible improvement
- artifact paths
- attempt count
- Worker invocation count
- Verifier invocation count
- provider-reported cost metric
- recovery / failure classification
- status

Do not claim a root cause unless the evidence supports it.

Clearly distinguish:

- observed fact
- likely explanation
- unverified hypothesis

---

# External Libraries, APIs, CLIs, and Services

When implementation depends on external libraries, APIs, CLIs, services, formats, or provider capabilities:

- do not guess
- do not fabricate support
- verify actual current capabilities where required
- prefer authoritative documentation when the Task requires authoritative verification
- distinguish `VERIFIED` from `UNVERIFIED`
- do not treat theoretical compatibility as proven implementation support

If a required external fact cannot be verified and that fact is necessary to satisfy the Task contract, do not pretend the requirement was completed.

Surface the limitation clearly.

---

# Bootstrap Rule

Bootstrap is for preparing the repository and Runtime integration.

Bootstrap may configure:

- project scaffold
- package / dependency manager
- TypeScript or language configuration
- build command
- lint command
- test command
- `.loop/project.yaml`
- real deterministic Gates
- Runtime doctor / regression checks

Bootstrap must not implement normal product features.

Do not front-load future dependencies that are not needed yet.

Do not create fake Gates.

Only configure Gates backed by real executable project commands.

---

# General Operating Rule

During an active Runtime operation:

```text
Observe
but do not mutate
```

After Runtime reaches a stable point:

```text
Inspect
→ record meaningful field observations
→ decide the next operator action
```

The Runtime owns execution policy.

The interactive Claude session acts as an operator, not as a bypass around the Runtime.
