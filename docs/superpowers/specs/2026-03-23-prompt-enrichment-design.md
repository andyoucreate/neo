# Prompt Enrichment: Superpowers Disciplines Integration

## Summary

Enrich the base agent prompts (`architect.md`, `developer.md`) with disciplines inspired by the [superpowers](https://github.com/obra/superpowers) framework. All changes are injected directly into the existing prompt files — no new skill system, no core changes.

### Approach chosen

Direct prompt modification. Disciplines are added as new sections or enrichments to existing sections within the markdown prompts.

### Alternatives considered

- **Injectable skills via YAML `promptAppend`**: Clean API but adds unnecessary indirection. The disciplines we're adding are universally valuable — no reason to make them optional via a skill system.
- **New `skills` field in agent schema**: Requires core changes (Zod schema, resolver, loader) for minimal benefit. Over-engineered for 5 prompt edits.
- **Runtime injection via `memoryContext`**: Mixes skill text with agent memory. Semantically wrong, harder to debug.

## Changes

### developer.md — 3 modifications

#### D1. TDD opt-in (Protocol > 2. Implement)

**What**: Add a conditional TDD mode activated by `tdd: true` in the task spec.

**Where**: Insert before the existing implementation order (types → logic → exports → tests → config). The existing order becomes the `else` branch.

**Who injects `tdd: true`**: The architect adds `tdd: true` to individual task specs when the task involves complex logic, exploratory behavior, or edge-case-heavy code. This requires a one-line addition to the architect's Decompose section (see A3 below).

**Behavior**:
- If `tdd: true`: Red-Green-Refactor cycle. One test at a time. Write failing test → verify failure → minimal code to pass → verify pass → refactor → repeat.
- Otherwise: unchanged (types → logic → exports → tests → config).

**Why opt-in, not default**: Most neo tasks are spec-driven atomic units where the implementation order (types first, tests last) is more efficient. TDD is valuable for exploratory or complex logic tasks where the spec says "figure out the right behavior."

#### D2. Receiving code review (Disciplines > Handling Review Feedback)

**What**: Replace the existing 6-step feedback handling with a reinforced 7-step version + explicit anti-patterns.

**Full replacement text** (replaces lines 195-205 of current developer.md):

```markdown
When receiving feedback from reviewers (subagent or external):

1. **READ** the full feedback without reacting
2. **RESTATE** the requirement behind each suggestion — what problem is the reviewer solving?
3. **VERIFY** each suggestion against the actual codebase — does the file/function/pattern exist?
4. **EVALUATE**: is this technically correct for THIS code? Check:
   - Does the suggestion account for the current architecture?
   - Would it break something the reviewer can't see?
   - Is it addressing a real issue or a style preference?
5. If **unclear**: re-spawn reviewer with clarification question
6. If **wrong**: ignore with technical reasoning (not defensiveness). Note in report.
7. If **correct**: fix one item at a time, test each fix individually

**Anti-patterns:**
- "Great point!" followed by blind implementation → verify first
- Implementing all suggestions in one batch → one at a time, test each
- Agreeing to avoid conflict → push back with reasoning when warranted
- Assuming the reviewer has full context → they don't, verify
```

**Why**: The current version says "never express performative agreement" but doesn't give concrete anti-patterns. Superpowers is explicit about what bad feedback handling looks like — this makes it actionable.

#### D3. Branch completion (new Disciplines section)

**What**: New section after Status Protocol. Developer presents 4 completion options (push/pr/keep/discard) with a recommendation in the report JSON.

**Output contract**:
```json
{
  "branch_completion": {
    "branch": "feat/...",
    "commits": 3,
    "tests": "all passing",
    "options": ["push", "pr", "keep", "discard"],
    "recommendation": "pr",
    "reason": "..."
  }
}
```

**Trigger**: The task spec must include `last_task: true` for the developer to emit the `branch_completion` block. The architect adds this flag to the final task in each milestone (see A3 below). Without the flag, the developer skips this section.

**Integration with Report**: `branch_completion` is an additional field in the existing Report JSON (Protocol step 6). When `last_task: true`, the developer adds it alongside the existing fields (`task_id`, `status`, `evidence`, etc.).

**Rules**:
- Never merge — only supervisor decides
- Never discard without supervisor confirmation
- If tests fail, only valid option is "keep"
- Always include recommendation with reasoning

**Why**: Currently the developer pushes/PRs only when explicitly instructed. This formalizes the handoff — the developer always reports what SHOULD happen, the supervisor decides.

### architect.md — 3 modifications

#### A1. Design Approval Gate (new Protocol step 6)

**What**: Insert a decision poll between spec review loop (step 5) and decomposition (currently step 6, becomes step 7).

**Behavior**: After the spec passes internal review, the architect submits the full design to the supervisor via `neo decision create`. The context includes: summary, approach, rejected alternatives, components, risks, file count, estimated task count, spec path.

**Response handling**:
- Approved → proceed to decomposition
- Approved with changes → update spec, re-run spec review loop, decompose
- Rejected → revise from step 3 (Design)

**Iteration limit**: Max 2 cycles of gate → revision → spec review → gate. After 2 rejections, escalate to supervisor with full context of what was tried.

**Step renumbering**: Current 6 (Decompose) → 7, current 7 (Execution Strategy) → 8.

**Why**: Currently the architect produces a full design + decomposition before any human validation. If the design is wrong, the decomposition work is wasted. The gate catches design issues before the expensive decomposition step.

#### A2. Parallel dispatch safety (Protocol step 8, formerly 7)

**What**: Enrich Execution Strategy with a parallel safety checklist and formalized wiring task.

**Parallel safety checklist** — before placing tasks in the same group:
- Zero shared files (not even read-only)
- Zero shared exports (barrel files, index.ts, route registrations)
- No implicit ordering
- Independent test files (no shared fixtures)

If ANY check fails → sequential.

**Wiring task**: Formalize the existing text (line 86-87) as an explicit requirement in the strategy. The wiring task depends on ALL parallel tasks, handles barrel exports/routes/config, and must be sized explicitly (split if M or larger).

**Wiring task clarification**: The Decompose section (step 7) already mentions "Shared files go in a final wiring task." This change duplicates that requirement in Execution Strategy intentionally — the architect must verify during strategy design that the wiring task is properly placed, sized, and accounts for all parallel outputs.

**Why**: The current prompt mentions wiring tasks in Decompose but not in Execution Strategy. Parallel safety is mentioned as a rule but without a concrete checklist. This makes both actionable.

#### A3. Task spec flags (Protocol step 7, Decompose — minor addition)

**What**: One-line addition to the "Per task, specify" list in Decompose. The architect can annotate tasks with optional flags.

**Addition to the per-task fields**:
- **flags** (optional): `tdd: true` for complex logic tasks, `last_task: true` for the final task in a milestone

**Why**: D1 (TDD) and D3 (branch completion) both need the architect to signal intent in the task spec. This is the lightest mechanism — a single optional field.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| TDD mode ignored by agents | Conditional is explicit in prompt; task spec schema already supports arbitrary fields |
| Branch completion adds noise to reports | Only triggers after final commit on branch, not per-task |
| Design gate slows down clear tickets | Architect scores 4-5 produce lean decision polls; supervisor can auto-approve in autoDecide mode |
| Parallel checklist too strict (blocks valid parallelism) | Checklist is advisory — architect can override with reasoning |

## Task dependency graph

```
architect.md group (no internal dependencies):
  A1 (design gate) ─────────┐
  A2 (parallel safety) ─────┤── can be applied in any order
  A3 (task spec flags) ──────┘

developer.md group (no internal dependencies):
  D1 (TDD opt-in) ──────────┐
  D2 (review feedback) ─────┤── can be applied in any order
  D3 (branch completion) ───┘

Cross-file dependency:
  A3 ← D1 (developer reads `tdd: true` set by architect)
  A3 ← D3 (developer reads `last_task: true` set by architect)
```

The two file groups can be implemented in parallel. A3 is a prerequisite for D1 and D3 to work end-to-end, but each prompt change is self-contained — the developer prompt documents what `tdd: true` and `last_task: true` mean regardless of whether the architect sets them.
