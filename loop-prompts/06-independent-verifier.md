The V0 Runtime now implements:

- Runtime scaffold and configuration
- Task loading and validation
- Runtime-owned Task state transitions
- Context Builder and immutable Run Snapshots
- Acceptance Criteria verification schema
- AI Worker execution
- Structured Worker Result validation
- Runtime Envelope
- Worker integrity checks
- Worker usage/token telemetry
- Deterministic Gate Runner
- Gate Evidence and canonical Gate Reports
- Derived `VERIFY_READY`

The current flow is approximately:

```text
Task
→ Snapshot
→ AI Worker
→ Structured Worker Result
→ REVIEW
→ Deterministic Gates
→ PASS
→ VERIFY_READY

```

This step adds the first **independent AI Verifier**.

After this step, the successful flow should become:

```text
Worker
→ REVIEW
→ Gate PASS
→ Independent Verifier
→ PASS
→ DONE

```

and:

```text
Worker
→ REVIEW
→ Gate PASS
→ Independent Verifier
→ FAIL
→ REVIEW remains

```

Do not implement automatic retry yet.

Before making any changes, inspect the existing Runtime implementation and configuration, including:

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
- `tools/loop-runtime/worker/`
- `tools/loop-runtime/gate/`
- `tools/loop-runtime/[README.md](http://README.md)`

Also re-read only the relevant sections of `.loop/[DESIGN.md](http://DESIGN.md)` concerning:

- Gate vs Verifier
- Independent Verification
- Verified-before-Main
- Evidence
- Runtime ownership
- Stop conditions
- Runtime Envelope
- Observability / Telemetry
- minimum implementation

Do not copy [DESIGN.md](http://DESIGN.md) into Verifier context.

Do not modify `.loop/[DESIGN.md](http://DESIGN.md)`.

---

# 1. Goal of This Step

Implement the first independent reasoning-based Verifier.

The Runtime must be able to:

1. Resolve an eligible `VERIFY_READY` Worker Run.
2. Bind verification to the exact repository state that passed Gates.
3. Build a small independent Verifier Snapshot.
4. Launch a fresh AI Verifier process/session.
5. Prevent the Verifier from modifying project or Runtime state.
6. Capture a structured Verifier Result.
7. Validate that result deterministically.
8. Record Verifier usage telemetry.
9. Produce a Runtime-authored final Verification Report.
10. Transition `REVIEW -> DONE` only when all required verification has passed.

The Verifier must never directly mutate Task state.

The Runtime remains the Single Writer.

---

# 2. Core Independent Verification Rule

The Verifier must not receive the Implementation Worker's narrative.

The Verifier input may contain:

- Task Contract
- Acceptance Criteria
- Canonical Diff / canonical change representation
- Gate Report
- Gate-based Acceptance Criterion results
- Evidence references and metadata
- deterministic Runtime Facts

The Verifier input must not contain:

- Worker summary
- Worker self-evaluation
- Worker progress narrative
- Worker stdout conversation
- Worker reasoning
- previous AI session history
- previous Worker chat transcript
- statements such as "implementation completed successfully"
- [DESIGN.md](http://DESIGN.md)
- unrelated Tasks

The existence of a valid Worker Result may be represented as a Runtime fact, but the Worker's narrative fields must not be copied into the Verifier Snapshot.

Input separation is more important than merely starting another session.

---

# 3. Verifier Architecture

Introduce a small Verifier layer.

Prefer a structure such as:

```text
tools/loop-runtime/
├─ verifier/
│  ├─ runner.mjs
│  ├─ result.mjs
│  ├─ context-builder.mjs
│  ├─ subject.mjs
│  └─ report.mjs

```

You may choose slightly different filenames if they better fit the current Runtime.

Reuse existing provider/process plumbing where doing so avoids duplication.

However:

- Worker Result and Verifier Result are different contracts.
- Worker context and Verifier context are different.
- Worker and Verifier must run as separate fresh invocations.
- Do not reuse the Worker session.
- Do not reuse Worker conversation history.

Do not build a large agent framework or class hierarchy.

---

# 4. Verifier Eligibility

A Verifier may run only when all of the following are true:

- Task is structurally valid.
- Task status is `REVIEW`.
- Task is not an example Task.
- A canonical Worker Run exists.
- Worker Result is independently revalidated.
- Worker Runtime Envelope exists and matches the Run.
- No unresolved Worker policy violation exists.
- A canonical Gate Report exists for that Run.
- Gate Report is valid and matches the Run and Task.
- Overall Gate result is `PASS`.
- Current required Gate set matches the Gate Report.
- Task requires independent verifier evaluation.
- Verification subject is not stale.

If any condition fails, refuse verification before launching the AI.

Do not invoke a Verifier for a Gate FAIL / ERROR / TIMEOUT Run.

Do not invoke another Worker.

---

# 5. Verification Must Be Bound to the Exact Subject

The Verifier must evaluate the same repository state that passed the Gates.

Introduce a deterministic **Verification Subject Fingerprint**.

For the current Git-based repository, prefer a deterministic fingerprint derived from repository state such as:

- current HEAD commit
- staged changes
- unstaged changes
- relevant untracked non-ignored files
- content hashes where needed

Use Git and Node built-ins where practical.

Do not include ignored build caches or dependencies merely because they exist on disk.

The fingerprint must detect meaningful source-tree changes that would make a previous Gate result stale.

The exact representation may differ, but the property must be:

```text
same verification subject
→ same fingerprint

meaningfully changed verification subject
→ different fingerprint

```

Do not ask an LLM to calculate this.

---

# 6. Bind Gate PASS to the Verification Subject

The current Gate implementation predates the Verifier.

Extend Gate reporting minimally if necessary so future Gate Reports record the Verification Subject Fingerprint that they actually tested.

For example:

```json
{
  "verification_subject": {
    "type": "git-worktree",
    "sha256": "...",
    "head": "..."
  }
}

```

The exact schema may differ.

Do not rewrite Gate architecture.

Do not rerun Gates automatically during verification.

If an existing Gate Report lacks enough information to prove that it belongs to the current verification subject:

- refuse Verifier execution
- explain that Gates must be rerun

Do not guess.

Example:

```text
Verifier refused:
Gate Report is not bound to the current repository state.
Run Gates again for this Worker Run.

```

Before launching the Verifier:

```text
current subject fingerprint
==
Gate Report subject fingerprint

```

must hold.

After the Verifier finishes, check the subject again before accepting the result.

If it changed during verification, treat the result as stale and do not transition the Task.

---

# 7. Canonical Diff / Change Representation

Generate a deterministic canonical representation of the changes being verified.

Prefer creating a Run artifact such as:

```text
.loop-local/runs/RUN-.../
└─ verification/
   ├─ canonical-diff.patch
   └─ subject.json

```

For Git repositories:

- use deterministic Git inspection
- include tracked changes relevant to the current working tree
- handle staged and unstaged changes correctly
- represent new/untracked non-ignored files deterministically
- do not include ignored files
- do not rely on Worker-reported `changed_files` as the sole truth

The Worker-reported list may be compared to Runtime-observed changes, but it is not authoritative.

If a perfect unified patch is not practical for some file type, use a deterministic manifest containing:

- path
- change kind
- size
- SHA-256

For small textual changed files, the actual diff/content may be included.

For binary or very large artifacts, do not inject huge contents into the Verifier prompt.

Represent them by metadata/hash and evidence references.

Keep the canonical representation deterministic and bounded.

---

# 8. Verifier Snapshot

Create a separate Verifier Snapshot.

Do not reuse [`context.md`](http://context.md) from the implementation Worker.

Prefer:

```text
.loop-local/runs/RUN-.../
└─ verification/
   ├─ context.md
   ├─ manifest.json
   ├─ canonical-diff.patch
   └─ subject.json

```

The Verifier [`context.md`](http://context.md) should have clear sections similar to:

```text
--- VERIFIER CONTRACT ---

--- TASK ---

--- ACCEPTANCE CRITERIA ---

--- CANONICAL DIFF ---

--- GATE RESULTS ---

--- EVIDENCE ---

--- RUNTIME FACTS ---

```

Do not include:

```text
--- WORKER SUMMARY ---
--- WORKER NARRATIVE ---
--- WORKER STDOUT ---

```

Those sections must not exist.

---

# 9. Verifier Contract

Use `.loop/skills/[verifier.md](http://verifier.md)` as the Verifier role contract.

Keep role instructions separate from evidence wherever practical.

The Verifier must understand:

- it is an independent reviewer
- it must not trust implementation claims
- it must judge only the supplied Acceptance Criteria
- deterministic Gate facts are authoritative
- it must not reinterpret a deterministic Gate PASS/FAIL
- it must not modify code
- it must not modify Runtime state
- it must return a structured result
- it cannot mark the Task DONE itself

If `.loop/skills/[verifier.md](http://verifier.md)` already expresses these principles correctly, do not unnecessarily expand it.

Keep fixed Verifier instructions small.

---

# 10. Gate Criteria vs Verifier Criteria

Acceptance Criteria already support:

```text
verification.type == gate
verification.type == verifier

```

Respect that separation.

For a Gate criterion:

```yaml
verification:
  type: gate
  ref: test

```

the deterministic Gate Report decides the criterion.

The AI Verifier must not override it.

For a Verifier criterion:

```yaml
verification:
  type: verifier

```

the independent Verifier evaluates it.

The Verifier Snapshot may show Gate-based criteria and their authoritative statuses as facts, but the Verifier should reason only about criteria whose type is `verifier`.

Do not make the LLM repeat work already performed deterministically.

---

# 11. Verifier Result Contract

Define a structured V0 Verifier Result.

Prefer a shape similar to:

```json
{
  "run_id": "RUN-...",
  "task_id": "TASK-001",
  "verification_subject_sha256": "...",

  "result": "PASS",

  "criteria": [
    {
      "id": "AC2",
      "status": "PASS",
      "reason": "The canonical diff explicitly handles the required case."
    }
  ],

  "failed_criteria": [],

  "reason": "All reasoning-based acceptance criteria are satisfied."
}

```

For V0, accepted overall results are only:

```text
PASS
FAIL

```

Criterion statuses are only:

```text
PASS
FAIL

```

The Verifier must return exactly one entry for every Acceptance Criterion whose:

```text
verification.type == verifier

```

No missing verifier criteria.

No duplicate criteria.

No unknown criteria.

Do not allow the Verifier to invent new Acceptance Criteria.

---

# 12. Verifier Result Validation

Validate the Verifier Result deterministically.

At minimum reject:

- malformed JSON
- missing result file
- wrong run_id
- wrong task_id
- wrong verification subject hash
- unsupported overall result
- unsupported criterion status
- missing required verifier criterion
- duplicate criterion
- unknown criterion
- gate criterion included as if verifier-owned
- `PASS` while any verifier criterion is `FAIL`
- `FAIL` with no failed criterion unless an explicit valid global reason exists
- failed_criteria inconsistent with criteria[]
- empty required reason fields where applicable

Do not heuristically repair malformed Verifier output.

Do not parse natural-language stdout as the verdict.

---

# 13. Result Extraction

Use a dedicated Runtime-provided result file or an actual structured-output mechanism supported by the installed CLI.

Prefer the same reliable pattern used for Worker Results:

```text
Runtime chooses verifier-result.json path
↓
Verifier receives exact result protocol
↓
Verifier writes JSON to that file
↓
Runtime validates it

```

Do not scrape a conversational transcript for PASS/FAIL.

Normal Verifier stdout may be logged separately for debugging but must not be authoritative.

---

# 14. Fresh AI Invocation

Run the Verifier as a fresh AI process/session.

Do not resume the Worker session.

Do not pass Worker session IDs.

Do not share Worker conversation context.

Use the installed provider CLI that is actually available.

Claude Code is currently the functioning adapter in this environment.

Before changing invocation behavior:

- inspect the existing Worker adapter
- inspect the actual installed CLI options if necessary
- do not invent unsupported flags

You may reuse generic provider invocation logic, but the Verifier must still be a separate invocation with separate context and result protocol.

---

# 15. Read-Only Verifier

The Verifier must not modify implementation files.

This is stricter than the Worker.

Use the strongest read-only mode actually supported by the installed CLI without guessing flags.

Inspect existing Claude CLI behavior/options first.

Where possible, deny:

- file writes
- edits
- shell mutation
- Runtime state changes
- Task changes
- policy changes
- production actions

Do not grant unrestricted Bash simply for convenience.

If the provider cannot guarantee a complete read-only sandbox, add Runtime-side integrity detection.

At minimum:

1. Record repository subject fingerprint before Verifier execution.
2. Record protected Runtime/control-plane hashes.
3. Launch Verifier.
4. Recalculate them afterward.
5. If anything changed:
  - mark `verifier_policy_violation: true`
  - reject the Verifier Result
  - do not transition the Task

A Verifier is an auditor, not an implementation Worker.

---

# 16. Evidence Input

The Verifier should receive Evidence without trusting Worker claims.

Separate Evidence categories conceptually.

For example:

```text
Authoritative Runtime Evidence:
- Gate Report
- Gate result artifacts
- hashes
- Runtime facts

Worker-submitted Evidence:
- paths/references claimed by Worker

```

Label Worker-submitted Evidence clearly as unverified claims.

Do not represent:

```text
Worker evidence path exists

```

as equivalent to:

```text
Evidence verified

```

Do not automatically inject enormous test logs.

Prefer:

- status
- path
- hash
- relevant metadata

The Verifier may inspect referenced read-only files when necessary.

---

# 17. Runtime Facts

Provide only deterministic facts relevant to verification.

Examples:

- Run ID
- Task ID
- Worker adapter
- Worker process exit status
- Worker policy violation status
- observed changed files
- verification subject fingerprint
- Gate result
- Gate durations/statuses
- Gate evidence hashes
- current Task state

Do not provide:

- Worker self-evaluation
- Worker summary
- Worker reasoning
- Worker confidence statements

---

# 18. Final Verification Report

The Runtime, not the Verifier, must create the authoritative final Verification Report.

Prefer:

```text
.loop-local/runs/RUN-.../
└─ verification/
   ├─ context.md
   ├─ manifest.json
   ├─ canonical-diff.patch
   ├─ subject.json
   ├─ verifier-result.json
   ├─ verifier-envelope.json
   └─ verification-report.json

```

The Runtime-authored `verification-report.json` should combine:

- Run identity
- Verification subject
- Gate result
- Gate Acceptance Criteria results
- Verifier Result validity
- Verifier Acceptance Criteria results
- policy violations
- final Runtime conclusion

Conceptually:

```json
{
  "run_id": "RUN-...",
  "task_id": "TASK-001",

  "verification_subject_sha256": "...",

  "gate_result": "PASS",
  "verifier_result": "PASS",

  "acceptance_criteria": [
    {
      "id": "AC1",
      "verification_type": "gate",
      "status": "PASS"
    },
    {
      "id": "AC2",
      "verification_type": "verifier",
      "status": "PASS"
    }
  ],

  "result": "PASS"
}

```

Overall Runtime verification is PASS only if:

- Gate Report is PASS
- every Gate criterion is PASS
- Verifier Result is valid
- every Verifier criterion is PASS
- no Worker policy violation exists
- no Verifier policy violation exists
- verification subject has not changed

Never trust the Verifier's single `result: PASS` field without independently checking its criterion entries and Runtime facts.

---

# 19. DONE Transition

This is the first step where Runtime may automatically transition:

```text
REVIEW -> DONE

```

But only when the authoritative Runtime Verification Report is `PASS`.

The sequence must be:

```text
Gate PASS
↓
fresh Verifier
↓
valid Verifier PASS
↓
subject unchanged
↓
Runtime Verification Report PASS
↓
existing transition engine validates REVIEW -> DONE
↓
Runtime performs state mutation

```

The Verifier itself must never edit Task YAML.

The Verifier must not return:

```text
requested_transition: DONE

```

There is no transition request in the Verifier Result contract.

The Runtime decides the transition.

On Verifier FAIL:

```text
Task remains REVIEW.

```

Do not automatically return it to `IN_PROGRESS`.

Do not automatically retry.

That belongs to Step 6.

---

# 20. Tasks With No Verifier Requirement

Do not expand completion policy unnecessarily in this step.

This Step focuses on Tasks that actually require independent verifier evaluation.

If a Task does not require a Verifier, preserve the existing Gate-only behavior unless there is already an explicit completion policy in the Runtime.

Do not invent a new gate-only auto-DONE policy in this task.

Document gate-only finalization as intentionally deferred if necessary.

---

# 21. Verifier Telemetry

Track Verifier usage just as Worker usage is tracked.

Telemetry collection must not require an additional AI call.

Record at minimum:

```text
context bytes
context characters
context lines

stdout bytes
stderr bytes

duration
adapter
model
provider token usage when available
provider cost when available

```

When the provider exposes exact usage, store it as:

```json
{
  "tokens": {
    "source": "provider",
    ...
  }
}

```

Use only fields actually provided by the CLI.

Do not synthesize missing totals.

If unavailable:

```json
{
  "tokens": {
    "source": "unavailable"
  }
}

```

Do not estimate simply to populate the UI.

Keep Worker and Verifier usage separate.

For example:

```text
Worker Usage
→ implementation cost

Gate Usage
→ zero LLM tokens

Verifier Usage
→ verification cost

```

Do not implement cross-stage cost aggregation yet.

---

# 22. Verifier Envelope

Create a Runtime-observed Verifier Envelope separate from the Verifier's own result.

For example:

```json
{
  "run_id": "RUN-...",
  "task_id": "TASK-001",
  "adapter": "claude",
  "model": "...",

  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 0,

  "process": {
    "exit_code": 0,
    "timed_out": false
  },

  "verifier_result_valid": true,
  "verifier_policy_violation": false,

  "usage": {}
}

```

As with Worker execution:

```text
Verifier claim
!=
Runtime observation

```

Keep them separate.

---

# 23. Verifier Timeout

Add a simple Verifier timeout.

Prefer a configuration such as:

```yaml
runtime:
  verifier_timeout_seconds: 600

```

Use the existing configuration style.

Do not implement complex cancellation policy.

If Verifier times out:

- preserve artifacts
- record timeout
- Task remains REVIEW
- do not retry automatically
- do not mark DONE

---

# 24. Verifier Model Selection

If useful, support a separate Verifier model configuration or CLI flag.

For example:

```yaml
runtime:
  verifier_model: null

```

or:

```bash
loopctl verify RUN-... --model <model>

```

Do not hard-code or guess a model.

If no explicit Verifier model is configured, use a clearly documented existing provider default or existing adapter behavior.

Record the actual provider-reported model when available.

Do not implement model-routing optimization yet.

---

# 25. CLI

Add a canonical Verifier command.

Prefer:

```bash
node tools/loop-runtime/loopctl.mjs verify RUN-...

```

Run ID is canonical.

A Task-ID convenience form may be supported:

```bash
node tools/loop-runtime/loopctl.mjs verify TASK-001

```

only if it resolves deterministically to the current eligible Worker Run.

Print which Run was selected.

Example PASS:

```text
Run: RUN-...
Task: TASK-001

Verification Subject:
  sha256: ...

Gate Result:
  PASS

Launching independent verifier...
Verifier: claude

Verifier process finished
Exit code: 0
Duration: 18.4s

Verifier Result:
  PASS

Verifier AC:
  [PASS] AC2
  [PASS] AC3

Usage:
  context: 7.1 KB
  tokens: 3,821 (provider)

Verification Result:
  PASS

TASK-001: REVIEW -> DONE

```

Example FAIL:

```text
Gate Result:
  PASS

Verifier Result:
  FAIL

Verifier AC:
  [FAIL] AC2
    Required error handling is not implemented.

Verification Result:
  FAIL

Task remains REVIEW.

```

Do not print full Verifier transcript by default.

---

# 26. Optional Verification Inspection Command

If straightforward, add:

```bash
loopctl verification RUN-...

```

to display the existing Runtime-authored Verification Report.

It must not trigger a new Verifier invocation.

If this meaningfully expands CLI scope, defer it.

The required source of truth is `verification-report.json`.

---

# 27. Duplicate Verification / Re-run Behavior

Do not silently overwrite a previous Verifier Result.

Default behavior should refuse duplicate verification for the same immutable verification subject.

Example:

```text
Verification already exists for this Run and subject.
Use --rerun to perform another paid verifier invocation.

```

If implementing `--rerun` is straightforward:

- require it explicitly
- preserve previous verifier artifacts under history
- do not destroy usage records
- create a fresh AI invocation
- clearly record attempt number

Because Verifier execution consumes tokens, never rerun implicitly.

If safe history management significantly expands scope, simply refuse duplicate verification in V0.

---

# 28. Stale Result Handling

Before launching Verifier:

```text
current subject fingerprint
==
Gate Report subject fingerprint

```

After Verifier returns and before accepting PASS:

```text
current subject fingerprint
==
Verifier Snapshot subject fingerprint
==
Gate Report subject fingerprint

```

If not:

```text
STALE_VERIFICATION_SUBJECT

```

Task remains REVIEW.

Do not use the Verifier Result.

Do not mark DONE.

Do not automatically rerun Gates.

---

# 29. No Additional AI Calls

One `loopctl verify` execution should cause at most the intended single Verifier invocation.

Do not:

- ask another AI to summarize the Verifier
- ask another AI to validate the Verifier
- ask the Worker to review the Verifier
- invoke a second Verifier automatically
- invoke sub-agents for consensus

Runtime validation around the Verifier must be deterministic.

---

# 30. Preserve Existing Worker Behavior

Do not regress the Step 3 Worker system.

Preserve:

- Worker adapter discovery
- Worker Snapshot
- Worker Result
- Runtime Envelope
- protected Runtime paths
- observed changed files
- Worker usage telemetry
- timeout behavior
- `run`
- `usage`

Do not modify Worker permissions unless strictly required for Verifier work.

---

# 31. Preserve Existing Gate Behavior

Do not regress Step 4.

Preserve:

- required Gate resolution
- Gate reference validation
- zero-Gate handling
- deterministic sequential Gate execution
- Gate timeout
- process-group termination
- Gate Evidence
- Gate Report
- rerun history
- Gate telemetry
- `gate`
- `gates`
- `verify-ready`

The only allowed Gate-layer extension in this step is the minimal data required to bind Gate PASS to the exact Verification Subject.

Do not turn this into a Gate rewrite.

---

# 32. Explicitly Out of Scope

Do not implement:

- automatic Retry
- Failure Memo generation
- Diagnose
- Retry + Hint
- Replan
- Decompose
- automatic REVIEW -&gt; IN_PROGRESS
- Worker relaunch after Verifier FAIL
- Worker relaunch after Gate FAIL
- Lease locking
- Git Worktree automation
- immutable staging branch/ref
- merge to main
- deployment
- parallel Workers
- parallel Verifiers
- verifier consensus / voting
- Budget enforcement
- Cost limits
- model optimization
- Independent Monitor
- Meta Loop
- Database
- Web UI
- Queue daemon

Those belong to later steps.

---

# 33. Validation

Use deterministic mock Verifier tests for almost all cases.

Do not spend real AI tokens for failure-path testing.

Test at least:

- `VERIFY_READY` Run accepted
- Gate FAIL rejected before Verifier launch
- Gate ERROR rejected
- Gate TIMEOUT rejected
- missing Gate Report rejected
- stale Gate Report rejected
- verification subject fingerprint creation
- subject changes detected
- canonical diff generation
- Worker narrative absent from Verifier context
- Worker summary absent from Verifier context
- Worker stdout absent from Verifier context
- unrelated Task absent
- [DESIGN.md](http://DESIGN.md) absent
- correct verifier-type AC inclusion
- Gate criterion represented only as authoritative fact
- valid PASS result
- valid FAIL result
- wrong run_id rejected
- wrong task_id rejected
- wrong verification subject hash rejected
- missing verifier criterion rejected
- duplicate criterion rejected
- unknown criterion rejected
- Gate criterion illegally claimed by Verifier rejected
- inconsistent overall PASS rejected
- malformed Result rejected
- missing result file rejected
- Verifier process non-zero exit
- Verifier timeout
- Verifier repository mutation detection
- Verifier `.loop` mutation detection
- stale subject after Verifier execution
- Verifier FAIL leaves Task REVIEW
- Verifier PASS produces Runtime Verification Report PASS
- only Runtime performs REVIEW -&gt; DONE
- duplicate verification refused
- Verifier telemetry captured
- unavailable provider tokens handled gracefully
- Worker telemetry unchanged
- Gate telemetry unchanged

Use a mock Verifier adapter or deterministic fixture mechanism for these cases.

Mock Verifier tests must make zero LLM calls.

After deterministic tests pass, perform at most one small controlled live Verifier invocation if practical to validate actual provider integration.

Do not modify real product functionality merely to test the Verifier.

Remove temporary Tasks, runs, files, and fixtures after testing.

Verify:

- `.loop/[DESIGN.md](http://DESIGN.md)` remains byte-identical
- `TASK-EXAMPLE.yaml` remains unchanged
- existing CLI commands still work
- existing Worker/Gate tests still pass

---

# 34. Final Report

When finished, report only:

- Runtime files created or modified
- Verifier architecture
- Verifier adapter/provider used
- actual CLI integration method
- Verifier eligibility rules
- Verification Subject fingerprint method
- Canonical Diff representation
- exact Verifier Snapshot contents
- explicit content excluded from Verifier input
- Verifier Result schema
- Runtime Verification Report schema
- read-only / integrity protection
- `DONE` transition rule
- Verifier telemetry fields
- exact provider token availability
- duplicate/rerun behavior
- stale-subject behavior
- validation/test results
- anything intentionally deferred to Step 6

Do not proceed to Retry, Failure Memo, Diagnose, Replan, or automatic looping.