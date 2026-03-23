# Prompt Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich architect.md and developer.md with superpowers-inspired disciplines (TDD opt-in, review feedback, branch completion, design gate, parallel safety, task flags).

**Architecture:** Direct markdown prompt edits — no code changes, no schema changes, no new files beyond the two prompts.

**Tech Stack:** Markdown only. Two files: `packages/agents/prompts/architect.md`, `packages/agents/prompts/developer.md`.

**Spec:** `docs/superpowers/specs/2026-03-23-prompt-enrichment-design.md`

## Execution Order

**Tasks 1, 2, 3** (developer.md) and **Task 4** (architect.md) can run in any order or in parallel.

**Task 4 MUST complete before Tasks 5 and 6** — Task 4 renumbers Decompose (6→7) and Execution Strategy (7→8). Tasks 5 and 6 reference the renumbered sections.

**Recommended order:** Tasks 1-3 in parallel with Task 4, then Tasks 5 and 6 after Task 4.

---

## Task 1: Add TDD opt-in to developer.md (D1)

**Files:**
- Modify: `packages/agents/prompts/developer.md:43-50` (Protocol > 2. Implement)

- [ ] **Step 1: Replace the Implement section**

Replace lines 43-50 (the current `### 2. Implement` section) with:

```markdown
### 2. Implement

**If the task spec includes `tdd: true`**, follow the Red-Green-Refactor cycle:

1. **RED** — Write ONE minimal failing test for the next behavior
2. Run the test (`pnpm test -- {test-file}`) — verify it FAILS. If it passes, the test is wrong.
3. **GREEN** — Write the MINIMUM code to make it pass
4. Run the test — verify it PASSES
5. **REFACTOR** — Clean up without changing behavior, verify still green
6. Repeat for the next behavior

Do NOT write all tests upfront. One test at a time.

**Otherwise**, apply changes in order: types → logic → exports → tests → config.

In both modes:
- One edit at a time. Read back after each edit.
- Follow observed patterns exactly — do not introduce new ones.
- Only add "why" comments for truly non-obvious logic.
- Do NOT touch code outside the task scope.
```

- [ ] **Step 2: Verify the edit**

Read the file back. Confirm:
- The TDD conditional block is present before the standard order
- The 4 bullet points (one edit, patterns, comments, scope) are preserved after both branches
- No duplicate content, no broken markdown

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/developer.md
git commit -m "feat(agents): add TDD opt-in mode to developer prompt

When task spec includes tdd: true, developer follows Red-Green-Refactor
cycle instead of the standard types → logic → exports → tests order.

Generated with [neo](https://neotx.dev)"
```

---

## Task 2: Replace Handling Review Feedback in developer.md (D2)

**Files:**
- Modify: `packages/agents/prompts/developer.md:193-205` (Disciplines > Handling Review Feedback)

- [ ] **Step 1: Replace the Handling Review Feedback section**

Replace lines 193-205 (from `### Handling Review Feedback` through `Never express performative agreement...`) with:

```markdown
### Handling Review Feedback

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

- [ ] **Step 2: Verify the edit**

Read the file back. Confirm:
- 7 numbered steps (READ, RESTATE, VERIFY, EVALUATE, unclear, wrong, correct)
- Anti-patterns section with 4 bullets
- The old "Never implement..." and "Never express performative..." lines are gone (absorbed into anti-patterns)
- `### Systematic Debugging` follows immediately after

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/developer.md
git commit -m "feat(agents): reinforce review feedback handling in developer prompt

Add RESTATE step and explicit anti-patterns for receiving code review.
Replaces the previous 6-step version with a more rigorous 7-step process.

Generated with [neo](https://neotx.dev)"
```

---

## Task 3: Add Branch Completion to developer.md (D3)

**Files:**
- Modify: `packages/agents/prompts/developer.md` — append after the Status Protocol section (after line 291)

- [ ] **Step 1: Append the Branch Completion section**

Add the following after the `### Status Protocol` section (end of file). Locate the last line of the file (currently `- **NEEDS_CONTEXT** — spec is unclear or incomplete...`) and append after it.

The raw text to insert (copy verbatim into the file):

    ### Branch Completion

    When the task spec includes `last_task: true`, present completion options in your report.

    Add a `branch_completion` field to the Report JSON:

    ```json
    {
      "task_id": "T3",
      "status": "DONE",
      "evidence": { "command": "pnpm test", "exit_code": 0, "summary": "34/34 passing" },
      "commit": "abc1234",
      "branch_completion": {
        "branch": "feat/auth-middleware",
        "commits": 3,
        "tests": "all passing",
        "options": ["push", "pr", "keep", "discard"],
        "recommendation": "pr",
        "reason": "Feature complete, all acceptance criteria met"
      }
    }
    ```

    Without `last_task: true` in the task spec, skip this section entirely.

    Rules:
    - NEVER merge branches — only the supervisor decides merges
    - NEVER discard without explicit supervisor approval
    - Always include a recommendation with reasoning
    - If the branch has failing tests, the only valid option is "keep"

- [ ] **Step 2: Verify the edit**

Read the end of the file. Confirm:
- `### Branch Completion` section exists after `### Status Protocol`
- JSON example shows `branch_completion` nested in the existing report structure
- 4 rules listed
- File ends cleanly

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/developer.md
git commit -m "feat(agents): add branch completion workflow to developer prompt

Developer presents completion options (push/pr/keep/discard) with
recommendation when task spec includes last_task: true. Supervisor decides.

Generated with [neo](https://neotx.dev)"
```

---

## Task 4: Add Design Approval Gate to architect.md (A1)

**Files:**
- Modify: `packages/agents/prompts/architect.md:71-73` (between Spec Review Loop and Decompose)

- [ ] **Step 1: Insert the Design Approval Gate**

Between line 71 (`If issues → fix and re-spawn. Max 3 iterations.`) and line 73 (`### 6. Decompose`), insert:

```markdown

### 6. Design Approval Gate

After the spec review loop passes, submit the design for supervisor approval:

```bash
neo decision create "Design approval for {ticket-id}" \
  --type approval \
  --context "Summary: {1-3 sentences}
Approach: {chosen approach with reasoning}
Alternatives rejected: {list with why}
Components: {list}
Risks: {list}
Files affected: {count new + count modified}
Estimated tasks: {count}
Spec: .neo/specs/{ticket-id}-design.md" \
  --wait --timeout 30m
```

Handle response:
- **Approved** → proceed to decomposition
- **Approved with changes** → update spec, re-run spec review loop (counter resets), then decompose
- **Rejected** → revise approach from step 3 (Design)

Max 2 gate cycles. After 2 rejections, escalate with full context of what was tried.
```

- [ ] **Step 2: Renumber Decompose and Execution Strategy**

Change `### 6. Decompose` to `### 7. Decompose` and `### 7. Execution Strategy` to `### 8. Execution Strategy`.

- [ ] **Step 3: Verify the edit**

Read the file. Confirm:
- Steps are numbered 1-8 (Analyze, Explore, Design, Spec Document, Spec Review Loop, **Design Approval Gate**, Decompose, Execution Strategy)
- The `neo decision create` command block is properly formatted
- The 3 response handlers are present
- Max 2 gate cycles mentioned

- [ ] **Step 4: Commit**

```bash
git add packages/agents/prompts/architect.md
git commit -m "feat(agents): add design approval gate to architect prompt

Architect submits design to supervisor via decision poll before
decomposing into tasks. Max 2 gate cycles, then escalate.

Generated with [neo](https://neotx.dev)"
```

---

## Task 5: Add task spec flags to architect.md Decompose (A3)

**Files:**
- Modify: `packages/agents/prompts/architect.md` — the "Per task, specify" list in Decompose (now step 7)

**Prerequisite:** Task 4 must be completed first (renumbering makes Decompose step 7).

- [ ] **Step 1: Add flags field**

In the Decompose section (now `### 7. Decompose`), find the line that reads:

    - **size**: XS / S / M (L or bigger → split further)

Add immediately after it:

    - **flags** (optional): `tdd: true` for complex logic tasks, `last_task: true` for the final task in a milestone

- [ ] **Step 2: Update the JSON output schema**

In the `## Output` section, find the task object in the JSON example. It currently ends with `"size": "S"`. Add a `flags` field after it. The updated task object should be:

```json
{
  "id": "T1",
  "title": "Imperative task title",
  "files": ["src/path.ts"],
  "depends_on": [],
  "acceptance_criteria": ["criterion"],
  "size": "S",
  "flags": {}
}
```

`flags` is an empty object `{}` by default. The architect populates it when needed (e.g., `{ "tdd": true }` or `{ "last_task": true }`).

- [ ] **Step 3: Verify the edit**

Read the Decompose section and Output section. Confirm:
- `flags` field listed in "Per task, specify"
- `flags` field present in JSON output schema
- No other changes to the section

- [ ] **Step 4: Commit**

```bash
git add packages/agents/prompts/architect.md
git commit -m "feat(agents): add task spec flags to architect decompose step

Architect can annotate tasks with optional flags: tdd (for complex logic)
and last_task (for branch completion triggers).

Generated with [neo](https://neotx.dev)"
```

---

## Task 6: Enrich Execution Strategy in architect.md (A2)

**Files:**
- Modify: `packages/agents/prompts/architect.md` — Execution Strategy section (now step 8)

- [ ] **Step 1: Replace the Execution Strategy section**

Replace the current Execution Strategy content (from `### 8. Execution Strategy` through `Sequential groups execute in order...`) with:

```markdown
### 8. Execution Strategy

Recommend an execution strategy:
- Which tasks can run in parallel (no file overlap, no dependencies)
- Which tasks must be sequential (depends_on chains)
- Suggested model per task: `haiku` (mechanical, 1-2 files), `sonnet` (integration, multi-file), `opus` (architecture, broad codebase)

**Parallel safety checklist** — before placing tasks in the same group, verify:
- [ ] Zero shared files (not even read-only — avoids merge conflicts on adjacent lines)
- [ ] Zero shared exports (barrel files, index.ts, route registrations)
- [ ] No implicit ordering (task B won't fail if task A hasn't run yet)
- [ ] Independent test files (no shared test fixtures or setup)

If ANY check fails, move tasks to sequential groups.

**Integration task** — when parallel tasks produce artifacts that must connect:
- Add a final "wiring" task that depends on ALL parallel tasks
- Wiring task handles: barrel exports, route registration, config updates, shared types
- Size this task explicitly (it often grows — if M or larger, split it)

Tasks in the same parallel group MUST have zero file overlap and zero depends_on between them.
Sequential groups execute in order (group 2 waits for group 1 to complete).
```

- [ ] **Step 2: Verify the edit**

Read the section back. Confirm:
- Parallel safety checklist with 4 checkbox items
- Integration task subsection with 3 bullets
- Original model hints preserved (haiku/sonnet/opus)
- Original parallel/sequential rules preserved at end

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/architect.md
git commit -m "feat(agents): add parallel safety checklist to architect execution strategy

Adds explicit verification checklist before parallel grouping and
formalizes the wiring/integration task requirement.

Generated with [neo](https://neotx.dev)"
```

---

## Task 7: Final verification

**Files:**
- Read: `packages/agents/prompts/architect.md`
- Read: `packages/agents/prompts/developer.md`

- [ ] **Step 1: Verify architect.md structure**

Read the full file. Confirm:
- Protocol steps numbered 1-8 without gaps: Analyze, Explore, Design, Spec Document, Spec Review Loop, Design Approval Gate, Decompose, Execution Strategy
- `### 6. Design Approval Gate` exists between Spec Review Loop and Decompose
- `neo decision create` command block is properly formatted (no broken markdown)
- Decompose section has `flags` in "Per task, specify" list
- Output JSON schema includes `"flags": {}`
- Execution Strategy has parallel safety checklist (4 items) and integration task subsection

- [ ] **Step 2: Verify developer.md structure**

Read the full file. Confirm:
- `### 2. Implement` starts with TDD conditional (`If the task spec includes tdd: true`)
- Standard order (`types → logic → exports → tests → config`) is the `Otherwise` branch
- `### Handling Review Feedback` has 7 numbered steps (READ through correct)
- Anti-patterns section with 4 bullets follows the 7 steps
- `### Branch Completion` exists after `### Status Protocol`
- Branch completion JSON example shows `branch_completion` nested in report
- All code blocks are properly closed (no orphaned triple backticks)

- [ ] **Step 3: Cross-file coherence**

Verify:
- architect.md mentions `tdd: true` and `last_task: true` in flags → developer.md references both
- architect.md Design Approval Gate references `neo decision create` → consistent with existing Decision Polling sections in both files
- No contradictions between the two files
