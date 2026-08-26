Before implementing Worker execution, make one small schema refinement to the current V0 Runtime.

Do not expand the Runtime scope.

Do not implement Worker execution, Gate execution, Verifier execution, retries, or any LLM integration in this task.

# Goal

Replace the current Acceptance Criteria field:

```yaml
verified_by:

```

with a more explicit verification specification.

The Runtime must capture **how an Acceptance Criterion can be judged**, not merely who judges it.

# New Acceptance Criteria Shape

Use:

```yaml
acceptance_criteria:
  - id: AC1
    description: Example deterministic criterion
    verification:
      type: gate
      ref: example_gate

```

For criteria that require independent reasoning:

```yaml
acceptance_criteria:
  - id: AC2
    description: Example reasoning-based criterion
    verification:
      type: verifier
      instruction: >
        Inspect the canonical diff and evidence and determine whether
        this criterion is satisfied.

```

For V0, support only:

```text
gate
verifier

```

Do not add `human`, composite expressions, AND/OR trees, thresholds, or additional verification types yet.

# Validation Rules

Every Acceptance Criterion must have:

- `id`
- `description`
- `verification`
- `verification.type`

If `verification.type == gate`:

- `verification.ref` is required.

If `verification.type == verifier`:

- `verification.instruction` may be optional if the description itself is sufficiently judgeable, but if present it must be a non-empty string.

Reject unknown verification types.

Continue enforcing the principle:

> An Acceptance Criterion without a concrete judgment method is invalid and must not be dispatched.

# Update

Update only what is necessary:

- Task validation
- TASK-EXAMPLE.yaml
- Context Builder output
- Relevant tests or temporary fixtures
- README documentation if needed

Do not change `.loop/[DESIGN.md](http://DESIGN.md)`.

Do not change the Runtime architecture.

# Context Output

The Context Builder must preserve each criterion's verification specification.

Example:

```text
--- ACCEPTANCE CRITERIA ---

AC1
Description: ...
Verification: gate
Ref: example_gate

AC2
Description: ...
Verification: verifier
Instruction: ...

```

Do not duplicate the same criterion elsewhere in the generated context.

# Validation

Test at least:

- valid gate criterion
- gate criterion missing `ref`
- valid verifier criterion
- unknown verification type
- criterion missing verification
- context generation with both gate and verifier criteria

Remove temporary fixtures afterward.

Ensure `.loop/[DESIGN.md](http://DESIGN.md)` remains unchanged.

# Final Report

Report only:

- files changed
- final Acceptance Criteria schema
- validation rules
- context representation
- test results

Do not proceed to Worker execution.