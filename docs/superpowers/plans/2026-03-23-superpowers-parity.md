# Superpowers Parity — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework neo's default agent configuration to match superpowers' discipline — enriched prompts, subagent review within sessions, blocking decision polling, simplified supervisor.

**Architecture:** 4 agents (architect, developer, reviewer, scout) with enriched prompts. Architect and developer get the Agent tool for spawning internal reviewers. `neo decision create --wait` enables blocking inter-agent communication. Supervisor simplified to dispatch + strategy + decision routing.

**Tech Stack:** TypeScript, Claude Agent SDK, citty (CLI), YAML agent configs, Markdown prompts

**Spec:** `docs/superpowers/specs/2026-03-23-superpowers-parity-design.md`

---

## Task 1: Delete fixer and refiner agents

**Files:**
- Delete: `packages/agents/agents/fixer.yml`
- Delete: `packages/agents/agents/refiner.yml`
- Delete: `packages/agents/prompts/fixer.md`
- Delete: `packages/agents/prompts/refiner.md`

- [ ] **Step 1: Delete the 4 files**

```bash
rm packages/agents/agents/fixer.yml
rm packages/agents/agents/refiner.yml
rm packages/agents/prompts/fixer.md
rm packages/agents/prompts/refiner.md
```

- [ ] **Step 2: Verify no build breakage**

Run: `pnpm build && pnpm typecheck`
Expected: PASS — these are data files, no TypeScript imports reference them.

- [ ] **Step 3: Commit**

```bash
git add -A packages/agents/agents/fixer.yml packages/agents/agents/refiner.yml packages/agents/prompts/fixer.md packages/agents/prompts/refiner.md
git commit -m "chore(agents): remove fixer and refiner agents

Fixer replaced by re-dispatching developer with review feedback.
Refiner absorbed into architect as triage step 0.

See docs/superpowers/specs/2026-03-23-superpowers-parity-design.md"
```

---

## Task 2: Update agent YAML configs (maxTurns + Agent tool)

**Files:**
- Modify: `packages/agents/agents/architect.yml`
- Modify: `packages/agents/agents/developer.yml`
- Modify: `packages/agents/agents/reviewer.yml`
- Modify: `packages/agents/agents/scout.yml`

- [ ] **Step 1: Update architect.yml**

Add `Agent` to tools, add `maxTurns: 75`:

```yaml
name: architect
description: "Strategic planner. Analyzes features, designs architecture, decomposes work into atomic tasks. Handles triage (replaces refiner). Spawns spec-reviewer subagents. Never writes code."
model: opus
tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - Agent
sandbox: readonly
maxTurns: 75
prompt: ../prompts/architect.md
```

- [ ] **Step 2: Update developer.yml**

Add `Agent` to tools, add `maxTurns: 100`:

```yaml
name: developer
description: "Implementation worker. Executes atomic tasks in isolated clones. Spawns spec-compliance and code-quality reviewer subagents. Self-reviews and verifies before reporting."
model: opus
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
sandbox: writable
maxTurns: 100
prompt: ../prompts/developer.md
```

- [ ] **Step 3: Update reviewer.yml**

Add `maxTurns: 30`:

```yaml
name: reviewer
description: "Two-pass reviewer: spec compliance first, then code quality. Challenges by default. Read-only — never modifies files."
model: sonnet
tools:
  - Read
  - Glob
  - Grep
  - Bash
sandbox: readonly
maxTurns: 30
prompt: ../prompts/reviewer.md
```

- [ ] **Step 4: Update scout.yml**

Add `maxTurns: 50`:

```yaml
name: scout
description: "Autonomous codebase explorer. Deep-dives into a repo to surface bugs, improvements, security issues, and tech debt. Creates decisions for the user."
model: opus
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - WebSearch
  - WebFetch
sandbox: readonly
maxTurns: 50
prompt: ../prompts/scout.md
```

- [ ] **Step 5: Verify build**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agents/agents/
git commit -m "feat(agents): add Agent tool and maxTurns to architect/developer

- architect: +Agent tool, maxTurns 75, updated description (triage, subagent review)
- developer: +Agent tool, maxTurns 100, updated description (self-review, subagent review)
- reviewer: maxTurns 30, updated description (two-pass)
- scout: maxTurns 50"
```

---

## Task 3: Enable maxTurns pass-through in session runner

**Files:**
- Modify: `packages/core/src/runner/session.ts:60`

- [ ] **Step 1: Uncomment maxTurns line**

In `buildQueryOptions`, change line ~60 from:
```typescript
// maxTurns: agent.maxTurns,
```
to:
```typescript
...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
```

Check how `maxTurns` flows from agent config to session options. Read `session-executor.ts` to see where `SessionOptions` is built, and ensure `maxTurns` is passed through from the resolved agent.

- [ ] **Step 2: Verify the resolved agent's maxTurns reaches SessionOptions**

Read `packages/core/src/runner/session-executor.ts` and trace the flow. If `maxTurns` is not in `SessionOptions`, add it to the interface and pass it from the resolved agent.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: PASS (existing tests should still work — agents without maxTurns get no limit)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runner/
git commit -m "feat(runner): enable maxTurns pass-through to SDK

Uncomment and connect agent maxTurns to sdk.query() options.
Previously disabled during early development — now safe to enable
since agent YAML configs set appropriate per-role limits."
```

---

## Task 4: Add `--wait` and `--timeout` to `neo decision create`

**Files:**
- Modify: `packages/cli/src/commands/decision.ts`

- [ ] **Step 1: Add `--wait` and `--timeout` args to the command definition**

In the `args` section of `defineCommand`, add:
```typescript
wait: {
  type: "boolean",
  alias: "w",
  description: "Block until the decision is answered (poll every 10s)",
  default: false,
},
timeout: {
  type: "string",
  description: "Max wait time when using --wait (e.g. 30m, 1h). Default: 30m",
  default: "30m",
},
```

Add to `ParsedArgs`:
```typescript
wait: boolean;
timeout: string;
```

- [ ] **Step 2: Implement the poll loop in handleCreate**

After the existing `store.create()` call and `printSuccess`, add:

```typescript
if (parsed.wait) {
  const timeoutMs = parseDurationMs(parsed.timeout) ?? 30 * 60 * 1000;
  const startTime = Date.now();
  const pollIntervalMs = 10_000;

  // Suppress the default success output — we'll print the answer instead
  process.stdout.write(`Waiting for answer (timeout: ${parsed.timeout})...\n`);

  const poll = async (): Promise<void> => {
    while (Date.now() - startTime < timeoutMs) {
      const decision = await store.get(id);
      if (decision?.answer !== undefined) {
        console.log(`\nAnswer: ${decision.answer}`);
        if (decision.context) {
          console.log(`Context: ${decision.context}`);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    // Timeout
    printError(`Decision ${id} timed out after ${parsed.timeout}`);
    process.exitCode = 1;
  };

  await poll();
}
```

- [ ] **Step 3: Wire the new args through ParsedArgs in the run function**

```typescript
wait: args.wait as boolean,
timeout: args.timeout as string,
```

- [ ] **Step 4: Test manually**

```bash
# Terminal 1: create with --wait
pnpm neo decision create "Test question" --options "yes:Yes,no:No" --wait --timeout 1m

# Terminal 2: answer it
pnpm neo decision answer <id> yes
```

Expected: Terminal 1 prints the answer and exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/decision.ts
git commit -m "feat(cli): add --wait and --timeout to neo decision create

When --wait is passed, the CLI polls the decision store every 10s
until the decision is answered or the timeout is reached.
Enables blocking inter-agent communication via decision polling."
```

---

## Task 5: Rewrite architect.md prompt

**Files:**
- Modify: `packages/agents/prompts/architect.md`

- [ ] **Step 1: Read the current architect.md and the spec**

Read:
- `packages/agents/prompts/architect.md` (current)
- `docs/superpowers/specs/2026-03-23-superpowers-parity-design.md` (section 1)

- [ ] **Step 2: Rewrite the prompt**

Replace the entire file with the enriched version. The new prompt must include:
1. Original role definition (analyzes features, designs architecture, decomposes work, NEVER writes code)
2. **NEW — Triage section** (score 1-5, replaces refiner, with examples per level)
3. Original Protocol sections (Analyze, Design, Decompose) — keep unchanged
4. **NEW — Design-first exploration** (explore codebase first, decision poll if ambiguous, 2-3 approaches)
5. **NEW — Spec document** (write to `.neo/specs/{ticket-id}-design.md`)
6. **NEW — Spec review loop** (spawn spec-document-reviewer subagent via Agent tool, inline prompt template, max 3 iterations)
7. **NEW — Plan quality discipline** (2-5 min tasks, exact file paths, exact code, expected output)
8. **NEW — Execution strategy** (parallel_groups, model_hints in JSON output)
9. **NEW — Decision polling** (use existing CLI interface with `--wait`)
10. Original Output JSON — extended with `strategy` field
11. Original Escalation section — unchanged
12. Original Rules section — unchanged

- [ ] **Step 3: Verify the prompt is syntactically valid markdown**

Read back the file, check no broken formatting.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/prompts/architect.md
git commit -m "feat(agents): rewrite architect prompt with superpowers disciplines

Add triage (replaces refiner), design-first exploration, spec document
output, spec-reviewer subagent spawning, plan quality discipline,
execution strategy (parallel_groups, model_hints), decision polling."
```

---

## Task 6: Enrich developer.md prompt

**Files:**
- Modify: `packages/agents/prompts/developer.md`

- [ ] **Step 1: Read the current developer.md and the spec**

Read:
- `packages/agents/prompts/developer.md` (current — keep Protocol sections 1-6 unchanged)
- `docs/superpowers/specs/2026-03-23-superpowers-parity-design.md` (section 2)

- [ ] **Step 2: Append the disciplines section**

Keep the existing prompt intact. Append after `## Rules` a new `## Disciplines` section containing:
1. **Self-review checklist** (completeness, quality, YAGNI, test anti-patterns)
2. **Spawning reviewers** (spec-compliance-reviewer prompt template, code-quality-reviewer prompt template, max 3 iterations each, spec MUST pass before quality)
3. **Handling review feedback** (READ → VERIFY → EVALUATE → clarify/pushback/fix, no performative agreement)
4. **Systematic debugging** (Phase 1-4 + Phase 4.5 architectural escalation via decision poll)
5. **Verification before completion** (iron law, gate function, claims table, red flags)
6. **Decision polling** (when blocked — don't guess, don't assume)
7. **Status protocol** (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT with extended JSON output)

- [ ] **Step 3: Update the Report JSON output (section 6)**

Change existing `"status": "completed | failed | escalated"` to `"status": "DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT"` and add `"concerns"` and `"evidence"` fields.

- [ ] **Step 4: Read back and verify**

Read the full file, ensure no formatting issues and existing sections are intact.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/prompts/developer.md
git commit -m "feat(agents): enrich developer prompt with superpowers disciplines

Append: self-review checklist, subagent reviewer spawning (spec
compliance + code quality), handling review feedback, systematic
debugging (4 phases + architectural escalation), verification-before-
completion (iron law), decision polling, 4-status protocol."
```

---

## Task 7: Enrich reviewer.md prompt

**Files:**
- Modify: `packages/agents/prompts/reviewer.md`

- [ ] **Step 1: Read the current reviewer.md and the spec**

Read:
- `packages/agents/prompts/reviewer.md` (current)
- `docs/superpowers/specs/2026-03-23-superpowers-parity-design.md` (section 3)

- [ ] **Step 2: Add two-pass structure**

Insert before the existing `## Protocol` section a new discipline section that reframes the review as two sequential passes:

1. **PASS 1 — Spec Compliance** (read spec document, compare to implementation line by line, do NOT trust developer report, flag deviations as CRITICAL, if FAIL → CHANGES_REQUESTED immediately)
2. **PASS 2 — Code Quality** (only after spec compliance passes, apply existing 5-lens review as-is)

Update the Protocol to reference these two passes.

- [ ] **Step 3: Update the Output JSON**

Add `"spec_compliance": "PASS | FAIL"` and `"spec_deviations"` array to the output schema.

Update verdict logic: `spec_compliance FAIL → CHANGES_REQUESTED (always)`.

- [ ] **Step 4: Read back and verify**

Ensure existing 5-lens content is preserved in Pass 2.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/prompts/reviewer.md
git commit -m "feat(agents): add two-pass review to reviewer prompt

Pass 1: spec compliance (read code, compare to spec line by line).
Pass 2: code quality (existing 5-lens review, only after spec passes).
Added spec_compliance and spec_deviations to output schema."
```

---

## Task 8: Update SUPERVISOR.md

**Files:**
- Modify: `packages/agents/SUPERVISOR.md`

- [ ] **Step 1: Read the current file**

Read `packages/agents/SUPERVISOR.md` fully.

- [ ] **Step 2: Update Available Agents table**

Remove fixer and refiner rows. Update architect description ("Triage + design + plan. Spawns spec-reviewer subagents.") and developer description ("Implements + self-reviews + spawns spec/quality reviewers.").

- [ ] **Step 3: Update Agent Output Contracts**

- Remove `### fixer →` section entirely
- Remove `### refiner →` section entirely
- Update `### developer →` to use new status protocol:
  - `DONE` + `PR_URL` → extract PR, check CI
  - `DONE_WITH_CONCERNS` → evaluate concerns, decide next action
  - `BLOCKED` → route via decision system
  - `NEEDS_CONTEXT` → provide context, re-dispatch
- Update `### architect →` to include `strategy` field (parallel_groups, model_hints)
- Update `### reviewer →` to include `spec_compliance` field

- [ ] **Step 4: Update Routing table**

Change "Unclear criteria or vague scope → Dispatch refiner" to "Unclear criteria or vague scope → Dispatch architect (handles triage)".
Remove all fixer dispatch references.

- [ ] **Step 5: Remove On Refiner Completion and On Fixer Completion sections**

Delete sections §3 and §7 entirely.

- [ ] **Step 6: Update remaining protocol sections**

- §4/§5 On Developer Completion: remove "/Fixer" from title, remove fixer references, add DONE_WITH_CONCERNS and NEEDS_CONTEXT handling
- §6 On Review Completion: change "dispatch fixer" → "re-dispatch developer with review feedback as context"
- Pipeline State Machine: remove "fixing" state, simplify to `in review → developer re-dispatch → in review`

- [ ] **Step 7: Add new sections**

Add:
- **Execution Strategy**: how supervisor interprets architect's parallel_groups and model_hints, dispatches developer groups, verifies no file overlap
- **Decision Routing**: how supervisor handles pending decisions (direct answer, scout investigation, human escalation)

- [ ] **Step 8: Update Idle Behavior**

Remove fixer/refiner references from missed dispatch checks. Add: "check for pending decisions not yet answered".

- [ ] **Step 9: Update Safety Guards**

Change "fixer→review cycles" → "developer re-dispatch cycles".
Change "fixer reports ESCALATED" → "developer reports BLOCKED".

- [ ] **Step 10: Update dispatch examples**

Remove fixer example. Add example with model override if applicable. Update routing example to show architect handling vague tickets.

- [ ] **Step 11: Commit**

```bash
git add packages/agents/SUPERVISOR.md
git commit -m "refactor(agents): update SUPERVISOR.md for superpowers parity

Remove fixer/refiner sections. Update developer contract to 4-status
protocol. Add architect execution strategy. Add decision routing and
parallel dispatch guardrails. Simplify pipeline state machine."
```

---

## Task 9: Update README.md and GUIDE.md

**Files:**
- Modify: `packages/agents/README.md`
- Modify: `packages/agents/GUIDE.md`

- [ ] **Step 1: Update README.md**

- Remove fixer.yml, fixer.md, refiner.yml, refiner.md from directory tree
- Remove fixer and refiner rows from Built-in Agents table
- Update architect row: add Agent to tools, update description
- Update developer row: add Agent to tools, update description
- Change "5 built-in agents" to "4 built-in agents" in intro text

- [ ] **Step 2: Update GUIDE.md**

- Remove all fixer/refiner references (agent table, dispatch examples, pipeline description)
- Update the supervisor lifecycle description: "refine → architect → develop → review → fix → done" becomes "architect (triage + design) → develop (with self-review) → review (if needed) → done"
- Update the fixer dispatch example to show developer re-dispatch with feedback

- [ ] **Step 3: Commit**

```bash
git add packages/agents/README.md packages/agents/GUIDE.md
git commit -m "docs(agents): update README and GUIDE for superpowers parity

Remove fixer/refiner references. Update agent table with new tools
and descriptions. Simplify pipeline description."
```

---

## Task 10: Update tests

**Files:**
- Modify: `packages/core/src/__tests__/agents.test.ts`
- Modify: `packages/core/src/__tests__/e2e.test.ts`

- [ ] **Step 1: Update agents.test.ts**

At line 581, change:
```typescript
expect(registry.list().length).toBe(6);
```
to:
```typescript
expect(registry.list().length).toBe(4);
```

Remove lines 584 and 586:
```typescript
expect(registry.has("refiner")).toBe(true);
expect(registry.has("fixer")).toBe(true);
```

- [ ] **Step 2: Update e2e.test.ts**

- Remove `FIXER_PROMPT` constant (line 86)
- Remove `writeFile(path.join(PROMPTS_DIR, "fixer.md"), FIXER_PROMPT)` (line 96)
- Remove the fixer YAML fixture write block (lines 145-158)
- Remove `expect(registry.has("fixer")).toBe(true)` (line 266)

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/
git commit -m "test(core): update agent tests for fixer/refiner removal

Remove fixer and refiner from built-in agent assertions and e2e
test fixtures. Agent count 6 → 4."
```

---

## Task 11: Update supervisor prompt-builder.ts

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`

- [ ] **Step 1: Read the file**

Read `packages/core/src/supervisor/prompt-builder.ts` fully.

- [ ] **Step 2: Add decision routing to OPERATING_PRINCIPLES**

Add after the "No duplicate dispatches" paragraph:

```typescript
- **Decision routing**: when a pending decision arrives from an agent, answer within 1-2 heartbeats. Route: (1) answer directly if strategic/scope/priority, (2) dispatch scout to investigate if codebase context needed, (3) wait for human if autoDecide is off or genuinely uncertain. Agents are BLOCKED waiting — stale decisions waste session budget.
- **Parallel dispatch guardrails**: before dispatching tasks in parallel, verify zero file overlap and zero depends_on between them. After ALL parallel tasks complete, run full test suite before proceeding to next group.
```

- [ ] **Step 3: Add DECISIONS step to HEARTBEAT_RULES**

In the `<decision-tree>` section, add between step 5 (FOLLOW-UPS) and step 6 (DISPATCH):

```
5b. DECISIONS? — check \`neo decision list\` for pending decisions from agents. Route each: answer directly, dispatch scout to investigate, or wait for human.
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/prompt-builder.ts
git commit -m "feat(supervisor): add decision routing and parallel dispatch guardrails

Add decision routing rules to operating principles: answer within
1-2 heartbeats, route via direct/scout/human. Add parallel dispatch
guardrails: verify file overlap, run full suite after parallel group."
```

---

## Task 12: Full validation pass

- [ ] **Step 1: Build + typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Verify agent count**

Run: `ls packages/agents/agents/`
Expected: `architect.yml  developer.yml  reviewer.yml  scout.yml` (4 files)

Run: `ls packages/agents/prompts/`
Expected: `architect.md  developer.md  reviewer.md  scout.md` (4 files)

- [ ] **Step 4: Verify no stale fixer/refiner references in prompts**

Run: `grep -r "fixer\|refiner" packages/agents/prompts/`
Expected: No output

- [ ] **Step 5: Commit validation (if any fixes needed)**

---

## Execution Strategy

### Parallel groups

- **Group 1** (independent, no file overlap): Tasks 1, 3, 4
  - Task 1: Delete fixer/refiner files
  - Task 3: Enable maxTurns in session runner
  - Task 4: Add --wait to decision CLI

- **Group 2** (depends on Task 1): Tasks 2, 5, 6, 7
  - Task 2: Update agent YAML configs
  - Task 5: Rewrite architect.md
  - Task 6: Enrich developer.md
  - Task 7: Enrich reviewer.md

- **Group 3** (depends on Group 2): Tasks 8, 9, 10, 11
  - Task 8: Update SUPERVISOR.md
  - Task 9: Update README.md and GUIDE.md
  - Task 10: Update tests
  - Task 11: Update supervisor prompt-builder.ts

- **Group 4** (depends on all): Task 12
  - Full validation pass

### Model hints

| Task | Model | Reason |
|------|-------|--------|
| 1 | haiku | File deletion only |
| 2 | haiku | YAML edits, mechanical |
| 3 | sonnet | TypeScript, trace code flow |
| 4 | sonnet | TypeScript, new CLI feature |
| 5 | opus | Large prompt rewrite, architectural judgment |
| 6 | opus | Large prompt enrichment, multiple disciplines |
| 7 | sonnet | Moderate prompt enrichment |
| 8 | opus | Large doc rewrite, many sections |
| 9 | sonnet | Doc updates, mechanical |
| 10 | haiku | Test assertion updates, mechanical |
| 11 | sonnet | TypeScript string additions |
| 12 | haiku | Run commands, verify output |
