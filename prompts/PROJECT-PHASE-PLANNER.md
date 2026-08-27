# Project Phase Planner — Spec → Phase Goals → Final Goal

Use this prompt at the beginning of a new project to turn the user's broad topic or product idea into a persistent development roadmap made of:

- `docs/PRODUCT-SPEC.md`
- `phase-prompt/01-*.md`
- `phase-prompt/02-*.md`
- ...
- `phase-prompt/Goal.md`

These files will later be used as Goal inputs for the Loop Runtime.

This step is planning only.

Do not implement the product.
Do not create Runtime Tasks.
Do not run `loopctl plan`, `plan-approve`, `execute-plan`, or `execute`.

---

## 1. Input

The user will provide either:

1. a broad product / project idea, or
2. an existing product specification.

If `docs/PRODUCT-SPEC.md` already exists, treat it as the product source of truth.

If no Product Spec exists yet, create one first from the user's topic.

If `docs/SYSTEM-MAP.md` already exists, read it before planning Phases — it states what is
already implemented, and Phase Goals must not re-plan work that is already `DONE`. Do not
write to it here: this step produces planning documents only, and the System Map is created
during Bootstrap or at a Phase boundary.

Do not silently broaden or replace an existing Product Spec.

---

## 2. Required Output

Create:

```text
docs/
└─ PRODUCT-SPEC.md

phase-prompt/
├─ 01-<phase-name>.md
├─ 02-<phase-name>.md
├─ 03-<phase-name>.md
├─ ...
└─ Goal.md
```

The number of phases must come from the actual product scope.

Do not force exactly 10 phases.

For a medium PoC, prefer roughly 5–10 meaningful phases.

---

## 3. Core Roadmap Principle

Design the roadmap in this general progression:

```text
Product North Star
↓
Smallest useful foundation
↓
First real end-to-end capability
↓
Core product flow
↓
Feature expansion
↓
Validation / QA / observability
↓
Secondary product flow
↓
Compatibility / edge cases / performance
↓
Final integrated PoC
```

Every Phase should leave the project:

```text
runnable
+
testable
+
verifiable
+
meaningfully improved
```

Do not create phases only to make the roadmap look detailed.

---

## 4. Phase Files Are Goals, Not Tasks

Each file under `phase-prompt/` will later be passed to the Loop Runtime Planner.

Conceptually:

```text
phase-prompt/01-....md
↓
loopctl plan --file ...
↓
Planner
↓
Runtime Tasks
```

Therefore, Phase files must define Goal-level outcomes.

A Phase should explain:

- what outcome must exist,
- why this phase exists,
- what is in scope,
- what is explicitly out of scope,
- what must be verifiably true when complete.

Do not write Task IDs.

Do not decompose phases into file-by-file implementation instructions.

Do not replace the Runtime Planner.

Bad:

```text
TASK-001 create parser.ts
TASK-002 create parser.test.ts
TASK-003 create component.tsx
```

Good:

```text
Build the first reliable asset-inspection flow so a user can upload a
supported file, identify its actual data type, and inspect safe metadata
without implementing later conversion features.
```

---

## 5. Phase Granularity

Each Phase must represent one meaningful milestone.

Avoid phases that are too large:

```text
Build the entire application.
```

Avoid phases that are too small:

```text
Create one interface.
Add one button.
Rename one function.
```

Prefer coherent capabilities such as:

```text
Input analysis foundation
First real viewer
First real conversion path
Comparison workflow
Validation pipeline
Secondary input type support
Performance hardening
```

A Phase may later produce several Runtime Tasks.

That is expected.

---

## 6. Phase 1 Rule

Phase 1 should establish the smallest useful foundation.

Do not front-load the complete architecture.

Do not install or investigate every future dependency before the first useful result.

Prefer:

```text
minimal real foundation
```

over:

```text
future-proof everything first
```

---

## 7. Prove One Real Path Early

After the foundation, prioritize the first genuine end-to-end product capability.

Examples:

```text
upload → analyze → result
input → convert → output
open → edit → save
query → fetch → display
asset → render → inspect
```

Do not expand breadth before one core path actually works.

---

## 8. External Libraries / APIs / CLIs

When a Phase depends on an external library, API, CLI, provider, or file-format implementation:

- verify current versions when relevant,
- verify actual supported features,
- prefer official documentation for authoritative claims,
- distinguish `VERIFIED` from `UNVERIFIED`,
- do not invent APIs,
- do not assume theoretical compatibility means real implementation support.

If authoritative verification is required for completion and cannot be performed, the Goal must not silently allow it to be deferred.

Do not create a standalone research Phase unless that research genuinely blocks later implementation.

Prefer doing research inside the first Phase that actually needs the decision.

---

## 9. Standard Phase Prompt Shape

Each `phase-prompt/NN-*.md` should roughly follow:

```md
# Phase N — <Name>

Implement Phase N of `docs/PRODUCT-SPEC.md`.

## Goal

<Clear description of the capability that should exist when complete.>

## Required Outcome

The completed Phase must:

1. ...
2. ...
3. ...

## Important Rules

- ...
- ...
- ...

## Out of Scope

Do not implement:

- ...
- ...
- ...

## Verification Boundary

The Phase is complete only when:

- the required behavior actually works,
- configured build/lint/test Gates remain green,
- relevant edge cases are covered,
- later Phases are not required to make this Phase usable.

## Source of Truth

Follow `docs/PRODUCT-SPEC.md`.

When external libraries or APIs are involved, verify actual current support
instead of guessing.

Stay strictly within this Phase.
```

Use this as a pattern, not rigid boilerplate.

---

## 10. Scope Control

Every Phase must explicitly state what is NOT being implemented yet.

This prevents Planner and Worker scope creep.

Use actual project-specific exclusions.

Examples may include:

- later formats,
- authentication,
- admin features,
- cloud deployment,
- AI evaluation,
- advanced optimization,
- secondary workflows.

Do not add irrelevant generic exclusions.

---

## 11. Product Spec Requirements

If creating `docs/PRODUCT-SPEC.md`, include at least:

- product name / working name,
- final product direction,
- core user flow,
- primary use cases,
- important domain rules,
- initial technical direction,
- constraints,
- supported inputs / outputs where relevant,
- validation philosophy,
- performance / safety considerations,
- explicit non-goals,
- MVP / PoC success criteria,
- future expansion,
- development principles.

The Product Spec should be detailed enough that later Phase prompts can refer back to it instead of repeating the whole product.

Do not turn Product Spec into implementation code.

---

## 12. Final Goal

`phase-prompt/Goal.md` is not another feature Phase.

It is the final integration / hardening / PoC-completion Goal after all normal Phases are complete.

It should ask the Runtime to:

- integrate all already-built primary flows,
- remove inconsistencies between Phases,
- verify the real user journey,
- validate the Product Spec's PoC / MVP success criteria,
- verify important failure paths,
- verify result usability,
- preserve explicit non-goals,
- avoid adding large new feature areas.

The key question is:

```text
Does this now behave like one coherent product,
rather than a collection of completed phases?
```

---

## 13. Final Goal Shape

Prefer:

```md
# Final Integrated Goal

Complete the first integrated PoC described in `docs/PRODUCT-SPEC.md`.

Do not expand the product into every possible future capability.

The purpose of this Goal is to integrate, harden, and verify the primary
product flows already implemented in earlier Phases.

## Primary Flows

### Flow A
<main end-to-end flow>

### Flow B
<secondary end-to-end flow if applicable>

## The Integrated Product Must Answer

1. ...
2. ...
3. ...

## Final Verification

Use the PoC / MVP success criteria in `docs/PRODUCT-SPEC.md` as the acceptance target.

The Goal is complete only when the existing supported flows work together as a
coherent product rather than isolated demos.

## Explicit Non-Goals

Do not add:

- ...
- ...
```

Do not use `Goal.md` to hide major unfinished features.

---

## 14. Roadmap Review Before Writing Files

Before finalizing the roadmap, check:

- Is Phase 1 small enough?
- Is one real end-to-end capability proven early?
- Does each later Phase build on something already proven?
- Are any two Phases needlessly separated?
- Is any Phase really just a Task?
- Is any Phase too large for one Planner cycle?
- Are external assumptions explicitly marked for verification?
- Are expensive or risky features postponed until needed?
- Are product non-goals preserved?
- Does `Goal.md` integrate instead of expand?
- Can each Phase later be independently passed to `loopctl plan --file`?

Fix the roadmap before writing the final files.

---

## 15. Do Not Execute

This step creates planning documents only.

Do not run:

```text
loopctl plan
loopctl plan-approve
loopctl execute-plan
loopctl execute
```

Do not create Runtime Tasks.

Do not modify Runtime source.

Do not implement product features.

The output is only:

```text
PRODUCT-SPEC.md
+
Phase Goal files
+
Goal.md
```

---

## 16. Final Report

After creating the planning files, report:

- Product Spec path,
- number of Phases,
- Phase filenames in order,
- one-line purpose of each Phase,
- Final Goal path,
- sequencing rationale,
- important assumptions,
- anything that must be verified before a future Phase.

Do not begin implementation.

---

## 17. Intended User Workflow

After these files exist:

```text
Bootstrap repository
↓
phase-prompt/01-....md
↓
loopctl plan --file ...
↓
loopctl plan-show <PLAN-ID>
↓
human approval
↓
loopctl plan-approve <PLAN-ID>
↓
loopctl execute-plan <PLAN-ID>
↓
Phase DONE
↓
phase-prompt/02-....md
↓
...
↓
all normal Phases DONE
↓
phase-prompt/Goal.md
↓
final integration
```

The user should not need to redesign the project's development sequence in every new chat session.

These Markdown files are the persistent roadmap.
