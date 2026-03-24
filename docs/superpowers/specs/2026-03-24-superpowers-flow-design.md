# Superpowers Flow — Design Specification

## Summary

Remodel neo's architect and developer agents to reproduce the superpowers workflow. The architect produces ultra-detailed implementation plans (writing-plans style). The developer receives the plan and executes it task-by-task with two-stage subagent review (subagent-driven-development style). Subagents are injected via the SDK `agents` parameter, configured in agent YAML.

### Approach chosen

Single PR — all three workstreams (core, prompts, SUPERVISOR.md) land together. The change is conceptually atomic: a new paradigm for how agents plan and execute work.

### Alternatives rejected

- **Core first, prompts later** (2 PRs): the core `agents` field is useless without YAML declarations. Creates an intermediate state with no value.
- **Prompts first, core later** (2 PRs): prompts would keep ad-hoc reviewer subagent prompts, then need migration. Two passes on the same files.

---

## Decisions (from brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Developer dual mode | Yes — plan mode (`.neo/specs/*.md`) or direct mode (prompt) |
| 2 | Architect writes code in plans | Yes — rule "NEVER write code" lifted for plan files |
| 3 | Decision polling | Architect only — developer follows plan or reports BLOCKED |
| 4 | Branch completion | Developer presents 4 options (merge/pr/keep/discard) in report, supervisor decides |
| 5 | Plan delivery | Developer reads plan via Read tool. If no plan file, plan can be inline in prompt |
| 6 | Plan location | `.neo/specs/{ticket-id}-plan.md` |
| 7 | Subagent injection | Via SDK `agents` parameter, declared in agent YAML |

---

## Workstream 1: Core — SDK `agents` support

**Goal**: Allow agent YAML to declare subagents that flow through to `sdk.query({ options: { agents } })`.

### 1.1 Schema — `packages/core/src/agents/schema.ts`

New `subagentDefinitionSchema`:

```typescript
export const subagentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),              // inline text or path to .md file
  tools: z.array(agentToolSchema).optional(),
  model: agentModelSchema.optional(),
});
```

Add to `agentConfigSchema`:

```typescript
agents: z.record(z.string(), subagentDefinitionSchema).optional(),
```

### 1.2 Types — `packages/core/src/types.ts`

New interface (uses `string[]` for tools to match SDK passthrough — the Zod schema validates, but the interface stores the resolved strings):

```typescript
export interface SubagentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}
```

Add to `AgentDefinition`:

```typescript
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
  mcpServers?: string[];
  agents?: Record<string, SubagentDefinition>;  // NEW
}
```

**Note:** The SDK also exports an `AgentDefinition` type. Use an import alias (e.g. `import type { AgentDefinition as SDKAgentDefinition }`) if both are needed in the same file. In practice, neo's `SubagentDefinition` maps 1:1 to the SDK's `AgentDefinition` — no conversion needed at passthrough.

### 1.3 Loader — `packages/core/src/agents/loader.ts`

After loading the main agent prompt, iterate `config.agents` entries. For each subagent whose `prompt` field ends with `.md`, resolve the path relative to the YAML file and read its contents (same `readFile` pattern as the main prompt).

### 1.4 Resolver — `packages/core/src/agents/resolver.ts`

New `mergeAgents()` function (parallel to existing `mergeTools()`):
- Union of base agents + override agents
- Override wins on name collision (same name = full replacement)
- No `$inherited` token needed — agents always merge additively unless overridden by name

Wire into both `resolveExtendedAgent` and `resolveCustomAgent`. Pass `agents` through to `AgentDefinition`.

### 1.5 Session — `packages/core/src/runner/session.ts`

In `buildQueryOptions()`, after the `mcpServers` block:

```typescript
if (options.agents && Object.keys(options.agents).length > 0) {
  queryOptions.agents = options.agents;
}
```

Thread `agents` from `agent.definition.agents` through `SessionOptions`.

### 1.6 Tests — `packages/core/src/__tests__/agents.test.ts`

- Schema: `agents` field parses correctly (with inline prompt + with .md path)
- Resolver: agents merge with extends (base + override, override wins on collision)
- Session: agents appear in queryOptions when present, absent when not

---

## Workstream 2: Prompts — Superpowers-aligned

### 2.1 Architect — `packages/agents/prompts/architect.md` (rewrite)

**New protocol:**

1. **Triage** — score 1-5 (kept from current). Decision poll for scores 2-3.
2. **Analyze** — goal, scope, dependencies, risks (kept).
3. **Explore** — Glob/Grep, read patterns and conventions (kept).
4. **Design + Approval Gate** — 2-3 approaches with trade-offs. Submit chosen design via `neo decision create` for supervisor approval. Max 2 gate cycles.
5. **Write Plan** — replaces Decompose + Execution Strategy. Produces a plan document in `.neo/specs/{ticket-id}-plan.md` with:
   - **Header**: Goal (1 sentence), Architecture (2-3 sentences), Tech Stack
   - **File structure mapping**: all files to create/modify with responsibilities
   - **Tasks** in superpowers format:
     ```markdown
     ### Task N: [Component Name]
     **Files:**
     - Create: `exact/path/to/file.ts`
     - Modify: `exact/path/to/existing.ts`
     - Test: `exact/path/to/test.ts`

     - [ ] Step 1: Write failing test (full code)
     - [ ] Step 2: Run test, verify fails (exact command + expected output)
     - [ ] Step 3: Write minimal implementation (full code)
     - [ ] Step 4: Run test, verify passes
     - [ ] Step 5: Commit (exact git command)
     ```
   - Granularity: 2-5 min per step, complete code, exact commands, expected outputs
6. **Plan Review Loop** — spawn `plan-reviewer` subagent (via SDK agents), max 3 iterations.
7. **Report** — output plan file path + summary to supervisor.

**Key rule changes:**
- "NEVER write code" → "Write complete code in plan documents. NEVER write code to source files."
- "NEVER modify files" → "ONLY write to `.neo/specs/` files."
- Output format: plan file path + summary (no more JSON `milestones[].tasks[]`)

**Rules kept:**
- Readonly mode for codebase (reads, never writes source files)
- Read codebase before designing
- Validate file paths exist
- Decision polling for ambiguity (scores 2-3)

### 2.2 Developer — `packages/agents/prompts/developer.md` (rewrite)

**Dual mode: plan or direct.**

**Mode detection:**
- Task prompt references `.neo/specs/*.md` → plan mode
- Otherwise → direct mode

**Plan mode protocol:**

1. **Load Plan** — read plan file via Read tool. Review critically for gaps or blockers. If blocked → report BLOCKED (no decision poll).
2. **Pre-Flight** — git clean, branch up-to-date, rebase if behind (kept from current).
3. **Execute Tasks** — for each task in plan:
   a. Follow each checkbox step exactly
   b. Self-review (completeness, quality, YAGNI, tests)
   c. Spawn `spec-reviewer` subagent → must pass before proceeding
   d. If spec issues → fix, re-spawn (max 3)
   e. Spawn `code-quality-reviewer` subagent (ONLY after spec ✅)
   f. If quality issues → fix, re-spawn (max 3)
   g. Mark task complete
4. **Branch Completion** — when all tasks done, present 4 options in report (push/pr/keep/discard) with recommendation.
5. **Report** — per-task results + branch_completion JSON.

**Direct mode protocol:**

1. **Context Discovery** — infer setup from package.json, config files, source patterns.
2. **Pre-Flight** — same as plan mode.
3. **Read** — read files relevant to the task.
4. **Implement** — types → logic → exports → tests → config. One edit at a time.
5. **Verify** — typecheck, tests, lint.
6. **Commit** — conventional commits.
7. **Self-review + spawn reviewers** — same two-stage subagent review as plan mode.
8. **Branch Completion + Report** — same as plan mode.

**Behavioral rules (from superpowers):**
- Follow plan exactly — don't improvise
- Stop immediately on blockers — don't guess
- Check off steps as completed
- Never skip reviews (spec compliance THEN code quality, in that order)
- Spec compliance MUST pass before code quality review starts
- Never dispatch multiple subagents in parallel

**Disciplines kept:**
- Systematic Debugging (4 phases + Phase 4.5 escalation)
- Verification Before Completion (iron law — evidence before claims)
- Handling Review Feedback (READ → RESTATE → VERIFY → EVALUATE + anti-patterns)
- Status Protocol (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT)

**Disciplines removed/replaced:**
- "Spawning Reviewers" with ad-hoc prompts → replaced by named SDK subagents
- Decision Polling → removed from developer (architect only)
- Context Discovery → only in direct mode

### 2.3 Subagent prompts — `packages/agents/prompts/subagents/` (NEW)

Three new files:

**`spec-reviewer.md`** (based on superpowers spec-reviewer-prompt):
- Purpose: verify implementation matches spec (nothing more, nothing less)
- CRITICAL: do NOT trust implementer's report — read actual code
- Compare implementation to requirements line by line
- Check: missing requirements, extra/unneeded work, misunderstandings
- Output: ✅ Spec compliant OR ❌ Issues [file:line, what's missing/extra/wrong]

**`code-quality-reviewer.md`** (based on superpowers code-quality-reviewer):
- Purpose: verify implementation is well-built
- 5 review lenses: quality, standards, security, performance, coverage
- Check: one responsibility per file, patterns followed, no dead code, tests verify behavior
- Max 15 issues, prioritized by severity
- Output: Strengths, Issues (Critical/Important/Minor with file:line), Assessment

**`plan-reviewer.md`** (based on superpowers plan-document-reviewer):
- Purpose: verify plan is complete, matches spec, has proper decomposition
- 4 checks: completeness, spec alignment, task decomposition, buildability
- Calibration: only flag issues that would cause real problems during implementation
- Output: Approved OR Issues Found [Task X Step Y, specific issue, why it matters]

### 2.4 YAML agent definitions — add `agents` field

**`packages/agents/agents/developer.yml`:**
```yaml
name: developer
description: "Executes implementation plans step by step or direct tasks in an isolated git clone"
model: opus
tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
prompt: ../prompts/developer.md
sandbox: writable
maxTurns: 200   # Increased from 100: plan execution involves multiple tasks + two-stage review per task
agents:
  spec-reviewer:
    description: "Verify implementation matches task specification exactly"
    prompt: ../prompts/subagents/spec-reviewer.md
    tools: [Read, Grep, Glob]
    model: sonnet
  code-quality-reviewer:
    description: "Review code quality, patterns, test coverage"
    prompt: ../prompts/subagents/code-quality-reviewer.md
    tools: [Read, Grep, Glob]
    model: sonnet
```

**`packages/agents/agents/architect.yml`:**
```yaml
name: architect
description: "Analyzes feature requests, designs architecture, and writes implementation plans"
model: opus
tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
prompt: ../prompts/architect.md
sandbox: writable
maxTurns: 100
agents:
  plan-reviewer:
    description: "Review implementation plan for completeness and clarity"
    prompt: ../prompts/subagents/plan-reviewer.md
    tools: [Read, Grep, Glob]
    model: sonnet
```

Note: architect needs Write/Edit tools to create plan files in `.neo/specs/`. The sandbox changes from `readonly` to `writable` — the architect needs to write files in its isolated clone. The prompt enforces the boundary: "ONLY write to `.neo/specs/` files. NEVER modify source files." This is a prompt-level constraint, not a sandbox-level one.

---

## Workstream 3: SUPERVISOR.md updates

### 3.1 Available Agents table

| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `architect` | opus | writable | Triage + design + write implementation plan to `.neo/specs/`. Spawns plan-reviewer subagent. Writes code in plans, NEVER modifies source files. |
| `developer` | opus | writable | Executes implementation plans step by step OR direct tasks. Spawns spec-reviewer and code-quality-reviewer subagents. |
| `reviewer` | sonnet | readonly | (unchanged) |
| `scout` | opus | readonly | (unchanged) |

### 3.2 Agent Output Contracts

**architect → `plan_path` + `summary`** (replaces `design` + `milestones[].tasks[]`):

React to: dispatch `developer` with `--prompt "Execute the implementation plan at {plan_path}. Create a PR when all tasks pass."` on the same branch.

No more task-by-task dispatch from supervisor. The developer handles the full plan autonomously.

**developer → `status` + `branch_completion`** (enriched):

Same status handling as current (DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT).

NEW: when `branch_completion` is present, supervisor decides:
- `recommendation: "pr"` + tests passing → create/push PR (most common)
- `recommendation: "keep"` → note in focus, revisit later
- `recommendation: "discard"` → requires supervisor confirmation before executing
- `recommendation: "push"` → push without PR (rare, for config/doc changes)

### 3.3 Routing table

| Condition | Action |
|-----------|--------|
| Bug + critical priority | Dispatch `developer` direct (hotfix) |
| Clear criteria + small scope (< 3 points) | Dispatch `developer` direct |
| Complexity ≥ 3 | Dispatch `architect` first → plan → dispatch `developer` with plan path |
| Unclear criteria or vague scope | Dispatch `architect` (handles triage via decision poll) |
| Proactive exploration | Dispatch `scout` (unchanged) |

### 3.4 Execution Strategy (simplified)

Remove `parallel_groups` / `model_hints` supervisor logic. The developer handles execution order from the plan.

Keep:
- Post-completion CI check
- Reviewer dispatch after CI passes
- Anti-loop guard (max 6 re-dispatch cycles)

### 3.5 Prompt writing examples

```bash
# architect
neo run architect --prompt "Design and plan: multi-tenant auth system" \
  --repo /path/to/repo --branch feat/PROJ-99-auth \
  --meta '{"ticketId":"PROJ-99","stage":"plan"}'

# developer with plan
neo run developer --prompt "Execute the implementation plan at .neo/specs/PROJ-99-plan.md. Create a PR when all tasks pass." \
  --repo /path/to/repo --branch feat/PROJ-99-auth \
  --meta '{"ticketId":"PROJ-99","stage":"develop"}'

# developer direct (small task)
neo run developer --prompt "Fix: POST /api/users returns 500 when email contains '+'. Open a PR." \
  --repo /path/to/repo --branch fix/PROJ-43-email \
  --meta '{"ticketId":"PROJ-43","stage":"develop"}'
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Architect plan too verbose (token cost) | Plans target 2-5 min per step — complex features may need 20+ steps. Monitor cost via `neo cost`. |
| Developer ignores plan steps | Prompt explicitly says "follow plan exactly — don't improvise". Spec-reviewer catches deviations. |
| SDK `agents` param not supported in current SDK version | SDK v0.1.77+ has `agents` in `ClaudeAgentOptions`. Verify on build. |
| Subagent model (sonnet) insufficient for complex reviews | Agent YAML allows overriding model per subagent. Can upgrade to opus if needed. |
| Architect writable but must not modify source | Sandbox changed to `writable` so architect can create plan files. Prompt enforces "ONLY write to `.neo/specs/`". Spec-reviewer subagent would catch source file modifications. |
| Direct mode developer less rigorous than plan mode | Same two-stage review applies in both modes. Direct mode is for simple tasks where a plan would be overhead. |

## Files to modify

### Core
- `packages/core/src/agents/schema.ts` — add subagentDefinitionSchema + agents field
- `packages/core/src/types.ts` — add SubagentDefinition + agents to AgentDefinition
- `packages/core/src/agents/loader.ts` — resolve subagent .md prompts
- `packages/core/src/agents/resolver.ts` — mergeAgents() + wire into resolution
- `packages/core/src/runner/session.ts` — pass agents to SDK queryOptions
- `packages/core/src/__tests__/agents.test.ts` — tests for agents field

### Prompts
- `packages/agents/prompts/architect.md` — rewrite (writing-plans style)
- `packages/agents/prompts/developer.md` — rewrite (executing-plans + subagent-driven style)
- `packages/agents/agents/architect.yml` — add agents field + Write/Edit tools + sandbox writable
- `packages/agents/agents/developer.yml` — add agents field
- `packages/agents/prompts/subagents/spec-reviewer.md` — NEW
- `packages/agents/prompts/subagents/code-quality-reviewer.md` — NEW
- `packages/agents/prompts/subagents/plan-reviewer.md` — NEW

### Supervisor
- `packages/agents/SUPERVISOR.md` — update contracts, routing, examples

### Supervisor prompt-builder — make agnostic
- `packages/core/src/supervisor/prompt-builder.ts` — remove agent-specific workflow details from hard-coded TS constants. These belong in `SUPERVISOR.md` (loaded as `customInstructions`), not in compiled code.
  - **Line 63** (`OPERATING_PRINCIPLES`): remove the "Parallel dispatch guardrails" bullet about `parallel_groups` / `depends_on` / file overlap — this is agent workflow detail, not an operating principle. Replace with a generic principle: "Verify agent output contracts before dispatching follow-up work."
  - **Line 91**: change `"it contains structured JSON (PR URLs, issues, plans, milestones)"` → `"it contains the agent's output — read it to decide next steps."` Remove the assumption about output format.
  - **Line 146** (`HEARTBEAT_RULES`): change `"Parse agent JSON output"` → `"Read agent output"` — don't assume format.
  - **Line 257** (memory examples): remove the procedure example `"After architect run: parse milestones from JSON output, create one task per milestone"` — this is workflow-specific. Replace with a generic example: `"After architect run: read output, dispatch follow-up agent per SUPERVISOR.md routing rules"`.
  - **Lines 162-176** (`multi-task-initiatives`): make branch strategy and dispatch quality paragraphs generic. Remove references to "tasks push to the same branch sequentially" and "summarize what tasks 1..N-1 produced" — these are now developer-internal concerns. Keep: branch-per-initiative, post-completion dispatch reviewer, task tracking discipline.

The goal: prompt-builder provides the **operating framework** (heartbeat lifecycle, memory system, commands, reporting). All agent-specific routing, output contracts, and workflow details live in `SUPERVISOR.md`.

### Existing utilities to reuse
- `mergeTools()` in resolver.ts — pattern for `mergeAgents()`
- `loadAgentFile()` in loader.ts — pattern for subagent .md prompt loading
- `buildQueryOptions()` in session.ts — add agents passthrough
