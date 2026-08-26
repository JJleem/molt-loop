The V0 Loop Runtime now implements the core execution pipeline through independent verification:

```text
Task
→ Worker
→ REVIEW
→ Deterministic Gates
→ VERIFY_READY
→ Independent Verifier
→ DONE or REVIEW

```

Before proceeding to automatic retry, diagnosis, Failure Memo generation, or full autonomous looping, perform a small **Step 5.5 Operator CLI cleanup**.

This step is intentionally about **usability only**.

Do not change the Runtime execution architecture.

Do not implement Step 6 behavior.

# Goal

Make the existing Runtime easy to operate from the project root through a simple `loopctl` entry point.

The user should not need to repeatedly type:

```text
node tools/loop-runtime/loopctl.mjs ...

```

The desired operator experience is approximately:

```text
loopctl doctor
loopctl status
loopctl tasks
loopctl ready
loopctl run TASK-001
loopctl gate TASK-001
loopctl verify TASK-001
loopctl usage RUN-...

```

On Windows, if PATH/global installation is not yet appropriate, this may initially be:

```text
.\loopctl doctor
.\loopctl status

```

Prefer the smallest reliable solution.

Do not turn this step into package publishing or installation framework work.

---

# 1. Inspect the Existing Runtime First

Before changing anything, inspect:

- the current `tools/loop-runtime/loopctl.mjs`
- all currently supported commands
- Step 3 Worker commands
- Step 4 Gate commands
- Step 5 Verifier commands
- `.loop/project.yaml`
- current Windows environment
- current Git repository structure

Do not assume a command exists merely because it was planned previously.

Use the actual implemented CLI behavior.

---

# 2. Preserve Runtime Semantics

This step must not change:

- Task state transition rules
- Worker execution semantics
- Gate semantics
- Verifier semantics
- DONE rules
- Context isolation
- Runtime Envelope
- Verification Report
- telemetry
- protected Runtime paths
- Gate Report
- Worker Result
- Verifier Result

CLI commands must remain thin interfaces to existing Runtime behavior.

Do not duplicate Runtime business logic inside wrappers.

---

# 3. Add a Project-Root `loopctl` Entry Point

The current development environment is Windows.

Provide a simple project-root entry point so the Runtime can be invoked without typing the full Node path.

Preferred minimal Windows solution:

```text
project-root/
├─ loopctl.cmd
├─ tools/
│  └─ loop-runtime/
│     └─ loopctl.mjs

```

Conceptually:

```bat
@echo off
node "%~dp0tools\loop-runtime\loopctl.mjs" %*

```

Inspect the actual project layout and implement the correct path.

Requirements:

- arguments must pass through unchanged
- exit codes must propagate correctly
- paths containing spaces must work
- Ctrl+C behavior must remain normal
- Worker/Gate/Verifier subprocess behavior must not change

Avoid a PowerShell-only wrapper because local PowerShell execution policies may block `.ps1` scripts.

A `.cmd` entry point is preferred for the current Windows environment.

If adding a small Unix-compatible wrapper is trivial and does not add maintenance burden, it may be added, but Windows support is the priority.

---

# 4. Do Not Publish or Globally Install Yet

Do not:

- publish an npm package
- require npm
- create a public package
- create a global installer
- modify system PATH automatically
- use administrator privileges
- add Homebrew/Chocolatey/Scoop packaging
- create an installation wizard

This Runtime is currently a local/private development tool.

Global installation or extraction into a reusable personal tool will happen only after the Runtime architecture is proven.

---

# 5. Add `loopctl help`

Provide a concise help command.

Support:

```text
loopctl help

```

and ideally:

```text
loopctl --help
loopctl -h

```

The help output should show the commands that actually exist.

Example style:

```text
Loop Runtime

Usage:
  loopctl <command> [arguments]

Inspect
  doctor
  status
  tasks
  show <TASK>
  ready
  verify-ready
  gates
  adapters

Execute
  run <TASK>
  gate <RUN|TASK>
  verify <RUN|TASK>

Inspect Runs
  usage <RUN>
  verification <RUN>

Other
  help

```

Only display commands that are actually implemented.

Do not advertise future Step 6 commands.

Keep help short and terminal-friendly.

---

# 6. Add `loopctl status`

Add one operator-oriented overview command:

```text
loopctl status

```

This command must be read-only.

It must perform zero LLM calls.

It should summarize the current Runtime state without requiring the user to call several commands individually.

Prefer sections such as:

```text
Loop Runtime

READY
  TASK-001

IN PROGRESS
  none

REVIEW
  TASK-002

VERIFY READY
  TASK-003

BLOCKED
  TASK-004

DONE
  TASK-005

```

Where possible, also show useful current Run information without producing noisy output.

For example:

```text
TASK-002  REVIEW
  latest run: RUN-...
  gates: FAIL

```

or:

```text
TASK-003  REVIEW
  latest run: RUN-...
  gates: PASS
  verifier: ready

```

Do not create new persisted states such as:

```text
VERIFY_READY
GATE_FAILED

```

`status` must derive these views from Runtime facts.

---

# 7. Keep `status` Cheap

`loopctl status` must not:

- launch a Worker
- launch a Verifier
- run Gates
- mutate Tasks
- rerun validation work that requires expensive subprocesses
- perform LLM calls

It may inspect:

- Task YAML
- Run manifests
- Runtime Envelopes
- Gate Reports
- Verification Reports

Use existing Runtime functions where practical.

Do not create duplicate state logic just for presentation.

---

# 8. Improve Task-ID Convenience

Where the Runtime already supports deterministic Task-to-Run resolution, make operator commands convenient.

Desired UX:

```text
loopctl run TASK-001
loopctl gate TASK-001
loopctl verify TASK-001

```

Run ID must remain the canonical underlying identity for Gate and Verifier artifacts.

When a Task ID is supplied and the Runtime resolves it to a Run, print the selected Run.

Example:

```text
Task: TASK-001
Resolved Run: RUN-20260826T...

```

Do not silently choose an ambiguous Run.

If deterministic resolution is impossible, refuse and require the Run ID.

Do not weaken existing eligibility rules merely for convenience.

---

# 9. Preserve Canonical Run Identity

Internally:

```text
gate
verify
usage
verification

```

must continue operating against canonical Run artifacts.

Task-ID input is only an operator convenience layer.

Do not duplicate Gate Reports or Verification Reports under Task IDs.

---

# 10. Friendly CLI Errors

Improve operator-facing errors where necessary.

For example:

Instead of:

```text
TypeError: Cannot read properties of undefined

```

prefer:

```text
Task not found: TASK-123

```

Instead of:

```text
EINVAL

```

prefer:

```text
TASK-001 is not ready for Worker execution.
Current state: REVIEW

```

Instead of a large stack trace for expected user mistakes:

```text
Verifier cannot run:
Gate result is FAIL.

```

Expected operator errors should be concise.

Unexpected internal bugs may still expose a stack trace in a debug mode or appropriate diagnostic path.

Do not hide real Runtime failures.

---

# 11. Exit Codes

Keep command exit behavior useful for scripting.

Prefer:

```text
0  successful command / requested check passed
1  command completed but requested operation failed or was denied
2  invalid CLI usage / malformed arguments

```

You may preserve existing semantics if changing them would cause regressions.

At minimum:

- successful `doctor` → 0
- successful Gate PASS → 0
- Gate FAIL → non-zero
- Verifier FAIL → non-zero
- invalid command → non-zero
- invalid Task → non-zero

Document the behavior briefly.

---

# 12. Optional `version`

If straightforward, add:

```text
loopctl version

```

The Runtime currently does not need semantic-release or package publishing.

A simple local Runtime version is enough, for example:

```text
Loop Runtime V0
Runtime schema: 1

```

Do not introduce package-management complexity solely for versioning.

If no meaningful version source currently exists, defer this command rather than inventing unnecessary infrastructure.

---

# 13. Optional Shell Convenience

If useful, allow:

```text
loopctl

```

with no arguments to print the same concise output as:

```text
loopctl help

```

Do not make bare `loopctl` start autonomous execution.

Execution must remain explicit.

---

# 14. Do Not Add `auto` or `execute` Yet

Do not implement:

```text
loopctl auto
loopctl start
loopctl execute
loopctl loop

```

yet.

Those commands imply Step 6/7 orchestration:

```text
Worker
→ Gate
→ Verifier
→ Diagnose
→ Retry
→ DONE

```

That logic does not belong in Step 5.5.

For now the operator still explicitly invokes:

```text
loopctl run
loopctl gate
loopctl verify

```

Step 6 will later compose these stages safely.

---

# 15. No New AI Calls

CLI convenience must not create additional LLM calls.

For example:

```text
loopctl status
loopctl help
loopctl tasks
loopctl ready
loopctl verify-ready

```

must consume zero AI tokens.

Existing:

```text
loopctl run

```

may invoke the Worker exactly as before.

Existing:

```text
loopctl verify

```

may invoke the Verifier exactly as before.

Do not add AI-generated summaries to CLI output.

---

# 16. Keep Telemetry Intact

Do not change existing Worker or Verifier usage data.

Preserve:

- provider token data
- provider cost if available
- context size
- output size
- duration
- model
- attempt number

Gate telemetry remains deterministic and zero-token.

`status` should not load or print detailed token data by default.

The existing `usage` command remains the detailed usage interface.

---

# 17. README Operator Quick Start

Add a short operator section to:

```text
tools/loop-runtime/README.md

```

Prefer something concise like:

```text
Quick Start

.\loopctl doctor
.\loopctl status
.\loopctl ready

.\loopctl run TASK-001
.\loopctl gate TASK-001
.\loopctl verify TASK-001

.\loopctl status

```

Do not turn the README into another [DESIGN.md](http://DESIGN.md).

Keep architecture explanation minimal.

---

# 18. Private / Local Tool Assumption

Treat the Runtime as a private local development tool.

Do not optimize this step for external users.

Do not add:

- onboarding wizard
- telemetry upload
- analytics service
- remote server
- cloud account
- public documentation
- package registry support
- user accounts

The goal is fast and reliable personal operation.

---

# 19. Optional Future Extraction Boundary

While implementing this cleanup, keep one future requirement in mind:

Eventually:

```text
tools/loop-runtime/

```

may be extracted into a reusable personal Runtime outside individual projects.

Therefore:

- avoid hard-coded absolute machine paths
- resolve the project root deterministically
- avoid project-name-specific branches
- keep project-specific configuration in `.loop/project.yaml`

Do not perform the extraction now.

Do not refactor large portions merely for hypothetical reuse.

---

# 20. Validation

Test without spending LLM tokens wherever possible.

Test at least:

- `loopctl.cmd` argument forwarding
- exit-code propagation
- project path containing spaces if practical
- no-argument help
- `help`
- `--help`
- unknown command
- `doctor`
- `tasks`
- `ready`
- `verify-ready`
- `status`
- `show <TASK>`
- Task-ID Gate resolution
- Task-ID Verify resolution if Step 5 supports it
- canonical Run-ID Gate invocation remains working
- canonical Run-ID Verify invocation remains working
- usage inspection remains working
- expected user errors do not produce unnecessary stack traces
- status performs no LLM call
- help performs no LLM call
- existing Worker behavior unchanged
- existing Gate behavior unchanged
- existing Verifier behavior unchanged

Use existing mock adapters where execution-path testing is required.

Do not invoke real Claude/Codex solely to test CLI wrappers.

Do not modify product functionality.

Remove temporary fixtures afterward.

Verify:

- `.loop/[DESIGN.md](http://DESIGN.md)` remains byte-identical
- `TASK-EXAMPLE.yaml` remains unchanged
- existing Runtime artifacts remain valid

---

# Final Desired UX

After this step, the user should be able to open a terminal at the project root and work approximately like:

```text
.\loopctl doctor
.\loopctl status

```

Then:

```text
.\loopctl run TASK-001

```

After Worker completion:

```text
.\loopctl gate TASK-001

```

After Gate PASS:

```text
.\loopctl verify TASK-001

```

Finally:

```text
.\loopctl status

```

The user should not need to know the internal path:

```text
tools/loop-runtime/loopctl.mjs

```

for normal operation.

---

# Explicitly Out of Scope

Do not implement:

- automatic Worker → Gate chaining
- automatic Gate → Verifier chaining
- automatic retries
- Failure Memo generation
- Diagnose
- Retry + Hint
- Replan
- Decompose
- automatic looping
- background daemon
- scheduling
- queue workers
- Budget enforcement
- Risk Engine
- Monitor
- automatic installation
- npm publishing
- PATH mutation
- public packaging

Those remain Step 6+ work.

---

# Final Report

When finished, report only:

- files created or modified
- project-root CLI entry point
- supported operator commands
- `status` output model
- Task-ID convenience behavior
- exit-code behavior
- help behavior
- confirmation that no new LLM calls were introduced
- validation/test results
- anything intentionally deferred to Step 6

Do not proceed to retry, diagnosis, automatic orchestration, or package extraction.