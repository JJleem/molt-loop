# START-HERE.md

# Loop Project Starter — First Session Prompt

Use this file as the **very first prompt** when starting a new project from the Loop Runtime Starter Kit.

The purpose of this prompt is to make the interactive Claude session understand:

- what files already exist,
- what order the project should be initialized in,
- what should be created first,
- what must not be implemented yet,
- when the Loop Runtime should begin.

Do not skip directly to product implementation.

---

# First Session Instruction

You are operating inside a new project created from the Loop Runtime Starter Kit.

Before doing anything else, inspect and understand the following files if they exist:

- `CLAUDE.local.md`
- `prompts/PROJECT-PHASE-PLANNER.md`
- `prompts/PROJECT-BOOTSTRAP.md`
- `docs/SYSTEM-MAP.md` — the project's high-level map, if this repository already has one
- `docs/SYSTEM-MAP.template.md` — the template it is created from
- `docs/LOOP-RUNTIME-FIELD-NOTES.md`
- `.loop/KERNEL.md`
- `.loop/project.yaml`

Also confirm that the reusable Runtime exists:

- `tools/loop-runtime/`
- `loopctl`
- `loopctl.cmd`

Do not modify Runtime source code during initial project setup unless the Runtime itself is broken.

---

# Project Topic

The user will provide the project topic or idea.

Treat the user's description as the initial product intent.

If the user has already supplied a detailed specification, use it instead of inventing a new one.

If the project topic is ambiguous in a way that materially changes the product direction, ask only the minimum necessary clarification.

Otherwise, proceed without unnecessary questions.

---

# Initialization Order

Initialize the project in this exact high-level order:

```text
1. Understand the user's project idea
↓
2. Create or confirm docs/PRODUCT-SPEC.md
↓
3. Create phase-prompt/01-*.md ... phase-prompt/Goal.md
↓
4. Let the user review the roadmap if useful
↓
5. Bootstrap the repository
↓
6. Verify real build / lint / test Gates
↓
7. Run loopctl doctor
↓
8. Stop before the first Phase plan unless the user asks to continue
```

Do not begin Phase implementation before planning and Bootstrap are complete.

---

# Step 1 — Product Spec and Phase Roadmap

Use:

`prompts/PROJECT-PHASE-PLANNER.md`

as the planning instruction.

From the user's topic, create:

```text
docs/PRODUCT-SPEC.md

phase-prompt/
├─ 01-<phase-name>.md
├─ 02-<phase-name>.md
├─ ...
└─ Goal.md
```

The number of Phases should come from actual product scope.

Do not force exactly 10 Phases.

The Phase files are **Goal-level inputs**, not Runtime Tasks.

Do not create `TASK-001`, `TASK-002`, etc. during this step.

Do not implement product code during this step.

---

# Step 2 — Review the Roadmap

Before Bootstrap, briefly review the generated roadmap.

Check:

- Phase 1 is the smallest useful foundation
- one real end-to-end capability appears early
- later Phases build on proven earlier work
- no Phase is just a tiny implementation Task
- no Phase tries to build the entire application at once
- external libraries / APIs / CLIs are marked for real verification when needed
- final `Goal.md` is integration / hardening, not uncontrolled feature expansion

If the roadmap is structurally weak, fix it before continuing.

Do not start implementation just because the roadmap files now exist.

---

# Step 3 — Bootstrap

After the Product Spec and Phase roadmap exist, use:

`prompts/PROJECT-BOOTSTRAP.md`

as the Bootstrap instruction.

Bootstrap should prepare only the minimum real development environment needed for Phase work.

Depending on the project, this may include:

- project scaffold
- package / dependency manager
- language configuration
- build configuration
- lint configuration
- test configuration
- minimal placeholder application
- `.loop/project.yaml`
- deterministic Gate commands
- Runtime doctor checks
- `docs/SYSTEM-MAP.md`, from repository evidence

Do not implement normal product features during Bootstrap.

If the repository is new or nearly empty, do not fill `docs/SYSTEM-MAP.md` as though a
system already exists. Create a skeleton, or defer it to the first Phase boundary that
produces real architecture. `prompts/PROJECT-BOOTSTRAP.md` §15 covers both cases.

Do not install speculative future dependencies.

Do not create fake Gates.

Only configure Gates that are backed by real executable commands.

---

# Step 4 — Verify Bootstrap

Before declaring Bootstrap complete, verify:

```text
build → actually runs successfully
lint  → actually runs successfully
test  → actually runs successfully
loopctl doctor → PASS
```

If a Gate does not exist for this type of project, do not fabricate one.

Document the actual available Gates in `.loop/project.yaml`.

Do not silently accept a broken project scaffold.

---

# Step 5 — Stop Point

After successful Bootstrap, report:

- Product Spec created / confirmed
- number of Phase Goals
- Phase filenames in order
- chosen project stack
- actual build command
- actual lint command
- actual test command
- Gate status
- `loopctl doctor` result
- important assumptions or blocked verification

Then stop.

Do **not** automatically:

- run the first `loopctl plan`
- approve a Plan
- execute a Task
- begin Phase 1 implementation

unless the user explicitly asks to continue.

---

# Starting Phase 1 Later

When the user asks to start development, use the first Phase Goal:

```text
phase-prompt/01-<phase-name>.md
```

Then follow the normal Runtime flow:

```text
Phase Goal
↓
loopctl plan
↓
loopctl plan-show <PLAN-ID>
↓
human review
↓
loopctl plan-approve <PLAN-ID>
↓
loopctl execute-plan <PLAN-ID>
↓
DONE  /  human-required stop
```

`execute-plan` runs the approved Plan's Tasks **one at a time**, in Runtime READY
order. It reuses the same per-Task loop as `execute` (Worker → Gate → Verifier →
Diagnose → Retry) and stops immediately at anything that needs a human.

Re-running it after such a stop skips the Tasks that are already DONE and
continues from the rest. There is no resume flag and none is needed.

`loopctl execute <TASK>` still exists for running a single Task by hand. Use it
for debugging, not as the normal Phase flow — do not schedule Tasks yourself.

Do not bypass approval boundaries.

---

# When the User Says "Just Start"

If the user says something broad such as:

```text
"이 프로젝트 시작해줘"
"이걸로 하나 만들어보자"
"처음부터 진행해줘"
"세팅부터 해줘"
```

interpret that as:

```text
Product Spec
→ Phase roadmap
→ Bootstrap
→ verification
→ stop before Phase execution
```

unless the user explicitly requests full automatic continuation.

Do not interpret "start" as permission to implement the entire product.

---

# When the User Already Has PRODUCT-SPEC.md

If `docs/PRODUCT-SPEC.md` already exists:

- do not overwrite it casually,
- read it first,
- treat it as the source of truth,
- generate or repair only the Phase roadmap as needed,
- then Bootstrap.

If Phase prompts already exist too, validate their structure instead of regenerating them without reason.

---

# When the Repository Is Not Empty

If product code already exists:

- inspect the actual repository first,
- do not replace the stack merely because the Bootstrap template suggests another one,
- preserve working project behavior,
- derive real Gate commands from the existing project,
- avoid destructive scaffolding.

Bootstrap means integrating the existing project with the Runtime, not necessarily creating a new app from scratch.

---

# Field Notes

Use:

`docs/LOOP-RUNTIME-FIELD-NOTES.md`

for real Runtime / Planner / workflow observations.

Do not write ordinary product bugs there.

Do not modify Field Notes while an active Runtime execution, Gate, or Verifier depends on repository subject stability.

Follow the detailed rules in:

`CLAUDE.local.md`

---

# Important Boundaries

Never:

- mark a Runtime Task DONE manually
- bypass Gate or Verifier
- fabricate external-library support
- fabricate successful tests
- create fake Gate commands
- modify `.loop/DESIGN.md`
- inject interactive conversation history into isolated Runtime contexts
- implement later Phases early
- rewrite the Runtime because of a speculative improvement idea

Prefer evidence over claims.

Prefer small proven progress over broad speculative implementation.

---

# Expected First User Interaction

After reading this file, the ideal interaction is simple.

The user should only need to say something like:

```text
내가 만들고 싶은 건
"로컬에서 여러 3D 파일을 분석하고 변환 호환성을 비교하는 웹 도구"야.
처음부터 시작해줘.
```

or:

```text
프로젝트 주제:
"회사 내부 문서를 로컬에서 검색하고 요약하는 도구"

시작해줘.
```

Then proceed using this file's initialization order.

The user should not have to explain the Loop Runtime workflow again in every new project or chat session.
