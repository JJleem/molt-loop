# PROJECT-BOOTSTRAP.md

# Purpose

Use this prompt after the project roadmap has been created and before the first Phase is planned or implemented.

The purpose of Bootstrap is to make the repository **runnable, testable, and ready for the Loop Runtime** without implementing product features.

Bootstrap should establish only the minimum development environment required for later Phase work.

---

# 1. Preconditions

Before starting Bootstrap, confirm that the project has:

```text
docs/PRODUCT-SPEC.md
phase-prompt/
  01-*.md
  ...
  Goal.md

.loop/
.loop-local/
tools/loop-runtime/
loopctl
loopctl.cmd
```

`docs/LOOP-RUNTIME-FIELD-NOTES.md` and `CLAUDE.local.md` may also already exist.

If `docs/PRODUCT-SPEC.md` does not exist, stop Bootstrap and create the Product Spec / Phase roadmap first.

Do not invent the product direction during Bootstrap.

---

# 2. Read Before Acting

Read:

1. `docs/PRODUCT-SPEC.md`
2. `docs/SYSTEM-MAP.md`, if it already exists
3. `.loop/KERNEL.md`
4. `.loop/project.yaml`
5. relevant Runtime policies under `.loop/policies/`
6. existing repository files and package / build configuration

Use the Product Spec only to understand the intended product and likely development stack.

Do not begin implementing Phase 1.

---

# 3. Inspect the Existing Repository First

Before creating or changing anything, inspect the actual repository.

Determine:

- whether the repository is empty or already initialized,
- package manager in use,
- current framework / language,
- existing build command,
- existing lint command,
- existing test command,
- existing source layout,
- existing configuration files,
- Node / Python / other relevant runtime versions,
- whether Git is initialized,
- whether any product code already exists.

Do not overwrite a valid existing setup merely because another stack is preferred.

If the repository already has a working development environment, adapt Bootstrap to it instead of recreating the project.

---

# 4. Choose the Minimum Appropriate Development Stack

If the repository is empty, choose the smallest practical stack consistent with `docs/PRODUCT-SPEC.md`.

Prefer conventional, well-supported tooling.

Examples may include:

```text
React + TypeScript + Vite
Next.js + TypeScript
Node + TypeScript
Python + pytest
```

but the actual choice must come from the project's needs.

Do not add infrastructure merely for possible future use.

Avoid premature additions such as:

- authentication systems,
- databases,
- cloud deployment,
- Docker / Kubernetes,
- queues,
- observability platforms,
- complex state management,
- future product libraries,
- format-specific or domain-specific dependencies not needed for Bootstrap.

Bootstrap is not architecture maximalism.

---

# 5. Dependency Rule

Install only dependencies needed to establish the development baseline.

Typical categories are:

- application framework,
- language / compiler,
- build tooling,
- linter,
- test runner,
- minimal test environment.

Do not install future feature libraries just because the Product Spec mentions them.

External product libraries should normally be selected and verified in the first Phase that actually needs them.

Do not guess library versions or capabilities.

---

# 6. Create the Smallest Runnable Application

If the project is new, create only enough application code to prove the development environment works.

Examples:

```text
minimal app shell
minimal entry point
placeholder screen
single smoke test
```

The placeholder must not implement real product functionality from Phase 1 or later.

The goal is only to prove:

```text
install
→ build
→ lint
→ test
→ run
```

works.

---

# 7. Required Project Scripts

Establish real executable commands for the repository.

Where appropriate, provide equivalents of:

```text
build
dev
lint
test
```

Optional commands such as `test:watch`, `typecheck`, or `preview` may be added only when useful for the chosen stack.

Do not create fake commands that always succeed.

Do not use placeholder commands such as:

```text
echo PASS
exit 0
```

for Runtime Gates.

---

# 8. Prove Every Bootstrap Command

Actually execute every command that will later become a Runtime Gate.

At minimum, when applicable:

```text
build
lint
test
```

Each enabled Gate must correspond to a command that has been executed successfully in the current repository.

If a command does not exist or cannot run reliably, do not register it as an enabled Gate yet.

Fix Bootstrap-level configuration problems before continuing.

Do not hide failures.

---

# 9. Configure `.loop/project.yaml`

After the repository commands are proven, update `.loop/project.yaml` to describe this project.

Configure only real executable Gates.

Conceptually:

```yaml
gates:
  build:
    enabled: true
    command: <actual build command>

  lint:
    enabled: true
    command: <actual lint command>

  test:
    enabled: true
    command: <actual test command>
```

Use the actual schema already supported by the Loop Runtime in this repository.

Do not invent configuration keys.

Do not replace working Runtime policy files unnecessarily.

If a Gate is not applicable to the project, leave it disabled or absent according to the Runtime's supported configuration.

---

# 10. Runtime Integrity

Do not modify Loop Runtime implementation unless Bootstrap reveals a genuine compatibility defect that prevents the Runtime from operating.

Normally Bootstrap may configure:

```text
.loop/project.yaml
```

but should not redesign:

```text
tools/loop-runtime/
.loop/KERNEL.md
.loop/DESIGN.md
Runtime state machine
Gate semantics
Verifier semantics
Retry policy
Planner semantics
```

If Runtime itself appears broken, stop and report the problem separately rather than silently patching it as part of product Bootstrap.

---

# 11. `.loop-local/` Rule

`.loop-local/` is local ephemeral Runtime state.

For a new project, it should begin clean.

Do not copy historical:

- Run artifacts,
- Execution artifacts,
- Plan artifacts,
- leases,
- staging files,
- previous project's telemetry.

A `.gitkeep` is fine if needed.

Do not reuse stale Plan / Run IDs from another repository.

---

# 12. Example Task Rule

If `.loop/tasks/TASK-EXAMPLE.yaml` exists as a Runtime template, keep it inert.

It should remain clearly marked as an example and must not become READY or auto-dispatched.

Do not treat the example Task as product work.

---

# 13. `CLAUDE.local.md`

If the project uses the shared `CLAUDE.local.md`, confirm that it describes the local operator workflow for this project.

It must preserve these rules:

- `docs/PRODUCT-SPEC.md` is the product source of truth,
- Phase Goals are executed incrementally,
- Runtime state / Gates / Verifier / recovery are not bypassed,
- Runtime-launched Planner / Worker / Verifier contexts remain isolated,
- project files are not modified while Execute / Gate / Verifier is active or while verification subject integrity must remain stable,
- Field Notes are written only after the Runtime operation reaches a stable point,
- `docs/SYSTEM-MAP.md`, when it exists, is read before planning a Phase and updated only at
  Phase boundaries or meaningful architecture changes.

Do not inject `CLAUDE.local.md` into Runtime Worker / Planner / Verifier snapshots unless the Runtime explicitly supports that design.

---

# 14. Field Notes

Ensure this file exists:

```text
docs/LOOP-RUNTIME-FIELD-NOTES.md
```

Use the shared Field Notes template.

Bootstrap observations may be recorded after Bootstrap reaches a stable point if they reveal a genuine Runtime / Planner / workflow issue.

Do not classify ordinary project setup problems as Runtime defects.

Do not modify Runtime immediately merely because an improvement idea appears.

Record evidence first.

---

# 15. System Map

`docs/SYSTEM-MAP.md` is the project's persistent high-level map: what the system is,
what is actually implemented, how work flows through it, where the external dependency
boundary sits, and which detailed document to read next.

Use the shared template:

```text
docs/SYSTEM-MAP.template.md
```

Copy it to `docs/SYSTEM-MAP.md` and fill it in. Leave the template file itself unchanged.

## If the repository already has architecture

Build the map **from evidence, not from assumption**:

```text
inspect the repository
→ inspect existing architecture / docs
→ write SYSTEM-MAP from what actually exists
```

Read the source layout, the existing documents, and the dependency manifest before writing
a single section. Do not describe a component you have not opened.

## If the repository is new or nearly empty

Do not fill the map as though a system already exists.

Choose one:

- create `docs/SYSTEM-MAP.md` as a **skeleton only** — sections present, status table present,
  Update Rule present, and the parts that have no evidence yet left explicitly empty; or
- do not create it during Bootstrap at all, and create it at the **first Phase boundary that
  produces real architecture**.

Either is acceptable. Inventing architecture to fill the document is not.

## Status discipline

The status vocabulary in the template is not decoration:

```text
DONE       implementation exists in the repository and passed its required validation
PLANNED    planned, not implemented
DEFERRED   intentionally postponed to a later scope
CANDIDATE  under consideration, neither selected nor implemented
```

**An installed dependency is not an implemented feature.** A package present in the manifest,
a successful preflight, or a sample that ran once is not `DONE`. Only integration into the
product path, with its validation passing, is `DONE`.

Bootstrap installs dependencies. That alone changes nothing to `DONE`.

---

# 16. Run Runtime Self-Checks

After project Gate configuration is complete, run the Runtime's available deterministic health / regression checks.

At minimum, when supported:

```text
loopctl doctor
```

Also run the Runtime's own deterministic test suite if the repository exposes one and it is practical to do so.

The goal is to confirm both:

```text
Product repository baseline works
+
Loop Runtime still works
```

Bootstrap is not complete if project configuration silently breaks Runtime behavior.

---

# 17. Bootstrap Completion Criteria

Bootstrap is complete only when all applicable statements are true:

- repository dependency installation succeeds,
- the development application starts or builds,
- the build command succeeds,
- the lint command succeeds,
- the test command succeeds,
- at least one meaningful smoke / baseline test exists when tests are applicable,
- `.loop/project.yaml` references only proven commands,
- Runtime health check passes,
- `.loop-local/` contains no stale project history,
- `docs/SYSTEM-MAP.md` either reflects what the repository actually contains, or was
  deliberately deferred to the first Phase boundary that produces real architecture —
  it must never describe unimplemented work as `DONE`,
- no real Phase 1 feature has been implemented,
- no future product dependency was installed without current need,
- Product Spec and Phase Goals remain unchanged unless Bootstrap uncovered a clear factual setup correction requiring human review.

---

# 18. Explicit Non-Goals

Bootstrap must NOT:

- implement Phase 1,
- implement product features,
- run `loopctl plan` for a Phase,
- approve Plans,
- execute product Tasks,
- pre-build later Phases,
- install all future dependencies,
- redesign the Loop Runtime,
- create fake Gates,
- mark product work DONE,
- broaden the Product Spec.

Bootstrap stops when the repository is ready for Phase planning.

---

# 19. Final Verification Sequence

Before declaring Bootstrap complete, perform a final clean verification using the actual repository commands.

Example shape:

```text
<install / dependency check if necessary>
↓
<build>
↓
<lint>
↓
<test>
↓
<Runtime deterministic checks if available>
↓
loopctl doctor
```

Report actual exit status / result.

Do not claim PASS for commands that were not executed.

---

# 20. Final Report

When Bootstrap finishes, report:

- detected / selected stack,
- runtime and package-manager versions,
- important dependencies added,
- scripts configured,
- files created or changed,
- enabled Runtime Gates and exact commands they represent,
- build result,
- lint result,
- test result,
- Runtime self-check result,
- `loopctl doctor` result,
- whether `docs/SYSTEM-MAP.md` was created, created as a skeleton, or deferred — and why,
- confirmation that no Phase product feature was implemented,
- any unresolved setup risks.

Then stop.

Do not begin Phase 1 automatically.

---

# 21. Intended Next Step

After Bootstrap is complete, the operator should begin with the first Phase Goal:

```text
phase-prompt/01-*.md
↓
loopctl plan --file <phase-goal>
↓
loopctl plan-show <PLAN-ID>
↓
human review / approval
↓
loopctl plan-approve <PLAN-ID>
↓
loopctl execute-plan <PLAN-ID>
↓
DONE  /  human-required stop
```

Bootstrap prepares the road.

The Loop Runtime performs the product work afterward.
