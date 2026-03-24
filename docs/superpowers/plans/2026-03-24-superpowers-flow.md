# Superpowers Flow Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remodel neo's architect and developer agents to match the superpowers workflow, with SDK-injected subagents for two-stage review.

**Architecture:** Three workstreams — (1) core adds `agents` field flowing from YAML through schema/resolver/session to SDK query, (2) prompts rewrite architect as plan-writer and developer as plan-executor with dual mode, (3) SUPERVISOR.md + prompt-builder updated to match new output contracts.

**Tech Stack:** TypeScript, Zod, @anthropic-ai/claude-agent-sdk, YAML agent definitions, Markdown prompts

---

## File Structure

### Core (modified)
- `packages/core/src/agents/schema.ts` — add subagentDefinitionSchema + agents field
- `packages/core/src/types.ts` — add SubagentDefinition interface + agents to AgentDefinition
- `packages/core/src/agents/loader.ts` — resolve subagent .md prompts
- `packages/core/src/agents/resolver.ts` — add mergeAgents() + wire into resolution
- `packages/core/src/runner/session.ts` — add agents to SessionOptions + queryOptions
- `packages/core/src/__tests__/agents.test.ts` — new tests for agents field
- `packages/core/src/supervisor/prompt-builder.ts` — make agent-agnostic

### Prompts (rewritten)
- `packages/agents/prompts/architect.md` — rewrite as plan-writer
- `packages/agents/prompts/developer.md` — rewrite as plan-executor with dual mode
- `packages/agents/agents/architect.yml` — add agents, Write/Edit tools, writable sandbox
- `packages/agents/agents/developer.yml` — add agents, maxTurns 200

### New files
- `packages/agents/prompts/subagents/spec-reviewer.md`
- `packages/agents/prompts/subagents/code-quality-reviewer.md`
- `packages/agents/prompts/subagents/plan-reviewer.md`

### Supervisor
- `packages/agents/SUPERVISOR.md` — update contracts, routing, examples

---

## Task 1: Add subagent schema to Zod

**Files:**
- Modify: `packages/core/src/agents/schema.ts`

- [ ] **Step 1: Add subagentDefinitionSchema and agents field**

Add after `agentSandboxSchema` (line 28) and before `agentConfigSchema` (line 32):

```typescript
// ─── Subagent definition (for SDK agents parameter) ───

export const subagentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(agentToolSchema).optional(),
  model: agentModelSchema.optional(),
});
```

Then add to `agentConfigSchema` object, after `mcpServers` (line 43):

```typescript
  agents: z.record(z.string(), subagentDefinitionSchema).optional(),
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/agents/schema.ts
git commit -m "feat(agents): add subagent definition schema for SDK agents parameter

Generated with [neo](https://neotx.dev)"
```

---

## Task 2: Add SubagentDefinition to types

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add SubagentDefinition interface and agents to AgentDefinition**

After the existing `AgentDefinition` interface (line 14-20), replace it with:

```typescript
// ─── Subagent Definition (SDK-compatible) ────────────────

export interface SubagentDefinition {
  description: string;
  prompt: string;
  tools?: string[] | undefined;
  model?: string | undefined;
}

// ─── Agent Definition (SDK-compatible) ───────────────────

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
  mcpServers?: string[] | undefined;
  agents?: Record<string, SubagentDefinition> | undefined;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(agents): add SubagentDefinition type and agents field to AgentDefinition

Generated with [neo](https://neotx.dev)"
```

---

## Task 3: Resolve subagent .md prompts in loader

**Files:**
- Modify: `packages/core/src/agents/loader.ts`

- [ ] **Step 1: Add subagent prompt resolution after main prompt loading**

After the main prompt resolution block (line 50, before `return config;`), add:

```typescript
  // If agents have prompt paths ending in .md, resolve them
  if (config.agents) {
    for (const [name, subagent] of Object.entries(config.agents)) {
      if (subagent.prompt.endsWith(".md")) {
        const subagentPromptPath = path.resolve(path.dirname(filePath), subagent.prompt);
        try {
          subagent.prompt = await readFile(subagentPromptPath, "utf-8");
        } catch (err) {
          throw new Error(
            `Subagent "${name}" prompt file not found: ${subagentPromptPath} (referenced in ${filePath}). Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/agents/loader.ts
git commit -m "feat(agents): resolve subagent .md prompt paths in loader

Generated with [neo](https://neotx.dev)"
```

---

## Task 4: Add mergeAgents to resolver

**Files:**
- Modify: `packages/core/src/agents/resolver.ts`

- [ ] **Step 1: Import SubagentDefinition**

Update the imports at line 2:

```typescript
import type { AgentDefinition, ResolvedAgent, SubagentDefinition } from "@/types";
```

- [ ] **Step 2: Add mergeAgents helper**

After `mergeMcpServerNames` (line 153), add:

```typescript
function mergeAgents(
  base: Record<string, SubagentDefinition> | undefined,
  override: Record<string, SubagentDefinition> | undefined,
): Record<string, SubagentDefinition> | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}
```

- [ ] **Step 3: Wire mergeAgents into resolveExtendedAgent**

In `resolveExtendedAgent`, after `const mcpServers = ...` (line 44), add:

```typescript
  const agents = mergeAgents(base.agents as Record<string, SubagentDefinition> | undefined, config.agents as Record<string, SubagentDefinition> | undefined);
```

Then update the `definition` object (line 46-52) to include agents:

```typescript
  const definition: AgentDefinition = {
    description: config.description ?? base.description ?? "",
    prompt,
    tools,
    model: config.model ?? base.model ?? "sonnet",
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(agents ? { agents } : {}),
  };
```

- [ ] **Step 4: Wire mergeAgents into resolveCustomAgent**

In `resolveCustomAgent`, update the `definition` object (line 109-115) to include agents:

```typescript
  const definition: AgentDefinition = {
    description: config.description,
    prompt,
    tools,
    model: config.model,
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
    ...(config.agents ? { agents: config.agents as Record<string, SubagentDefinition> } : {}),
  };
```

- [ ] **Step 5: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agents/resolver.ts
git commit -m "feat(agents): add mergeAgents helper and wire into agent resolution

Generated with [neo](https://neotx.dev)"
```

---

## Task 5: Pass agents to SDK queryOptions

**Files:**
- Modify: `packages/core/src/runner/session.ts`

- [ ] **Step 1: Add agents to SessionOptions**

In the `SessionOptions` interface (line 8-22), add after `resumeSessionId`:

```typescript
  agents?: Record<string, unknown> | undefined;
```

- [ ] **Step 2: Pass agents in buildQueryOptions**

In `buildQueryOptions()`, after the `env` block (line 85), add:

```typescript
  if (options.agents && Object.keys(options.agents).length > 0) {
    queryOptions.agents = options.agents;
  }
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runner/session.ts
git commit -m "feat(agents): pass agents to SDK queryOptions for subagent injection

Generated with [neo](https://neotx.dev)"
```

---

## Task 6: Thread agents through session-executor

**Files:**
- Modify: `packages/core/src/runner/session-executor.ts`

- [ ] **Step 1: Find where runWithRecovery is called and pass agents**

Read `packages/core/src/runner/session-executor.ts` fully. Find the `runWithRecovery({` call (around line 166). This function extends `SessionOptions` via `RecoveryOptions` and spreads options through to `runSession()`. Add `agents: agent.definition.agents` to the options object passed to `runWithRecovery()`:


```typescript
agents: agent.definition.agents,
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/runner/session-executor.ts
git commit -m "feat(agents): thread agents from agent definition through session executor

Generated with [neo](https://neotx.dev)"
```

---

## Task 7: Add tests for agents field

**Files:**
- Modify: `packages/core/src/__tests__/agents.test.ts`

- [ ] **Step 1: Add schema test for agents field**

In the `loadAgentFile` describe block, add:

```typescript
  it("loads agent with inline subagent definitions", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "with-agents",
      `
name: with-agents
description: "Agent with subagents"
model: opus
tools: [Read, Agent]
sandbox: writable
prompt: "You are an agent."
agents:
  reviewer:
    description: "Code reviewer"
    prompt: "You review code."
    tools: [Read, Grep, Glob]
    model: sonnet
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "with-agents.yml"));
    expect(config.agents).toBeDefined();
    expect(config.agents!.reviewer.description).toBe("Code reviewer");
    expect(config.agents!.reviewer.prompt).toBe("You review code.");
    expect(config.agents!.reviewer.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(config.agents!.reviewer.model).toBe("sonnet");
  });

  it("resolves subagent .md prompt paths", async () => {
    await writeFile(
      path.join(PROMPTS_DIR, "review.md"),
      "You are a reviewer agent.",
      "utf-8",
    );

    await writeYaml(
      BUILT_IN_DIR,
      "with-md-agents",
      `
name: with-md-agents
description: "Agent with md subagent"
model: opus
tools: [Read, Agent]
sandbox: writable
prompt: "You are an agent."
agents:
  reviewer:
    description: "Code reviewer"
    prompt: ../prompts/review.md
    tools: [Read]
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "with-md-agents.yml"));
    expect(config.agents!.reviewer.prompt).toBe("You are a reviewer agent.");
  });
```

- [ ] **Step 2: Add resolver test for agents merge**

In the `resolveAgent` describe block, add:

```typescript
  it("merges agents from base and override", () => {
    const base: AgentConfig = {
      name: "developer",
      description: "Dev",
      model: "opus",
      tools: ["Read"],
      sandbox: "writable",
      prompt: "You are a developer.",
      agents: {
        reviewer: {
          description: "Base reviewer",
          prompt: "Review code.",
          tools: ["Read"],
        },
      },
    };
    const builtIns = new Map([["developer", base]]);

    const config: AgentConfig = {
      name: "dev-custom",
      extends: "developer",
      agents: {
        "quality-reviewer": {
          description: "Quality reviewer",
          prompt: "Review quality.",
          tools: ["Read", "Grep"],
          model: "sonnet",
        },
      },
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.agents).toEqual({
      reviewer: {
        description: "Base reviewer",
        prompt: "Review code.",
        tools: ["Read"],
      },
      "quality-reviewer": {
        description: "Quality reviewer",
        prompt: "Review quality.",
        tools: ["Read", "Grep"],
        model: "sonnet",
      },
    });
  });

  it("override agents win on name collision", () => {
    const base: AgentConfig = {
      name: "developer",
      description: "Dev",
      model: "opus",
      tools: ["Read"],
      sandbox: "writable",
      prompt: "You are a developer.",
      agents: {
        reviewer: {
          description: "Base reviewer",
          prompt: "Review code.",
        },
      },
    };
    const builtIns = new Map([["developer", base]]);

    const config: AgentConfig = {
      name: "dev-override",
      extends: "developer",
      agents: {
        reviewer: {
          description: "Override reviewer",
          prompt: "Review differently.",
          model: "opus",
        },
      },
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.agents!.reviewer.description).toBe("Override reviewer");
    expect(resolved.definition.agents!.reviewer.model).toBe("opus");
  });
```

- [ ] **Step 3: Run tests**

Run: `cd packages/core && pnpm test`
Expected: all tests pass including new ones

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/agents.test.ts
git commit -m "test(agents): add tests for subagent schema, loader, and resolver merge

Generated with [neo](https://neotx.dev)"
```

---

## Task 8: Create subagent prompt files

**Files:**
- Create: `packages/agents/prompts/subagents/spec-reviewer.md`
- Create: `packages/agents/prompts/subagents/code-quality-reviewer.md`
- Create: `packages/agents/prompts/subagents/plan-reviewer.md`

- [ ] **Step 1: Create subagents directory**

```bash
mkdir -p packages/agents/prompts/subagents
```

- [ ] **Step 2: Create spec-reviewer.md**

Create `packages/agents/prompts/subagents/spec-reviewer.md`:

```markdown
# Spec Compliance Reviewer

You verify whether an implementation matches its specification — nothing more, nothing less.

## CRITICAL: Do Not Trust the Report

The implementer's report may be incomplete, inaccurate, or optimistic. You MUST verify everything independently by reading the actual code.

**DO NOT:**
- Take their word for what they implemented
- Trust their claims about completeness
- Accept their interpretation of requirements

**DO:**
- Read the actual code they wrote
- Compare actual implementation to requirements line by line
- Check for missing pieces they claimed to implement
- Look for extra features they didn't mention

## Your Job

Read the implementation code and verify:

**Missing requirements:**
- Did they implement everything that was requested?
- Are there requirements they skipped or missed?
- Did they claim something works but didn't actually implement it?

**Extra/unneeded work:**
- Did they build things that weren't requested?
- Did they over-engineer or add unnecessary features?
- Did they add "nice to haves" that weren't in spec?

**Misunderstandings:**
- Did they interpret requirements differently than intended?
- Did they solve the wrong problem?
- Did they implement the right feature but wrong way?

## Output

Report one of:
- ✅ Spec compliant — everything matches after code inspection
- ❌ Issues found: [list specifically what's missing or extra, with file:line references]
```

- [ ] **Step 3: Create code-quality-reviewer.md**

Create `packages/agents/prompts/subagents/code-quality-reviewer.md`:

```markdown
# Code Quality Reviewer

You verify that an implementation is well-built: clean, tested, and maintainable.

## Review Lenses

Examine the code through these 5 lenses:

### 1. Quality
- Logic correct? Edge cases handled?
- DRY — duplicated blocks > 10 lines?
- Functions > 60 lines? (signal to split)
- Clear naming? Names match what things do?

### 2. Standards
- Naming conventions followed? (camelCase, PascalCase, kebab-case as appropriate)
- File structure consistent with existing patterns?
- TypeScript types used properly? (no `any`, strict mode patterns)

### 3. Security
- SQL/command injection possible?
- Auth bypass paths?
- Hardcoded secrets or credentials?
- User input sanitized at boundaries?

### 4. Performance
- N+1 queries?
- O(n^2) or worse where O(n) is possible?
- Memory leaks? (unclosed resources, growing collections)
- Unnecessary re-renders? (React)

### 5. Coverage
- New functions without tests?
- Mutations without test coverage?
- Edge cases not tested?
- Tests verify behavior, not mocks?

## Rules

- Max 15 issues (prioritize by severity)
- Only flag issues in NEW changes, not pre-existing code
- Check: one responsibility per file, patterns followed, no dead code

## Output

Report:
- **Strengths**: what was done well
- **Issues**: Critical / Important / Minor (with file:line)
- **Assessment**: Approved OR Changes Requested (≥1 Critical or ≥5 warnings = Changes Requested)
```

- [ ] **Step 4: Create plan-reviewer.md**

Create `packages/agents/prompts/subagents/plan-reviewer.md`:

```markdown
# Plan Document Reviewer

You verify that an implementation plan is complete, matches the spec, and has proper task decomposition.

## What to Check

| Category | What to Look For |
|----------|------------------|
| Completeness | TODOs, placeholders, incomplete tasks, missing steps |
| Spec Alignment | Plan covers spec requirements, no major scope creep |
| Task Decomposition | Tasks have clear boundaries, steps are actionable |
| Buildability | Could an engineer follow this plan without getting stuck? |

## Calibration

**Only flag issues that would cause real problems during implementation.**

An implementer building the wrong thing or getting stuck is an issue. Minor wording, stylistic preferences, and "nice to have" suggestions are not.

Approve unless there are serious gaps:
- Missing requirements from the spec
- Contradictory steps
- Placeholder content
- Tasks so vague they can't be acted on

## Output

**Status:** Approved | Issues Found

**Issues (if any):**
- [Task X, Step Y]: [specific issue] — [why it matters for implementation]

**Recommendations (advisory, do not block approval):**
- [suggestions for improvement]
```

- [ ] **Step 5: Commit**

```bash
git add packages/agents/prompts/subagents/
git commit -m "feat(agents): add subagent prompt files for spec-reviewer, code-quality-reviewer, plan-reviewer

Generated with [neo](https://neotx.dev)"
```

---

## Task 9: Update YAML agent definitions

**Files:**
- Modify: `packages/agents/agents/developer.yml`
- Modify: `packages/agents/agents/architect.yml`

- [ ] **Step 1: Update developer.yml**

Replace the full content of `packages/agents/agents/developer.yml`:

```yaml
name: developer
description: "Executes implementation plans step by step or direct tasks in an isolated git clone. Spawns spec-reviewer and code-quality-reviewer subagents."
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
maxTurns: 200
prompt: ../prompts/developer.md
agents:
  spec-reviewer:
    description: "Verify implementation matches task specification exactly. Use after completing each task to ensure nothing is missing or extra."
    prompt: ../prompts/subagents/spec-reviewer.md
    tools:
      - Read
      - Grep
      - Glob
    model: sonnet
  code-quality-reviewer:
    description: "Review code quality, patterns, and test coverage. Use ONLY after spec-reviewer approves."
    prompt: ../prompts/subagents/code-quality-reviewer.md
    tools:
      - Read
      - Grep
      - Glob
    model: sonnet
```

- [ ] **Step 2: Update architect.yml**

Replace the full content of `packages/agents/agents/architect.yml`:

```yaml
name: architect
description: "Analyzes feature requests, designs architecture, and writes implementation plans to .neo/specs/. Spawns plan-reviewer subagent. Writes code in plans, NEVER modifies source files."
model: opus
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - Agent
sandbox: writable
maxTurns: 100
prompt: ../prompts/architect.md
agents:
  plan-reviewer:
    description: "Review implementation plan for completeness, spec alignment, and buildability."
    prompt: ../prompts/subagents/plan-reviewer.md
    tools:
      - Read
      - Grep
      - Glob
    model: sonnet
```

- [ ] **Step 3: Fix existing test for architect sandbox change**

The existing test at `packages/core/src/__tests__/agents.test.ts` (around line 664) asserts `expect(arch?.sandbox).toBe("readonly")`. Since architect is now `writable`, update this assertion:

Find:
```typescript
expect(arch?.sandbox).toBe("readonly");
```

Replace with:
```typescript
expect(arch?.sandbox).toBe("writable");
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && pnpm test -- agents.test`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/agents/agents/developer.yml packages/agents/agents/architect.yml
git commit -m "feat(agents): add subagent definitions to developer and architect YAML

Generated with [neo](https://neotx.dev)"
```

---

## Task 10: Rewrite architect prompt

**Files:**
- Modify: `packages/agents/prompts/architect.md`

- [ ] **Step 1: Rewrite the full architect.md**

Replace the entire content of `packages/agents/prompts/architect.md` with the new writing-plans-style prompt. The prompt is long — see the spec at `docs/superpowers/specs/2026-03-24-superpowers-flow-design.md` section 2.1 for the full structure.

The new prompt must include these sections in order:

1. **Header** — identity as a plan writer, never writes source code
2. **Triage** — score 1-5 (kept from current)
3. **Protocol**:
   - 1. Analyze (goal, scope, dependencies, risks)
   - 2. Explore (Glob/Grep, read patterns)
   - 3. Design + Approval Gate (2-3 approaches, decision poll, max 2 cycles)
   - 4. Write Plan (superpowers format — header, file mapping, tasks with checkbox steps, full code, exact commands, save to `.neo/specs/{ticket-id}-plan.md`)
   - 5. Plan Review Loop (spawn `plan-reviewer` subagent, max 3 iterations)
   - 6. Report (plan path + summary)
4. **Plan Format** — document the exact format with examples
5. **Escalation** — when to stop
6. **Rules** — including "Write code in plans only, NEVER modify source files"

- [ ] **Step 2: Verify the file is valid markdown**

Read back the file to confirm it's well-formed.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/architect.md
git commit -m "feat(agents): rewrite architect prompt as superpowers-style plan writer

Generated with [neo](https://neotx.dev)"
```

---

## Task 11: Rewrite developer prompt

**Files:**
- Modify: `packages/agents/prompts/developer.md`

- [ ] **Step 1: Rewrite the full developer.md**

Replace the entire content of `packages/agents/prompts/developer.md` with the new executing-plans + subagent-driven-dev style prompt. See the spec section 2.2 for full structure.

The new prompt must include these sections:

1. **Header** — dual mode: plan executor or direct task implementer
2. **Mode Detection** — `.neo/specs/*.md` reference → plan mode, else → direct mode
3. **Pre-Flight** — git clean, branch up-to-date (kept from current)
4. **Plan Mode Protocol**:
   - Load plan (Read tool), review critically
   - Execute tasks step by step (follow checkboxes)
   - After each task: self-review → spawn `spec-reviewer` → spawn `code-quality-reviewer`
   - Review loops (max 3 per stage)
5. **Direct Mode Protocol**:
   - Context discovery, read, implement, verify, commit
   - Same two-stage review
6. **Branch Completion** — present 4 options when all tasks done
7. **Report** — JSON with per-task results + branch_completion
8. **Escalation** — when to stop
9. **Rules** — follow plan exactly, stop on blockers, never skip reviews
10. **Disciplines** (kept):
    - Systematic Debugging
    - Verification Before Completion
    - Handling Review Feedback
    - Status Protocol

- [ ] **Step 2: Verify the file is valid markdown**

Read back the file to confirm it's well-formed.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/developer.md
git commit -m "feat(agents): rewrite developer prompt as superpowers-style plan executor with dual mode

Generated with [neo](https://neotx.dev)"
```

---

## Task 12: Update SUPERVISOR.md

**Files:**
- Modify: `packages/agents/SUPERVISOR.md`

- [ ] **Step 1: Update Available Agents table**

Replace the table (lines 7-12) with:

```markdown
| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `architect` | opus | writable | Triage + design + write implementation plan to `.neo/specs/`. Spawns plan-reviewer subagent. Writes code in plans, NEVER modifies source files. |
| `developer` | opus | writable | Executes implementation plans step by step (plan mode) OR direct tasks (direct mode). Spawns spec-reviewer and code-quality-reviewer subagents. |
| `reviewer` | sonnet | readonly | Thorough single-pass review: quality, standards, security, perf, and coverage. Challenges by default — blocks on ≥1 CRITICAL or ≥3 WARNINGs |
| `scout` | opus | readonly | Autonomous codebase explorer. Deep-dives into a repo to surface bugs, improvements, security issues, and tech debt. Creates decisions for the user |
```

- [ ] **Step 2: Update architect output contract**

Replace the architect section (lines 18-24) with:

```markdown
### architect → `plan_path` + `summary`

React to: dispatch `developer` with `--prompt "Execute the implementation plan at {plan_path}. Create a PR when all tasks pass."` on the same branch.

No more task-by-task dispatch from supervisor. The developer handles the full plan autonomously.
```

- [ ] **Step 3: Update developer output contract**

After the developer status section, add branch_completion handling:

```markdown
When `branch_completion` is present in the developer output, react to the recommendation:
- `recommendation: "pr"` + tests passing → the developer already created the PR. Extract PR number and proceed to CI check.
- `recommendation: "keep"` → note in focus, revisit later
- `recommendation: "discard"` → requires your confirmation before the branch is deleted
- `recommendation: "push"` → push without PR (rare, for config/doc changes)

`branch_completion.recommendation` guides but does not bind.
```

- [ ] **Step 4: Update routing table**

Replace the routing table with updated thresholds:

```markdown
| Condition | Action |
|-----------|--------|
| Bug + critical priority | Dispatch `developer` direct (hotfix) |
| Clear criteria + small scope (< 3 points) | Dispatch `developer` direct |
| Complexity ≥ 3 | Dispatch `architect` first → plan → dispatch `developer` with plan path |
| Unclear criteria or vague scope | Dispatch `architect` (handles triage via decision poll) |
| Proactive exploration / no specific ticket | Dispatch `scout` on target repo |
```

- [ ] **Step 5: Simplify Execution Strategy section**

Replace the current Execution Strategy (lines 226-233) with:

```markdown
## Execution Strategy

When an architect produces a plan:
1. Read the plan path from architect output
2. Dispatch `developer` with `--prompt "Execute the implementation plan at {plan_path}. Create a PR when all tasks pass."` on the same branch
3. The developer handles task ordering, reviews, and commits autonomously
4. On developer completion: check status, extract PR if present, proceed with CI check and reviewer dispatch
```

- [ ] **Step 6: Update prompt writing examples**

Replace the examples (lines 85-109) to include plan-based developer dispatch:

```markdown
### Examples

```bash
# architect
neo run architect --prompt "Design and plan: multi-tenant auth system. The ticket is vague — evaluate clarity, ask for clarifications if needed, then produce an implementation plan." \
  --repo /path/to/repo \
  --branch feat/PROJ-99-multi-tenant-auth \
  --meta '{"ticketId":"PROJ-99","stage":"plan"}'

# developer with plan (dispatched after architect completes)
neo run developer --prompt "Execute the implementation plan at .neo/specs/PROJ-99-plan.md. Create a PR when all tasks pass." \
  --repo /path/to/repo \
  --branch feat/PROJ-99-multi-tenant-auth \
  --meta '{"ticketId":"PROJ-99","stage":"develop"}'

# developer direct (small task, no architect needed)
neo run developer --prompt "Fix: POST /api/users returns 500 when email contains '+'. Open a PR when done." \
  --repo /path/to/repo \
  --branch fix/PROJ-43-email-validation \
  --meta '{"ticketId":"PROJ-43","stage":"develop"}'

# review
neo run reviewer --prompt "Review PR #73 on branch feat/PROJ-99-multi-tenant-auth." \
  --repo /path/to/repo \
  --branch feat/PROJ-99-multi-tenant-auth \
  --meta '{"ticketId":"PROJ-99","stage":"review","prNumber":73}'

# scout
neo run scout --prompt "Explore this repository and surface bugs, improvements, security issues, and tech debt. Create decisions for critical and high-impact findings." \
  --repo /path/to/repo \
  --branch main \
  --meta '{"stage":"scout"}'
```
```

- [ ] **Step 7: Commit**

```bash
git add packages/agents/SUPERVISOR.md
git commit -m "feat(agents): update SUPERVISOR.md for superpowers flow — plan-based dispatch, branch completion

Generated with [neo](https://neotx.dev)"
```

---

## Task 13: Make supervisor prompt-builder agnostic

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`

- [ ] **Step 1: Update OPERATING_PRINCIPLES**

Replace the "Parallel dispatch guardrails" bullet (line 63) with:

```typescript
- **Verify agent output**: always read agent output with \`neo runs <runId>\` before dispatching follow-up work. Route based on agent output contracts documented in SUPERVISOR.md.
```

- [ ] **Step 2: Update run output description**

Replace line 91:

```typescript
\`neo runs <runId>\` returns the agent's full output. **ALWAYS read it when a run completes** — it contains the agent's results that you need to decide next steps per SUPERVISOR.md routing rules.
```

- [ ] **Step 3: Update heartbeat decision tree**

Replace "Parse agent JSON output" in HEARTBEAT_RULES (line 146) with:

```typescript
4. EVENTS? — process run completions, messages, webhooks. Read agent output and route per SUPERVISOR.md contracts.
```

- [ ] **Step 4: Update memory examples**

Replace the architect procedure example (line 257) with:

```typescript
neo memory write --type procedure --scope /repo "After architect run: read plan path from output, dispatch developer with plan per SUPERVISOR.md routing"
```

- [ ] **Step 5: Simplify multi-task-initiatives**

In the `multi-task-initiatives` block (lines 162-176), replace the first two paragraphs with:

```typescript
**Branch strategy:** one branch per initiative. Architect produces a plan; developer executes all tasks on that branch. Independent initiatives CAN run in parallel on different branches.

**Dispatch quality:** when dispatching developer with a plan, include the plan path and any context from completed prior work (PR numbers, APIs added). For direct tasks (no plan), write a detailed \`--prompt\` with acceptance criteria.
```

- [ ] **Step 6: Verify typecheck passes**

Run: `cd packages/core && pnpm typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/prompt-builder.ts
git commit -m "refactor(supervisor): make prompt-builder agent-agnostic — workflow details in SUPERVISOR.md

Generated with [neo](https://neotx.dev)"
```

---

## Task 14: Full validation pass

**Files:** none (verification only)

- [ ] **Step 1: Build all packages**

Run: `pnpm build`
Expected: exit 0, no errors

- [ ] **Step 2: Typecheck all packages**

Run: `pnpm typecheck`
Expected: exit 0, no errors

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 4: Verify agent loading**

Run a quick sanity check that the YAML agents load with their subagents:

```bash
cd packages/core && node -e "
import('./dist/agents/loader.js').then(async m => {
  const a = await m.loadAgentFile('../agents/agents/developer.yml');
  console.log('developer agents:', Object.keys(a.agents || {}));
  const b = await m.loadAgentFile('../agents/agents/architect.yml');
  console.log('architect agents:', Object.keys(b.agents || {}));
}).catch(e => console.error(e));
"
```

Expected output:
```
developer agents: [ 'spec-reviewer', 'code-quality-reviewer' ]
architect agents: [ 'plan-reviewer' ]
```

- [ ] **Step 5: Commit any fixes if needed**

If any verification step fails, fix the issue and commit.
