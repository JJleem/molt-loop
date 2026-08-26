We are going to gradually introduce an **AI Worker-based Loop Engineering Runtime** into the current project.

The file `.loop/[DESIGN.md](http://DESIGN.md)` located at the project root is the source-of-truth architecture document for this system.

First, read `.loop/[DESIGN.md](http://DESIGN.md)` carefully and understand its design intent and core principles.

However, **do not attempt to implement the entire [DESIGN.md](http://DESIGN.md) in this task**.

The goal of this task is to establish only the **minimal V0 Runtime foundation** that can be safely extended later.

# Core Principles

The following principles must be preserved:

- `.loop/[DESIGN.md](http://DESIGN.md)` is the full architecture document intended for humans and Runtime development.
- Do not copy the entire contents of [DESIGN.md](http://DESIGN.md) into Worker prompts or into [`KERNEL.md`](http://KERNEL.md).
- Keep the common context loaded by every Worker as small as possible.
- Runtime State must be separated from AI Session Memory.
- Workers must never directly mutate Runtime State.
- A Worker's claim that "the task is complete" is not Evidence.
- Task completion must eventually be determined through deterministic Gates and an independent Verifier.
- Do not modify existing project code or behavior unless necessary for this task.
- Avoid unnecessary abstractions, frameworks, or architecture in this initial step.

# 1. Inspect the Current Project First

Before creating anything, inspect the current repository in read-only mode.

Determine the following:

- Primary programming language(s)
- Package manager
- Build command
- Lint command
- Test command
- Current directory structure
- Whether Git is being used
- Existing development workflow

Use the existing project stack when deciding how the Runtime should eventually be implemented.

Prefer using the language and runtime already present in the repository whenever practical.

Do not introduce a new language or runtime unless there is a strong technical reason.

# 2. Create the Initial Loop Directory Structure

Create the following structure:

```text
.loop/
├─ DESIGN.md
├─ KERNEL.md
├─ project.yaml
├─ tasks/
├─ skills/
│  ├─ impl.md
│  └─ verifier.md
├─ policies/
└─ evidence/

.loop-local/
├─ runs/
├─ leases/
├─ staging/
└─ .gitkeep

```

If necessary, minimally update `.gitignore` so that runtime-generated contents inside `.loop-local/` are ignored.

If the `.loop-local/` directory itself must remain present in Git, use `.gitkeep` or an equivalent mechanism.

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

# 3. Create [`KERNEL.md`](http://KERNEL.md)

[`KERNEL.md`](http://KERNEL.md) must **not** be a summary of [DESIGN.md](http://DESIGN.md).

It must contain only the minimal invariant rules that every Worker needs to know on every Run.

Keep it intentionally small.

Include only the following concepts:

- A Worker is an ephemeral execution unit.
- Runtime is the only owner and writer of Runtime State.
- Workers must never directly change Task state.
- Workers must operate only within the assigned Task scope.
- A Worker's success claim is not Evidence.
- Examples of valid Evidence.
- Forbidden actions.
- Workers must return a structured Worker Result.
- `requested_transition` is only a request and does not mutate Task state.

Do not include:

- Long explanations from [DESIGN.md](http://DESIGN.md)
- Incident history
- Full Runtime topology
- Detailed Runtime implementation explanations
- Project-wide background that is not required for every Worker

Target approximately **100 lines or fewer**.

The KERNEL should remain small because it will eventually become fixed context included in every Worker Run.

# 4. Create `skills/[impl.md](http://impl.md)`

Define only the responsibilities of an Implementation Worker.

Allowed responsibilities:

- Inspect code relevant to the assigned Task
- Implement the Task
- Modify implementation files within Task scope
- Add or modify tests when necessary
- Run relevant development commands
- Produce Evidence

Forbidden actions:

- Marking a Task as `DONE`
- Modifying Acceptance Criteria
- Modifying Runtime Policies
- Modifying unrelated Tasks
- Performing Production operations

Keep this role definition concise.

Do not duplicate the entire KERNEL.

# 5. Create `skills/[verifier.md](http://verifier.md)`

Define the minimal rules for an independent Verifier.

The Verifier must not trust:

- Worker self-evaluation
- Worker completion claims
- Worker progress narrative

The Verifier should eventually receive only:

- Task
- Acceptance Criteria
- Canonical Diff
- Gate Results
- Evidence
- Runtime Facts

The Verifier output must support at least the following structured format:

```json
{
  "result": "PASS | FAIL",
  "failed_criteria": [],
  "reason": ""
}

```

The Verifier should determine whether the actual artifacts satisfy the Acceptance Criteria.

Keep this role definition concise.

# 6. Create `project.yaml`

Inspect the repository and create a minimal project configuration based on actual commands that exist in the project.

Use a structure similar to:

```yaml
project:
  name: ...

runtime:
  max_parallel_workers: 1

gates:
  build:
    command: ...
  lint:
    command: ...
  test:
    command: ...

limits:
  max_attempts: 3
  max_consecutive_failures: 2

```

Do not invent commands that do not exist in the repository.

For example, if the project does not currently have a test command:

- explicitly represent that the test Gate is unavailable or disabled, or
- omit it in a clear and intentional way.

Do not create a fake test command simply to satisfy the schema.

# 7. Create an Example Task Schema

Do not implement any real product feature yet.

Create only one example Task file to validate the initial Task structure.

For example:

```text
.loop/tasks/TASK-EXAMPLE.yaml

```

The example Task must be clearly marked so that it cannot accidentally be treated as an executable production Task.

The Task must contain at least:

```yaml
id:
status:
request:

execution:
  role:

stop_condition:
  gates:
  requires_verifier:
  max_consecutive_failures:

acceptance_criteria: []

evidence: []

failure_memo: []

```

For V0, use only the following Task states:

```text
TODO
IN_PROGRESS
REVIEW
DONE
BLOCKED
DROPPED

```

Do not introduce additional Task states in this phase.

# 8. Features Explicitly Out of Scope

Do **not** implement the following in this task:

- Parallel Workers
- Actual Lease locking
- Automatic Git Worktree management
- Operation Journal
- Dead Letter Queue
- Budget Ledger
- Risk Engine
- Independent Monitor
- Meta Loop
- Production deployment automation
- Complex Recovery Engine
- Web UI
- Database-backed Runtime State
- External Queue systems
- Long-running daemon processes

These features may be introduced only after the minimal V0 Loop works correctly.

# 9. Runtime Code

Do not implement the complete Runtime yet.

However, inspect the current repository and decide where future Runtime code should naturally live.

Examples:

```text
tools/loop-runtime/

```

or:

```text
scripts/loop/

```

Choose the location that best matches the existing repository conventions.

If useful, you may create a minimal directory or entry-point skeleton.

However, do **not** implement the full:

```text
Worker
→ Gate
→ Verifier
→ Retry

```

automation in this task.

The purpose of this task is to convert the architecture document into a **small, executable project configuration foundation**, not to build the entire Runtime.

# 10. Validation

After making the changes, verify the following:

1. The existing project build has not been broken by these changes.
2. `.loop/[DESIGN.md](http://DESIGN.md)` has not been modified.
3. [`KERNEL.md`](http://KERNEL.md) has remained intentionally small.
4. Commands defined in `project.yaml` actually match the repository.
5. `impl` and `verifier` responsibilities are clearly separated.
6. The principle that Runtime is the only State Writer has been preserved.
7. No out-of-scope Runtime features were implemented.

# 11. Working Method

Follow this order:

1. Read the repository.
2. Read `.loop/[DESIGN.md](http://DESIGN.md)`.
3. Understand the existing project structure and development commands.
4. Create only the minimal V0 foundation described above.
5. Validate the changes against the existing project.

Do not blindly implement every idea from [DESIGN.md](http://DESIGN.md).

Strictly respect the V0 scope.

Avoid modifying application source code unless absolutely necessary for this setup.

If something can be reasonably determined by inspecting the repository, make the decision yourself instead of asking unnecessary questions.

# 12. Final Report

When finished, report only the following:

- Files created
- Files modified
- Detected build command
- Detected lint command
- Detected test command
- Approximate size of [`KERNEL.md`](http://KERNEL.md)
- Recommended location for future Runtime implementation
- The next V0 Runtime components that should be implemented

Keep the final report concise.