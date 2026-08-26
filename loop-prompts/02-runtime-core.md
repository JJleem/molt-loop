The V0 Loop Engineering foundation has now been created.

Before making any changes, inspect the files created in the previous step:

- .loop/[KERNEL.md](http://KERNEL.md)

- .loop/project.yaml

- .loop/policies/limits.yaml

- .loop/tasks/TASK-EXAMPLE.yaml

- .loop/skills/[impl.md](http://impl.md)

- .loop/skills/[verifier.md](http://verifier.md)

- tools/loop-runtime/loopctl.mjs

- tools/loop-runtime/[README.md](http://README.md)

- .gitignore

Also re-read only the relevant parts of `.loop/[DESIGN.md](http://DESIGN.md)` concerning:

- Task state model

- Loop Runtime

- Single Writer

- Context management

- minimum implementation

Do not re-copy [DESIGN.md](http://DESIGN.md) into runtime prompts or source files.

# Goal of This Step

Implement the first executable V0 Runtime core.

This step is ONLY responsible for:

1. Task loading

2. Task validation

3. Task state transitions

4. Ready-task discovery

5. Minimal Runtime-controlled state mutation

6. Context snapshot construction

Do NOT implement AI Worker execution yet.

Do NOT call Codex, Claude, OpenAI APIs, or any external LLM.

Do NOT implement Gate execution or Verifier execution yet.

---

# 1. Preserve the Single Writer Principle

Runtime must be the only component allowed to mutate Task state.

Workers, future Verifiers, or role prompts must never directly edit Task YAML files.

All Task state changes must go through Runtime code.

For V0, support only:

TODO

IN_PROGRESS

REVIEW

DONE

BLOCKED

DROPPED

Define explicit valid transitions.

At minimum:

TODO -&gt; IN_PROGRESS

TODO -&gt; BLOCKED

TODO -&gt; DROPPED

IN_PROGRESS -&gt; REVIEW

IN_PROGRESS -&gt; BLOCKED

IN_PROGRESS -&gt; TODO

REVIEW -&gt; DONE

REVIEW -&gt; IN_PROGRESS

REVIEW -&gt; BLOCKED

BLOCKED -&gt; TODO

BLOCKED -&gt; DROPPED

Do not allow arbitrary transitions.

An invalid transition must fail without modifying the Task file.

---

# 2. Task Loader

Implement a Task loader that reads Task YAML files from:

.loop/tasks/

The loader must:

- ignore non-YAML files

- detect malformed YAML

- validate required fields

- validate status

- validate execution.role

- validate stop_condition

- validate acceptance_criteria

- validate evidence

- validate failure_memo

Do not silently repair malformed Task files.

Return clear validation errors instead.

The example Task must not accidentally appear as an executable ready Task.

---

# 3. Task Validation

Create an explicit validator.

Do not rely only on optional chaining or runtime assumptions.

For V0, validation may be implemented directly in JavaScript if that matches the current repository.

Do not add a large schema framework unless the repository already uses one or there is a compelling reason.

Validation failures must be deterministic and human-readable.

Example:

TASK-001: invalid status "READY"

TASK-002: stop_condition.gates must be an array

---

# 4. Ready Task Discovery

Implement Runtime logic for determining which Tasks are currently ready.

For V0:

A Task is READY when:

- status == TODO

- it is not the example Task

- it is structurally valid

- it is not explicitly blocked by configuration

Do not introduce READY as a persisted Task status.

READY is derived Runtime state only.

Add a command:

node tools/loop-runtime/loopctl.mjs ready

Example output:

TASK-001    TODO    Implement OBJ to PLY conversion

If no Task is ready:

No ready tasks.

---

# 5. Runtime-Controlled Transition Command

Add a command similar to:

node tools/loop-runtime/loopctl.mjs transition TASK-001 IN_PROGRESS

The command must:

1. Load the Task

2. Validate it

3. Check whether the requested transition is allowed

4. Mutate the Task only if valid

5. Write the updated Task atomically where practical

6. Report the transition

Example:

TASK-001: TODO -&gt; IN_PROGRESS

Invalid example:

Transition denied: DONE -&gt; IN_PROGRESS

Do not allow callers to bypass transition validation.

---

# 6. Basic Task Inspection Commands

Support:

node tools/loop-runtime/loopctl.mjs tasks

and:

node tools/loop-runtime/loopctl.mjs show TASK-001

`tasks` should display a compact list of Task IDs and persisted states.

`show` should display the normalized Task information.

Keep output simple and CLI-friendly.

Do not build a UI.

---

# 7. Context Builder

Implement a minimal Context Builder for a future Worker Run.

It must construct Worker context from:

1. .loop/[KERNEL.md](http://KERNEL.md)

2. the Role Skill referenced by execution.role

3. the assigned Task

4. Acceptance Criteria

5. Failure Memo

It must NOT include:

- [DESIGN.md](http://DESIGN.md)

- unrelated Tasks

- unrelated Evidence

- previous chat/session history

- Runtime implementation source

- full repository contents

Add a command such as:

node tools/loop-runtime/loopctl.mjs context TASK-001

For now, this command may print the generated context to stdout.

Do not launch any AI Worker.

The generated context should use clear section boundaries such as:

--- KERNEL ---

--- ROLE ---

--- TASK ---

--- ACCEPTANCE CRITERIA ---

--- FAILURE MEMO ---

Avoid duplicating Task content unnecessarily.

---

# 8. Snapshot Preparation

Prepare the Context Builder so that later it can write immutable Run snapshots under:

.loop-local/runs/

For this step, implement a command such as:

node tools/loop-runtime/loopctl.mjs snapshot TASK-001

It should create a run directory such as:

.loop-local/runs/RUN-&lt;timestamp&gt;-TASK-001/

containing at minimum:

[context.md](http://context.md)

manifest.json

The manifest should contain only deterministic Runtime facts currently available, such as:

- run_id

- task_id

- role

- created_at

- context file

- relevant source paths

If straightforward using built-in Node APIs, include a SHA-256 hash of [context.md](http://context.md).

Do not add external packages solely for hashing.

Do not execute an AI Worker from this snapshot yet.

---

# 9. Keep Runtime Implementation Small

The implementation should remain understandable.

Prefer a small structure such as:

tools/loop-runtime/

├─ loopctl.mjs

├─ task-store.mjs

├─ transitions.mjs

├─ context-builder.mjs

└─ [README.md](http://README.md)

You may choose slightly different filenames if they better fit the existing implementation.

Do not create unnecessary class hierarchies or abstraction layers.

---

# 10. Explicitly Out of Scope

Do not implement:

- Worker process execution

- Codex invocation

- Claude invocation

- OpenAI API invocation

- Gate execution

- Verifier execution

- Retry loops

- Failure diagnosis

- Lease locking

- Git Worktrees

- Parallel execution

- Budget management

- Risk engine

- Monitor

- daemon

- database

- web interface

Those belong to later steps.

---

# 11. Validation

After implementation, test at least:

- loading the example Task

- listing Tasks

- ready discovery

- invalid Task detection

- valid transition

- invalid transition rejection

- context generation

- snapshot generation

Do not leave the example Task in a changed state after testing.

Ensure `.loop/[DESIGN.md](http://DESIGN.md)` remains unchanged.

Ensure the existing application build is not broken.

---

# Final Report

Report only:

- Runtime files created or modified

- CLI commands now supported

- Task transition rules implemented

- Context inputs

- Example validation results

- Snapshot structure

- Anything intentionally deferred to the next step

Do not proceed to Worker execution automatically.