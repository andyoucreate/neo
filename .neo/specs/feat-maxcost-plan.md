# Agent maxCost Implementation Plan

**Goal:** Add optional `maxCost` field to agent YAML schema that terminates sessions gracefully when exceeded.

**Architecture:** Extend the agent schema with `maxCost: number`. Since the Claude SDK only provides cost information at session completion (not during execution), implement a **post-session validation** that checks `stepResult.costUsd` against `agent.maxCost`. If exceeded, the session is marked as failed with a clear error message. This is a "soft limit" that prevents runaway costs across multiple sessions but cannot terminate mid-session.

**Tech Stack:** Zod schema, TypeScript, post-execution validation in orchestrator.

**Important Limitation:** The Claude Agent SDK only reports `total_cost_usd` in the final `result` message after the session completes. Real-time cost tracking during a session is not possible with the current SDK architecture. This implementation provides cost limits that are enforced **between** sessions, not **during** a session.

---

## File Structure Mapping

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `packages/core/src/agents/schema.ts` | Add `maxCost` to agent schema |
| Modify | `packages/core/src/types.ts` | Add `maxCost` to `ResolvedAgent` |
| Modify | `packages/core/src/agents/resolver.ts` | Propagate `maxCost` to resolved agent |
| Modify | `packages/core/src/orchestrator.ts` | Check maxCost after session completion |
| Modify | `packages/core/src/__tests__/orchestrator.test.ts` | Unit tests for maxCost validation |
| Modify | `packages/core/src/__tests__/e2e.test.ts` | E2E test for maxCost |

---

### Task 1: Add `maxCost` to Agent Schema

**Files:**
- Modify: `packages/core/src/agents/schema.ts`

- [ ] **Step 1: Add maxCost field to agentConfigSchema**

```typescript
// In packages/core/src/agents/schema.ts
// After maxTurns field (line 51), add maxCost:

export const agentConfigSchema = z.object({
  name: z.string(),
  extends: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  model: agentModelSchema.optional(),
  tools: z.array(agentToolEntrySchema).optional(),
  prompt: z.string().optional(),
  promptAppend: z.string().optional(),
  sandbox: agentSandboxSchema.optional(),
  maxTurns: z.number().optional(),
  maxCost: z.number().positive().optional(), // <-- NEW: cost limit in USD per session
  mcpServers: z.array(z.string()).optional(),
  agents: z.record(z.string(), subagentDefinitionSchema).optional(),
});
```

- [ ] **Step 2: Verify schema compiles**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm typecheck`
Expected: PASS (no type errors)

- [ ] **Step 3: Commit schema change**

```bash
git add packages/core/src/agents/schema.ts
git commit -m "$(cat <<'EOF'
feat(schema): add maxCost field to agent config

Allows setting a per-session cost limit in USD. When exceeded,
the session is marked as failed with a clear error message.

Note: Due to SDK limitations, this is a post-session check.
The SDK only reports cost after session completion.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Update Types for maxCost Support

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add maxCost to ResolvedAgent interface**

```typescript
// In packages/core/src/types.ts, update ResolvedAgent (line 34).
// Add maxCost after maxTurns (line 38):

export interface ResolvedAgent {
  name: string;
  definition: AgentDefinition;
  sandbox: "writable" | "readonly";
  maxTurns?: number | undefined;
  maxCost?: number | undefined; // <-- NEW: cost limit in USD per session
  version?: string | undefined;
  source: "built-in" | "custom" | "extended";
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit type changes**

```bash
git add packages/core/src/types.ts
git commit -m "$(cat <<'EOF'
feat(types): add maxCost to ResolvedAgent

ResolvedAgent.maxCost: optional cost limit per session in USD.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Update Agent Resolver to Propagate maxCost

**Files:**
- Modify: `packages/core/src/agents/resolver.ts`

- [ ] **Step 1: Read the current resolver implementation**

Run: `cat packages/core/src/agents/resolver.ts`

- [ ] **Step 2: Add maxCost to the resolved agent output**

```typescript
// In packages/core/src/agents/resolver.ts, in the resolveAgent function,
// add maxCost to the returned ResolvedAgent object.
// After maxTurns is set, add:

const resolved: ResolvedAgent = {
  name: config.name,
  definition: {
    description: config.description ?? parent?.definition.description ?? "",
    prompt: finalPrompt,
    tools: finalTools,
    model: config.model ?? parent?.definition.model ?? "sonnet",
    mcpServers: config.mcpServers ?? parent?.definition.mcpServers,
    agents: config.agents,
  },
  sandbox: config.sandbox ?? parent?.sandbox ?? "readonly",
  maxTurns: config.maxTurns ?? parent?.maxTurns,
  maxCost: config.maxCost ?? parent?.maxCost, // <-- NEW: inherit from parent
  version: config.version,
  source: parent ? "extended" : "custom",
};
```

- [ ] **Step 3: Verify compilation**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit resolver change**

```bash
git add packages/core/src/agents/resolver.ts
git commit -m "$(cat <<'EOF'
feat(resolver): propagate maxCost from agent config

maxCost is inherited from parent agents and can be overridden
by child agents.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add Post-Session maxCost Validation in Orchestrator

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Test: `packages/core/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to packages/core/src/__tests__/orchestrator.test.ts
// IMPORTANT: Uses TMP_DIR (defined line 55), not TEST_REPO_DIR

describe("maxCost validation", () => {
  beforeEach(() => {
    mockMessages = []; // Reset mock between tests
  });

  it("emits session:fail when session cost exceeds maxCost", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "max-cost-session" },
      {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 5.0,
        session_id: "max-cost-session",
        num_turns: 2,
      },
    ];

    const config = makeConfig();
    const orchestrator = new Orchestrator(config);

    orchestrator.registerAgent({
      name: "expensive-agent",
      definition: {
        description: "Test agent",
        prompt: "You are a test agent",
        tools: ["Bash"],
        model: "sonnet",
      },
      sandbox: "readonly",
      maxCost: 2.0, // $2.00 limit
      source: "custom",
    });

    await orchestrator.start();

    const failEvents: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => failEvents.push(e));

    const result = await orchestrator.dispatch({
      agent: "expensive-agent",
      repo: TMP_DIR,
      prompt: "Test task",
    });

    expect(result.status).toBe("failure");
    expect(failEvents.length).toBeGreaterThan(0);
    const failEvent = failEvents[0] as { error: string };
    expect(failEvent.error).toContain("maxCost");

    await orchestrator.shutdown();
  });

  it("allows session when cost is under maxCost", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "under-budget" },
      {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 1.5,
        session_id: "under-budget",
        num_turns: 1,
      },
    ];

    const config = makeConfig();
    const orchestrator = new Orchestrator(config);

    orchestrator.registerAgent({
      name: "budget-agent",
      definition: {
        description: "Test agent",
        prompt: "You are a test agent",
        tools: ["Bash"],
        model: "sonnet",
      },
      sandbox: "readonly",
      maxCost: 5.0, // $5.00 limit
      source: "custom",
    });

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "budget-agent",
      repo: TMP_DIR,
      prompt: "Test task",
    });

    expect(result.status).toBe("success");

    await orchestrator.shutdown();
  });

  it("allows session when maxCost is not set", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "no-limit" },
      {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 100.0, // High cost, no limit
        session_id: "no-limit",
        num_turns: 5,
      },
    ];

    const config = makeConfig();
    const orchestrator = new Orchestrator(config);

    orchestrator.registerAgent({
      name: "unlimited-agent",
      definition: {
        description: "Test agent",
        prompt: "You are a test agent",
        tools: ["Bash"],
        model: "sonnet",
      },
      sandbox: "readonly",
      // No maxCost set
      source: "custom",
    });

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "unlimited-agent",
      repo: TMP_DIR,
      prompt: "Test task",
    });

    expect(result.status).toBe("success");

    await orchestrator.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm test -- packages/core/src/__tests__/orchestrator.test.ts -t "maxCost"`
Expected: FAIL (maxCost validation not implemented)

- [ ] **Step 3: Add maxCost validation in executeStep**

In `packages/core/src/orchestrator.ts`, modify the `executeStep` method to check maxCost after session completion. The key insight is that we check BEFORE emitting success events:

```typescript
// In executeStep method, after runAgentSession returns.
// Find the line: const stepResult = await this.runAgentSession(ctx, sessionPath);
// Then REPLACE the following lines that emit cost/complete events with this:

const stepResult = await this.runAgentSession(ctx, sessionPath);

// Check maxCost limit BEFORE emitting success events
if (ctx.agent.maxCost !== undefined && stepResult.costUsd > ctx.agent.maxCost) {
  const errorMsg = `Session cost ($${stepResult.costUsd.toFixed(2)}) exceeded agent maxCost limit ($${ctx.agent.maxCost.toFixed(2)})`;

  // Emit failure event
  this.emit("session:fail", {
    type: "session:fail",
    sessionId: stepResult.sessionId ?? ctx.sessionId,
    runId: ctx.runId,
    error: errorMsg,
    attempt: 1,
    maxRetries: this.config.recovery.maxRetries,
    willRetry: false,
    timestamp: new Date().toISOString(),
  });

  // Still track the cost for accounting purposes
  this._costToday += stepResult.costUsd;

  const failResult: StepResult = {
    status: "failure",
    sessionId: stepResult.sessionId,
    costUsd: stepResult.costUsd,
    durationMs: stepResult.durationMs,
    agent: ctx.agent.name,
    startedAt: ctx.activeSession.startedAt,
    completedAt: new Date().toISOString(),
    error: errorMsg,
    attempt: 1,
  };

  // Write failure episode to memory store
  try {
    const store = this.getMemoryStore();
    await store.write({
      type: "episode",
      scope: ctx.input.repo,
      content: `Run ${ctx.runId.slice(0, 8)} (${ctx.agent.name}): failed — ${errorMsg.slice(0, 150)}`,
      source: ctx.agent.name,
      outcome: "failure",
      runId: ctx.runId,
    });
  } catch (err) {
    console.debug(
      `[orchestrator] Failed to write failure episode to memory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return failResult;
}

// Normal success path: emit events and return result
this.emitCostEvents(stepResult.sessionId ?? ctx.sessionId, stepResult.costUsd, ctx);
this.emitSessionComplete(ctx, stepResult);
return stepResult;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm test -- packages/core/src/__tests__/orchestrator.test.ts -t "maxCost"`
Expected: PASS

- [ ] **Step 5: Commit orchestrator changes**

```bash
git add packages/core/src/orchestrator.ts packages/core/src/__tests__/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): add post-session maxCost validation

When an agent has maxCost configured, the orchestrator checks
the session cost after completion. If exceeded, the session is
marked as failed with a clear error message.

Note: This is a post-session check due to SDK limitations.
The Claude SDK only reports total_cost_usd in the final result
message, making real-time cost tracking impossible.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add E2E Test for maxCost

**Files:**
- Modify: `packages/core/src/__tests__/e2e.test.ts`

- [ ] **Step 1: Write E2E test**

```typescript
// Add to packages/core/src/__tests__/e2e.test.ts
// IMPORTANT: Uses mockMessages array, REPO_DIR constant (not mockBehavior)

describe("agent maxCost", () => {
  it("fails session when cost exceeds agent maxCost", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "maxcost-e2e" },
      {
        type: "result",
        subtype: "success",
        result: "task completed",
        total_cost_usd: 10.0, // High cost
        session_id: "maxcost-e2e",
        num_turns: 1,
      },
    ];

    const orchestrator = await buildOrchestrator();
    orchestrator.registerAgent({
      name: "limited-agent",
      definition: {
        description: "Agent with cost limit",
        prompt: "You are a limited agent",
        tools: ["Bash"],
        model: "sonnet",
      },
      sandbox: "readonly",
      maxCost: 5.0, // $5.00 limit
      source: "custom",
    });

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "limited-agent",
      repo: REPO_DIR,
      prompt: "Do something expensive",
    });

    expect(result.status).toBe("failure");
    // Cost is still tracked even on failure
    expect(result.costUsd).toBe(10.0);

    await orchestrator.shutdown();
  });
});
```

- [ ] **Step 2: Run E2E test**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm test -- packages/core/src/__tests__/e2e.test.ts -t "maxCost"`
Expected: PASS

- [ ] **Step 3: Commit E2E test**

```bash
git add packages/core/src/__tests__/e2e.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): add maxCost validation test

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add Agent Inheritance Test

**Files:**
- Modify: `packages/core/src/__tests__/agents.test.ts`

- [ ] **Step 1: Write test for maxCost inheritance**

```typescript
// Add to packages/core/src/__tests__/agents.test.ts in resolver tests section

it("inherits maxCost from parent agent", async () => {
  const builtInMap = new Map<string, AgentConfig>();

  const parentConfig: AgentConfig = {
    name: "parent-with-cost",
    description: "Parent with maxCost",
    prompt: "You are a parent agent",
    model: "sonnet",
    tools: ["Bash"],
    sandbox: "readonly",
    maxCost: 10.0, // Parent has $10 limit
  };
  builtInMap.set("parent-with-cost", parentConfig);

  const childConfig: AgentConfig = {
    name: "child-agent",
    extends: "parent-with-cost",
    promptAppend: "Additional instructions",
    // No maxCost specified — should inherit from parent
  };

  const resolved = resolveAgent(childConfig, builtInMap);

  expect(resolved.maxCost).toBe(10.0);
});

it("child can override parent maxCost", async () => {
  const builtInMap = new Map<string, AgentConfig>();

  const parentConfig: AgentConfig = {
    name: "parent-with-cost",
    description: "Parent with maxCost",
    prompt: "You are a parent agent",
    model: "sonnet",
    tools: ["Bash"],
    sandbox: "readonly",
    maxCost: 10.0,
  };
  builtInMap.set("parent-with-cost", parentConfig);

  const childConfig: AgentConfig = {
    name: "child-agent",
    extends: "parent-with-cost",
    maxCost: 5.0, // Override with lower limit
  };

  const resolved = resolveAgent(childConfig, builtInMap);

  expect(resolved.maxCost).toBe(5.0);
});
```

- [ ] **Step 2: Run test**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm test -- packages/core/src/__tests__/agents.test.ts -t "maxCost"`
Expected: PASS

- [ ] **Step 3: Commit inheritance test**

```bash
git add packages/core/src/__tests__/agents.test.ts
git commit -m "$(cat <<'EOF'
test(agents): add maxCost inheritance tests

Verifies that maxCost is properly inherited from parent agents
and can be overridden by child agents.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Run Full Test Suite

**Files:** None (validation only)

- [ ] **Step 1: Run full test suite**

Run: `cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm build && pnpm typecheck && pnpm test`
Expected: PASS (all tests pass)

- [ ] **Step 2: Verify key test files pass**

Run specific test files to ensure no regressions:
```bash
cd /tmp/neo-sessions/9b4aadac-2436-4919-81d6-2a894ac0bc2f && pnpm test -- orchestrator.test.ts e2e.test.ts agents.test.ts
```
Expected: PASS

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add `maxCost` to agent schema | `schema.ts` |
| 2 | Update types for ResolvedAgent | `types.ts` |
| 3 | Update resolver to propagate maxCost | `resolver.ts` |
| 4 | Add post-session validation in orchestrator | `orchestrator.ts` + test |
| 5 | E2E test | `e2e.test.ts` |
| 6 | Inheritance test | `agents.test.ts` |
| 7 | Full validation | - |

**Total tasks:** 7
**New files:** 0
**Modified files:** 6

**Key Design Decisions:**

1. **Post-session validation vs middleware:** The Claude SDK only reports `total_cost_usd` in the final result message. Real-time cost tracking during a session is not possible, so we validate after completion.

2. **Fail on exceed:** If cost exceeds maxCost, the session is marked as failed. This prevents cascading costs on multi-step workflows but cannot stop a single expensive session mid-execution.

3. **Cost still tracked:** Even on failure, the actual cost is recorded in the result for accurate accounting. The cost is added to `_costToday` for budget tracking.

4. **Inheritance:** maxCost can be set on parent agents and inherited by children, allowing organization-wide defaults.

**Risks:**

- A single session can still exceed maxCost since we can only check after completion
- Users may expect real-time enforcement — documentation must be clear about this limitation
