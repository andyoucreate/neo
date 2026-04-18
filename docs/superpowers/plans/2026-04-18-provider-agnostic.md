# Provider-Agnostic Agent Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple neo from Anthropic-specific concepts so any CLI-based AI provider can run agents with zero YAML changes.

**Architecture:** Remove tools/model enums and subagent definitions from agent YAML. Introduce a `provider` config block with adapter registry, model whitelist, and CLI args. Simplify sandbox to boolean + paths. Extract inline subagents into standalone YAML files.

**Tech Stack:** TypeScript, Zod, Vitest, YAML

**Spec:** `docs/superpowers/specs/2026-04-18-provider-agnostic-design.md`

---

### Task 1: Simplify Agent Schema

**Files:**
- Modify: `packages/core/src/agents/schema.ts`
- Test: `packages/core/src/__tests__/agents.test.ts`

- [ ] **Step 1: Write the failing tests for simplified schema**

Replace the existing schema tests in `packages/core/src/__tests__/agents.test.ts`. The new schema accepts `description` (required), `sandbox` (required), `prompt` (required), optional `model` as free string, no `tools`, no `agents`:

```typescript
// In describe("loadAgentFile")

it("loads a valid agent YAML file", async () => {
  await writeYaml(
    BUILT_IN_DIR,
    "developer",
    `
name: developer
description: "Implementation worker"
sandbox: writable
prompt: "You are a developer agent."
`,
  );

  const config = await loadAgentFile(path.join(BUILT_IN_DIR, "developer.yml"));
  expect(config.name).toBe("developer");
  expect(config.sandbox).toBe("writable");
  expect((config as Record<string, unknown>).tools).toBeUndefined();
});

it("accepts optional model as free string", async () => {
  await writeYaml(
    BUILT_IN_DIR,
    "smart-agent",
    `
name: smart-agent
description: "Agent with model override"
sandbox: readonly
prompt: "You are smart."
model: claude-opus-4-6
`,
  );

  const config = await loadAgentFile(path.join(BUILT_IN_DIR, "smart-agent.yml"));
  expect(config.model).toBe("claude-opus-4-6");
});

it("rejects agent without description", async () => {
  await writeYaml(
    BUILT_IN_DIR,
    "no-desc",
    `
name: no-desc
sandbox: readonly
prompt: "Test"
`,
  );

  await expect(loadAgentFile(path.join(BUILT_IN_DIR, "no-desc.yml"))).rejects.toThrow(
    "Invalid agent config",
  );
});

it("rejects agent without sandbox", async () => {
  await writeYaml(
    BUILT_IN_DIR,
    "no-sandbox",
    `
name: no-sandbox
description: "Test"
prompt: "Test"
`,
  );

  await expect(loadAgentFile(path.join(BUILT_IN_DIR, "no-sandbox.yml"))).rejects.toThrow(
    "Invalid agent config",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/agents.test.ts`
Expected: FAIL — old schema requires `tools` and `model` enum values.

- [ ] **Step 3: Update the agent schema**

In `packages/core/src/agents/schema.ts`, replace the entire file:

```typescript
import { z } from "zod";

// ─── Agent sandbox enum ──────────────────────────────────

export const agentSandboxSchema = z.enum(["writable", "readonly"]);

// ─── AgentConfig schema (from YAML) ─────────────────────

export const agentConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  sandbox: agentSandboxSchema,
  prompt: z.string(),
  model: z.string().optional(),
  promptAppend: z.string().optional(),
  maxTurns: z.number().optional(),
  maxCost: z.number().min(0).optional(),
  mcpServers: z.array(z.string()).optional(),
  version: z.string().optional(),
});

// ─── Derived types ───────────────────────────────────────

export type AgentConfig = z.infer<typeof agentConfigSchema>;
```

- [ ] **Step 4: Update all test data in agents.test.ts to match the new schema**

Remove all `tools` and `model` enum references from test YAML strings. Remove tests for inline `agents` subfield. Remove tests that assert on `tools` or `model` enum validation. Update `resolveAgent` tests (Task 2 will update the resolver, so mark resolver tests as skipped for now with `it.skip`).

Update the "loads real built-in agents" test expectations:

```typescript
it("loads real built-in agents from packages/agents", async () => {
  const realBuiltInDir = path.resolve(import.meta.dirname, "../../../agents/agents");
  const registry = new AgentRegistry(realBuiltInDir);
  await registry.load();

  expect(registry.list().length).toBeGreaterThanOrEqual(4);
  expect(registry.has("architect")).toBe(true);
  expect(registry.has("developer")).toBe(true);
  expect(registry.has("reviewer")).toBe(true);
  expect(registry.has("scout")).toBe(true);

  const arch = registry.get("architect");
  expect(arch).toBeDefined();
  expect(arch?.definition.description).toBeTruthy();
  expect(arch?.definition.prompt).toBeTruthy();
  expect(arch?.sandbox).toBe("writable");
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/agents.test.ts`
Expected: PASS (resolver tests skipped)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agents/schema.ts packages/core/src/__tests__/agents.test.ts
git commit -m "refactor(core): simplify agent schema — remove tools, model enum, subagents

Agent YAML now declares: name, description, sandbox, prompt, optional model (free string).
Removed agentToolSchema, agentModelSchema, subagentDefinitionSchema.
Part of provider-agnostic refactor."
```

---

### Task 2: Update Types, Resolver, and Loader

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/agents/resolver.ts`
- Modify: `packages/core/src/agents/loader.ts`
- Test: `packages/core/src/__tests__/agents.test.ts`

- [ ] **Step 1: Update types.ts — simplify AgentDefinition**

In `packages/core/src/types.ts`:

Remove `SubagentDefinition` interface. Remove `AgentModel`, `AgentTool`, `AgentToolEntry` re-exports. Simplify `AgentDefinition`:

```typescript
// Remove these re-exports:
// export type { AgentModel, AgentTool, AgentToolEntry } from "@/agents/schema";

// Keep this re-export:
export type { AgentConfig } from "@/agents/schema";
export type { GitStrategy, McpServerConfig, NeoConfig, RepoConfig } from "@/config";

// DELETE the SubagentDefinition interface entirely

// Simplified AgentDefinition:
export interface AgentDefinition {
  description: string;
  prompt: string;
  model?: string | undefined;
  mcpServers?: string[] | undefined;
}
```

Remove `tools` and `agents` from `AgentDefinition`. Remove `model` as required (now optional).

- [ ] **Step 2: Update resolver.ts — remove tools/agents requirements**

Replace `packages/core/src/agents/resolver.ts`:

```typescript
import type { AgentConfig } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent } from "@/types";

export function resolveAgent(config: AgentConfig): ResolvedAgent {
  if (!config.description) {
    throw new Error(
      `Agent "${config.name}" is missing "description". Add a 'description' field to the agent YAML.`,
    );
  }
  if (!config.sandbox) {
    throw new Error(
      `Agent "${config.name}" is missing "sandbox". Add a 'sandbox' field ('writable' or 'readonly').`,
    );
  }
  if (!config.prompt) {
    throw new Error(
      `Agent "${config.name}" is missing "prompt". Add a 'prompt' field or 'promptFile' reference.`,
    );
  }

  let prompt = config.prompt;
  if (config.promptAppend) {
    prompt = `${prompt}\n\n${config.promptAppend}`;
  }

  const definition: AgentDefinition = {
    description: config.description,
    prompt,
    ...(config.model ? { model: config.model } : {}),
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
  };

  return {
    name: config.name,
    definition,
    sandbox: config.sandbox,
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.maxCost !== undefined ? { maxCost: config.maxCost } : {}),
    ...(config.version !== undefined ? { version: config.version } : {}),
    source: "custom",
  };
}
```

- [ ] **Step 3: Update loader.ts — remove subagent prompt resolution**

In `packages/core/src/agents/loader.ts`, remove the entire `if (config.agents)` block (lines 56-69). The loader only resolves the main prompt now.

- [ ] **Step 4: Unskip resolver tests and update them**

In `packages/core/src/__tests__/agents.test.ts`, update the `resolveAgent` describe block:

```typescript
describe("resolveAgent", () => {
  it("resolves a complete agent config", () => {
    const config: AgentConfig = {
      name: "db-migrator",
      description: "Database migration specialist",
      prompt: "You handle DB migrations.",
      sandbox: "writable",
      model: "claude-opus-4-6",
      maxTurns: 20,
    };

    const resolved = resolveAgent(config);
    expect(resolved.name).toBe("db-migrator");
    expect(resolved.source).toBe("custom");
    expect(resolved.definition.description).toBe("Database migration specialist");
    expect(resolved.definition.model).toBe("claude-opus-4-6");
    expect(resolved.sandbox).toBe("writable");
    expect(resolved.maxTurns).toBe(20);
  });

  it("resolves agent without model (uses provider default)", () => {
    const config: AgentConfig = {
      name: "basic",
      description: "Basic agent",
      prompt: "You are basic.",
      sandbox: "readonly",
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.model).toBeUndefined();
  });

  it("throws for agent missing description", () => {
    const config = {
      name: "incomplete",
      prompt: "Test",
      sandbox: "readonly",
    } as AgentConfig;

    expect(() => resolveAgent(config)).toThrow("description");
  });

  it("throws for agent missing sandbox", () => {
    const config = {
      name: "incomplete",
      description: "Test agent",
      prompt: "Test",
    } as AgentConfig;

    expect(() => resolveAgent(config)).toThrow("sandbox");
  });

  it("throws for agent missing prompt", () => {
    const config = {
      name: "incomplete",
      description: "Test agent",
      sandbox: "readonly",
    } as AgentConfig;

    expect(() => resolveAgent(config)).toThrow("prompt");
  });

  it("applies promptAppend to prompt", () => {
    const config: AgentConfig = {
      name: "dev-extra",
      description: "Developer",
      prompt: "You are a developer.",
      promptAppend: "Always use Vitest.",
      sandbox: "writable",
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.prompt).toBe("You are a developer.\n\nAlways use Vitest.");
  });

  it("carries mcpServers from agent config into definition", () => {
    const config: AgentConfig = {
      name: "dev-notion",
      description: "Dev with MCP",
      prompt: "You are a dev with Notion.",
      sandbox: "writable",
      mcpServers: ["notion", "github"],
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.mcpServers).toEqual(["notion", "github"]);
  });

  it("parses maxCost field when present", () => {
    const config: AgentConfig = {
      name: "budget-agent",
      description: "Agent with budget",
      prompt: "You are a budget-limited agent.",
      sandbox: "writable",
      maxCost: 5.0,
    };

    const resolved = resolveAgent(config);
    expect(resolved.maxCost).toBe(5.0);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/agents.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/agents/resolver.ts packages/core/src/agents/loader.ts packages/core/src/__tests__/agents.test.ts
git commit -m "refactor(core): simplify AgentDefinition, resolver, and loader

Remove SubagentDefinition, tools, agents from types.
Resolver no longer requires tools or model.
Loader no longer resolves subagent prompts."
```

---

### Task 3: Add Provider Config Schema

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Test: `packages/core/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing tests for provider config**

Add to `packages/core/src/__tests__/config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { neoConfigSchema } from "@/config/schema";

describe("provider config", () => {
  it("parses valid provider config", () => {
    const config = neoConfigSchema.parse({
      provider: {
        adapter: "claude",
        models: {
          default: "claude-sonnet-4-6",
          available: ["claude-sonnet-4-6", "claude-opus-4-6"],
        },
      },
    });

    expect(config.provider.adapter).toBe("claude");
    expect(config.provider.models.default).toBe("claude-sonnet-4-6");
    expect(config.provider.models.available).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
    expect(config.provider.args).toEqual([]);
    expect(config.provider.env).toEqual({});
  });

  it("rejects models.default not in models.available", () => {
    expect(() =>
      neoConfigSchema.parse({
        provider: {
          adapter: "claude",
          models: {
            default: "gpt-4o",
            available: ["claude-sonnet-4-6"],
          },
        },
      }),
    ).toThrow("models.default must be in models.available");
  });

  it("rejects empty models.available", () => {
    expect(() =>
      neoConfigSchema.parse({
        provider: {
          adapter: "claude",
          models: {
            default: "claude-sonnet-4-6",
            available: [],
          },
        },
      }),
    ).toThrow();
  });

  it("accepts provider.args and provider.env", () => {
    const config = neoConfigSchema.parse({
      provider: {
        adapter: "codex",
        models: { default: "o3", available: ["o3"] },
        args: ["--full-auto"],
        env: { OPENAI_API_KEY: "sk-test" },
      },
    });

    expect(config.provider.args).toEqual(["--full-auto"]);
    expect(config.provider.env).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("supervisor.adapter and supervisor.model are optional", () => {
    const config = neoConfigSchema.parse({
      provider: {
        adapter: "claude",
        models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
      },
    });

    expect(config.supervisor.adapter).toBeUndefined();
    expect(config.supervisor.model).toBe("claude-sonnet-4-6");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/config.test.ts`
Expected: FAIL — `provider` field doesn't exist in schema.

- [ ] **Step 3: Add providerConfigSchema to config/schema.ts**

In `packages/core/src/config/schema.ts`, add before the `supervisorConfigSchema`:

```typescript
// ─── Provider config schema ─────────────────────────────

const providerModelsSchema = z.object({
  default: z.string(),
  available: z.array(z.string()).min(1),
});

export const providerConfigSchema = z.object({
  adapter: z.string(),
  models: providerModelsSchema.refine((m) => m.available.includes(m.default), {
    message: "models.default must be in models.available",
  }),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
```

- [ ] **Step 4: Update supervisorConfigSchema**

Remove `provider` and keep `model` as default (it now falls back to `provider.models.default`). Add optional `adapter` field:

```typescript
export const supervisorConfigSchema = z
  .object({
    port: z.number().default(7777),
    secret: z.string().optional(),
    heartbeatTimeoutMs: z.number().default(300_000),
    maxConsecutiveFailures: z.number().default(3),
    maxEventsPerSec: z.number().default(10),
    dailyCapUsd: z.number().default(50),
    consolidationIntervalMs: z.number().default(300_000),
    compactionIntervalMs: z.number().default(3_600_000),
    eventTimeoutMs: z.number().default(300_000),
    instructions: z.string().optional(),
    idleSkipMax: z.number().default(20),
    activeWorkSkipMax: z.number().default(3),
    autoDecide: z.boolean().default(false),
    /** Optional override: supervisor adapter (falls back to provider.adapter) */
    adapter: z.string().optional(),
    /** Claude model used for supervisor heartbeats (falls back to provider.models.default) */
    model: z.string().default("claude-sonnet-4-6"),
  })
  .default({
    port: 7777,
    heartbeatTimeoutMs: 300_000,
    maxConsecutiveFailures: 3,
    maxEventsPerSec: 10,
    dailyCapUsd: 50,
    consolidationIntervalMs: 300_000,
    compactionIntervalMs: 3_600_000,
    eventTimeoutMs: 300_000,
    idleSkipMax: 20,
    activeWorkSkipMax: 3,
    autoDecide: false,
    model: "claude-sonnet-4-6",
  });
```

- [ ] **Step 5: Add provider to globalConfigSchema and remove claudeCodePath**

In `globalConfigSchema`, add the `provider` field and remove `claudeCodePath`:

```typescript
export const globalConfigSchema = z.object({
  repos: z.array(repoConfigSchema).default([]),
  provider: providerConfigSchema,
  concurrency: concurrencyConfigSchema,
  budget: budgetConfigSchema,
  recovery: recoveryConfigSchema,
  sessions: sessionsConfigSchema,
  journal: journalConfigSchema.optional(),
  webhooks: z.array(
    z.object({
      url: z.string().url(),
      events: z.array(z.string()).optional(),
      secret: z.string().optional(),
      timeoutMs: z.number().default(5000),
    }),
  ).default([]),
  supervisor: supervisorConfigSchema,
  memory: z.object({
    embeddings: z.boolean().default(true),
  }).default({ embeddings: true }),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  idempotency: z.object({
    enabled: z.boolean().default(true),
    key: z.enum(["metadata", "prompt"]).default("metadata"),
    ttlMs: z.number().default(3_600_000),
  }).optional(),
});
```

- [ ] **Step 6: Export new types**

Add to `packages/core/src/config/schema.ts` derived types:

```typescript
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
```

- [ ] **Step 7: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/config.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/__tests__/config.test.ts
git commit -m "feat(core): add provider config schema with adapter registry and model whitelist

New providerConfigSchema: adapter, models (default + available), args, env.
Supervisor can optionally override adapter and model.
Removed claudeCodePath from global config."
```

---

### Task 4: Simplify SandboxConfig

**Files:**
- Modify: `packages/core/src/isolation/sandbox.ts`
- Modify: `packages/core/src/__tests__/isolation.test.ts`

- [ ] **Step 1: Update SandboxConfig interface**

In `packages/core/src/isolation/sandbox.ts`:

```typescript
import { resolve } from "node:path";
import type { ResolvedAgent } from "@/types";

export interface SandboxConfig {
  writable: boolean;
  paths: {
    readable: string[];
    writable: string[];
  };
}

export function buildSandboxConfig(agent: ResolvedAgent, sessionPath?: string): SandboxConfig {
  const isWritable = agent.sandbox === "writable";
  const absSession = sessionPath ? resolve(sessionPath) : undefined;

  const readable = absSession ? [absSession] : [];
  const writable = isWritable && absSession ? [absSession] : [];

  return {
    writable: isWritable,
    paths: { readable, writable },
  };
}
```

- [ ] **Step 2: Fix compilation errors from SandboxConfig consumers**

Search for `sandboxConfig.allowedTools` and `sandboxConfig.readablePaths` / `sandboxConfig.writablePaths` across the codebase and update to use `sandboxConfig.writable` and `sandboxConfig.paths.readable` / `sandboxConfig.paths.writable`.

Key files:
- `packages/core/src/runner/adapters/claude-session.ts`: remove `allowedTools` from queryOptions
- `packages/core/src/runner/session.ts`: update `buildRunOptions` — remove `agents` and `claudeCodePath` from adapterOptions

- [ ] **Step 3: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/isolation.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/isolation/sandbox.ts
git commit -m "refactor(core): simplify SandboxConfig — remove allowedTools, keep writable + paths

Sandbox is now a boolean writable flag + path lists.
Each adapter translates writable into its CLI sandbox mechanism."
```

---

### Task 5: Update AgentRunOptions and Runner Adapters

**Files:**
- Modify: `packages/core/src/supervisor/ai-adapter.ts`
- Modify: `packages/core/src/runner/adapters/claude-session.ts`
- Modify: `packages/core/src/runner/adapters/codex-session.ts`
- Modify: `packages/core/src/runner/adapters/index.ts`
- Test: `packages/core/src/__tests__/session-adapter-factory.test.ts`

- [ ] **Step 1: Update ai-adapter.ts**

In `packages/core/src/supervisor/ai-adapter.ts`:

Remove `AIProvider` type. Update `SessionHandle` to use `adapter` discriminant. Simplify `AgentRunOptions` — remove `allowedTools` reference from `sandboxConfig`:

```typescript
import type { McpServerConfig, ProviderConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import type { SDKStreamMessage } from "@/sdk-types";
import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Session handles ──────────────────────────────────────

export interface ClaudeSessionHandle {
  adapter: "claude";
  sessionId: string;
}

export interface CodexSessionHandle {
  adapter: "codex";
  threadId: string;
}

export type SessionHandle = ClaudeSessionHandle | CodexSessionHandle;

// ─── Messages ────────────────────────────────────────────

export type SupervisorMessageKind = "text" | "tool_use" | "end";

export interface SupervisorMessage {
  kind: SupervisorMessageKind;
  toolName?: string;
  toolInput?: unknown;
  text?: string;
  metadata?: { costUsd?: number; turnCount?: number };
}

// ─── Query options ────────────────────────────────────────

export interface AIQueryOptions {
  prompt: string;
  tools: ToolDefinition[];
  sessionHandle?: SessionHandle;
  systemPrompt?: string;
  model?: string;
}

// ─── Supervisor Adapter ──────────────────────────────────

export interface AIAdapter {
  query(options: AIQueryOptions): AsyncIterable<SupervisorMessage>;
  getSessionHandle(): SessionHandle | undefined;
  restoreSession(handle: SessionHandle): void;
}

// ─── Agent Runner ───────────────────────────────────────

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  maxTurns?: number;
  resumeSessionId?: string;
  model?: string;
  providerConfig?: ProviderConfig;
}

export interface AgentRunner {
  run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage>;
}

// ─── Deprecated aliases ─────────────────────────────────

/** @deprecated Use AgentRunOptions */
export type SessionRunOptions = AgentRunOptions;

/** @deprecated Use AgentRunner */
export type SessionAdapter = AgentRunner;
```

- [ ] **Step 2: Update ClaudeAgentRunner**

In `packages/core/src/runner/adapters/claude-session.ts`:

```typescript
import type { SDKStreamMessage } from "@/sdk-types";
import type { AgentRunOptions, AgentRunner } from "@/supervisor/ai-adapter";

export class ClaudeAgentRunner implements AgentRunner {
  async *run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const queryOptions: Record<string, unknown> = {
      cwd: options.cwd,
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      persistSession: false,
    };

    if (options.resumeSessionId) {
      queryOptions.resume = options.resumeSessionId;
    }

    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      queryOptions.mcpServers = options.mcpServers;
    }

    if (options.env && Object.keys(options.env).length > 0) {
      queryOptions.env = { ...process.env, ...options.env };
    }

    if (options.model) {
      queryOptions.model = options.model;
    }

    // Pass provider-level extra args if present
    if (options.providerConfig?.args?.length) {
      queryOptions.additionalArgs = options.providerConfig.args;
    }

    const stream = sdk.query({ prompt: options.prompt, options: queryOptions as never });

    for await (const message of stream) {
      yield message as SDKStreamMessage;
    }
  }
}
```

- [ ] **Step 3: Update CodexAgentRunner**

In `packages/core/src/runner/adapters/codex-session.ts`, update to receive `providerConfig`:

```typescript
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { SDKStreamMessage } from "@/sdk-types";
import type { AgentRunOptions, AgentRunner } from "@/supervisor/ai-adapter";

interface CodexJsonlEvent {
  type: string;
  id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  usage?: {
    total_cost_usd?: number;
    turns?: number;
  };
}

function mapCodexEvent(event: CodexJsonlEvent): SDKStreamMessage {
  switch (event.type) {
    case "session.start":
      return {
        type: "system",
        subtype: "init",
        session_id: event.id ?? "unknown",
      } as SDKStreamMessage;

    case "message.completed":
      return {
        type: "assistant",
        message: { content: event.message?.content ?? [] },
      } as SDKStreamMessage;

    case "session.completed":
      return {
        type: "result",
        subtype: "success",
        session_id: event.id ?? "unknown",
        result: "",
        total_cost_usd: event.usage?.total_cost_usd ?? 0,
        num_turns: event.usage?.turns ?? 0,
      } as SDKStreamMessage;

    default:
      return { type: event.type } as SDKStreamMessage;
  }
}

export class CodexAgentRunner implements AgentRunner {
  async *run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    const args = ["exec", "--json"];

    // Add provider-level args (e.g. --full-auto)
    if (options.providerConfig?.args?.length) {
      args.push(...options.providerConfig.args);
    }

    if (!options.sandboxConfig.writable) {
      args.push("--sandbox", "read-only");
    } else {
      args.push("--sandbox", "workspace-write");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    args.push(options.prompt);

    const providerEnv = options.providerConfig?.env ?? {};
    const child = execFile("codex", args, {
      cwd: options.cwd,
      env: { ...process.env, ...providerEnv, ...options.env },
    });

    if (!child.stdout) {
      throw new Error("codex exec: stdout is null");
    }

    const rl = createInterface({ input: child.stdout });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CodexJsonlEvent;
        yield mapCodexEvent(event);
      } catch {
        // Skip non-JSON lines
      }
    }

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`codex exec exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  }
}
```

- [ ] **Step 4: Update adapter factory — registry pattern**

Replace `packages/core/src/runner/adapters/index.ts`:

```typescript
import type { ProviderConfig } from "@/config";
import type { AgentRunner } from "@/supervisor/ai-adapter";
import { ClaudeAgentRunner } from "./claude-session.js";
import { CodexAgentRunner } from "./codex-session.js";

export interface AgentRunnerFactory {
  create(config: ProviderConfig): AgentRunner;
}

const registry = new Map<string, AgentRunnerFactory>();

registry.set("claude", {
  create: () => new ClaudeAgentRunner(),
});

registry.set("codex", {
  create: () => new CodexAgentRunner(),
});

export function createAgentRunner(config: ProviderConfig): AgentRunner {
  const factory = registry.get(config.adapter);
  if (!factory) {
    throw new Error(
      `Unknown adapter "${config.adapter}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return factory.create(config);
}

export function registerAdapter(name: string, factory: AgentRunnerFactory): void {
  registry.set(name, factory);
}

export { ClaudeAgentRunner } from "./claude-session.js";
export { CodexAgentRunner } from "./codex-session.js";
```

- [ ] **Step 5: Update adapter factory tests**

Replace `packages/core/src/__tests__/session-adapter-factory.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/config";
import { ClaudeAgentRunner } from "@/runner/adapters/claude-session";
import { CodexAgentRunner } from "@/runner/adapters/codex-session";
import { createAgentRunner } from "@/runner/adapters/index";

const claudeConfig: ProviderConfig = {
  adapter: "claude",
  models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
  args: [],
  env: {},
};

const codexConfig: ProviderConfig = {
  adapter: "codex",
  models: { default: "o3", available: ["o3"] },
  args: ["--full-auto"],
  env: {},
};

describe("createAgentRunner", () => {
  it("returns ClaudeAgentRunner for claude adapter", () => {
    const runner = createAgentRunner(claudeConfig);
    expect(runner).toBeInstanceOf(ClaudeAgentRunner);
  });

  it("returns CodexAgentRunner for codex adapter", () => {
    const runner = createAgentRunner(codexConfig);
    expect(runner).toBeInstanceOf(CodexAgentRunner);
  });

  it("throws for unknown adapter", () => {
    const badConfig = { ...claudeConfig, adapter: "gemini" };
    expect(() => createAgentRunner(badConfig)).toThrow('Unknown adapter "gemini"');
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/session-adapter-factory.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/ai-adapter.ts packages/core/src/runner/adapters/claude-session.ts packages/core/src/runner/adapters/codex-session.ts packages/core/src/runner/adapters/index.ts packages/core/src/__tests__/session-adapter-factory.test.ts
git commit -m "refactor(core): adapter registry, simplified AgentRunOptions, provider config passthrough

Factory uses Map registry instead of switch/enum.
AgentRunOptions receives providerConfig for args/env.
Removed AIProvider type, allowedTools, adapterOptions.
SessionHandle uses adapter discriminant."
```

---

### Task 6: Update Session Runner and Executor

**Files:**
- Modify: `packages/core/src/runner/session.ts`
- Modify: `packages/core/src/runner/session-executor.ts`
- Test: `packages/core/src/__tests__/runner.test.ts`

- [ ] **Step 1: Update session.ts — remove agents/claudeCodePath/hooks from SessionOptions**

In `packages/core/src/runner/session.ts`:

Remove `agents`, `claudeCodePath`, `hooks` from `SessionOptions`. Update `buildRunOptions` to pass `providerConfig` instead of `adapterOptions`:

```typescript
export interface SessionOptions {
  agent: ResolvedAgent;
  prompt: string;
  repoPath?: string;
  sessionPath?: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  initTimeoutMs: number;
  maxDurationMs: number;
  maxTurns?: number | undefined;
  resumeSessionId?: string | undefined;
  onEvent?: ((event: SessionEvent) => void) | undefined;
  adapter?: AgentRunner | undefined;
  providerConfig?: ProviderConfig | undefined;
}
```

Update `buildRunOptions`:

```typescript
function buildRunOptions(options: SessionOptions): AgentRunOptions {
  const runOptions: AgentRunOptions = {
    prompt: options.prompt,
    cwd: options.sessionPath ?? options.repoPath ?? process.cwd(),
    sandboxConfig: options.sandboxConfig,
  };

  if (options.mcpServers) runOptions.mcpServers = options.mcpServers;
  if (options.env) runOptions.env = options.env;
  if (options.maxTurns !== undefined) runOptions.maxTurns = options.maxTurns;
  if (options.resumeSessionId !== undefined) runOptions.resumeSessionId = options.resumeSessionId;
  if (options.providerConfig) runOptions.providerConfig = options.providerConfig;

  return runOptions;
}
```

- [ ] **Step 2: Update session-executor.ts — remove agents passthrough**

In `packages/core/src/runner/session-executor.ts`:

Remove `agents: agent.definition.agents` from the `runWithRecovery` call. Remove `claudeCodePath` passthrough. Add `providerConfig` passthrough instead. Remove the `buildSDKHooks` call and middleware chain (these are Claude-specific — the middleware system needs separate treatment but is out of scope for this refactor).

Actually — keep the middleware/hooks system as-is for now. It's internal to neo and works independently of the provider. Just remove the `agents` field from the recovery options.

- [ ] **Step 3: Run all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run`
Expected: PASS (or identify remaining compilation errors to fix)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runner/session.ts packages/core/src/runner/session-executor.ts
git commit -m "refactor(core): simplify session runner — remove agents/claudeCodePath, add providerConfig

SessionOptions no longer carries agents or claudeCodePath.
Provider config flows through to AgentRunOptions."
```

---

### Task 7: Simplify Agent YAML Files and Extract Subagents

**Files:**
- Modify: `packages/agents/agents/architect.yml`
- Modify: `packages/agents/agents/developer.yml`
- Modify: `packages/agents/agents/reviewer.yml`
- Modify: `packages/agents/agents/scout.yml`
- Create: `packages/agents/agents/spec-reviewer.yml`
- Create: `packages/agents/agents/code-quality-reviewer.yml`
- Create: `packages/agents/agents/plan-reviewer.yml`

- [ ] **Step 1: Simplify architect.yml**

```yaml
name: architect
description: "Analyzes feature requests, designs architecture, and writes implementation plans to .neo/specs/. Writes code in plans, NEVER modifies source files."
sandbox: writable
model: claude-opus-4-6
prompt: ../prompts/architect.md
```

- [ ] **Step 2: Simplify developer.yml**

```yaml
name: developer
description: "Executes implementation plans step by step in an isolated git clone."
sandbox: writable
prompt: ../prompts/developer.md
```

- [ ] **Step 3: Simplify reviewer.yml**

```yaml
name: reviewer
description: "Two-pass reviewer: spec compliance first, then code quality. Covers quality, standards, security, performance, and test coverage. Challenges by default — approves only when standards are met."
sandbox: readonly
prompt: ../prompts/reviewer.md
```

- [ ] **Step 4: Simplify scout.yml**

```yaml
name: scout
description: "Autonomous codebase explorer. Deep-dives into a repository to surface bugs, improvements, security issues, tech debt, and optimization opportunities. Produces actionable decisions for the supervisor."
sandbox: readonly
model: claude-opus-4-6
prompt: ../prompts/scout.md
```

- [ ] **Step 5: Create spec-reviewer.yml**

```yaml
name: spec-reviewer
description: "Verify implementation matches task specification exactly. Use after completing each task to ensure nothing is missing or extra."
sandbox: readonly
prompt: ../prompts/subagents/spec-reviewer.md
```

- [ ] **Step 6: Create code-quality-reviewer.yml**

```yaml
name: code-quality-reviewer
description: "Review code quality, patterns, and test coverage. Use ONLY after spec-reviewer approves."
sandbox: readonly
prompt: ../prompts/subagents/code-quality-reviewer.md
```

- [ ] **Step 7: Create plan-reviewer.yml**

```yaml
name: plan-reviewer
description: "Review implementation plan for completeness, spec alignment, and buildability."
sandbox: readonly
prompt: ../prompts/subagents/plan-reviewer.md
```

- [ ] **Step 8: Update agents.test.ts expectation for agent count**

In the "loads real built-in agents" test, update the count from 4 to 7 (4 existing + 3 new standalone subagents):

```typescript
expect(registry.list().length).toBe(7);
expect(registry.has("spec-reviewer")).toBe(true);
expect(registry.has("code-quality-reviewer")).toBe(true);
expect(registry.has("plan-reviewer")).toBe(true);
```

- [ ] **Step 9: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/agents.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/agents/agents/ packages/core/src/__tests__/agents.test.ts
git commit -m "refactor(agents): simplify YAML configs, extract subagents to standalone files

Removed tools, model enum, agents blocks from all YAML.
Created spec-reviewer.yml, code-quality-reviewer.yml, plan-reviewer.yml.
Model is now optional free string (e.g. claude-opus-4-6)."
```

---

### Task 8: Update Public Exports and Fix Remaining References

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/supervisor/index.ts`

- [ ] **Step 1: Update core index.ts exports**

In `packages/core/src/index.ts`, remove deleted schema exports:

```typescript
// Remove these lines:
// agentModelSchema,
// agentToolEntrySchema,
// agentToolSchema,

// Add new export:
export { providerConfigSchema } from "@/config/schema";
export type { ProviderConfig } from "@/config/schema";
```

- [ ] **Step 2: Update supervisor/index.ts exports**

In `packages/core/src/supervisor/index.ts`, replace `AIProvider` export:

```typescript
// Change this line:
// export type { AgentRunOptions, AgentRunner, AIProvider } from "./ai-adapter.js";
// To:
export type { AgentRunOptions, AgentRunner, SessionHandle, ClaudeSessionHandle, CodexSessionHandle } from "./ai-adapter.js";
```

- [ ] **Step 3: Search and fix remaining references to deleted types**

Run: `grep -r "AIProvider\|AgentTool\|AgentModel\|agentToolSchema\|agentModelSchema\|SubagentDefinition" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v node_modules`

Fix any remaining references in source code.

- [ ] **Step 4: Run full typecheck and tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/supervisor/index.ts
git commit -m "refactor(core): update public exports — remove deleted types, add ProviderConfig

Removed AgentTool, AgentModel, agentToolSchema exports.
Added ProviderConfig and providerConfigSchema exports."
```

---

### Task 9: Add Model Validation at Boot

**Files:**
- Create: `packages/core/src/agents/validation.ts`
- Test: `packages/core/src/__tests__/agents.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/core/src/__tests__/agents.test.ts`:

```typescript
import { validateAgentModels } from "@/agents/validation";
import type { ProviderConfig } from "@/config/schema";

describe("validateAgentModels", () => {
  const provider: ProviderConfig = {
    adapter: "claude",
    models: {
      default: "claude-sonnet-4-6",
      available: ["claude-sonnet-4-6", "claude-opus-4-6"],
    },
    args: [],
    env: {},
  };

  it("passes for agents with valid models", () => {
    const agents = [
      { name: "dev", definition: { description: "Dev", prompt: "test", model: "claude-opus-4-6" }, sandbox: "writable" as const, source: "built-in" as const },
    ];
    expect(() => validateAgentModels(agents, provider)).not.toThrow();
  });

  it("passes for agents without model (uses default)", () => {
    const agents = [
      { name: "dev", definition: { description: "Dev", prompt: "test" }, sandbox: "writable" as const, source: "built-in" as const },
    ];
    expect(() => validateAgentModels(agents, provider)).not.toThrow();
  });

  it("throws for agent with model not in available list", () => {
    const agents = [
      { name: "dev", definition: { description: "Dev", prompt: "test", model: "gpt-4o" }, sandbox: "writable" as const, source: "built-in" as const },
    ];
    expect(() => validateAgentModels(agents, provider)).toThrow(
      'Agent "dev" specifies model "gpt-4o"',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/agents.test.ts`
Expected: FAIL — `validateAgentModels` doesn't exist.

- [ ] **Step 3: Implement validateAgentModels**

Create `packages/core/src/agents/validation.ts`:

```typescript
import type { ProviderConfig } from "@/config/schema";
import type { ResolvedAgent } from "@/types";

export function validateAgentModels(agents: ResolvedAgent[], provider: ProviderConfig): void {
  for (const agent of agents) {
    if (agent.definition.model && !provider.models.available.includes(agent.definition.model)) {
      throw new Error(
        `Agent "${agent.name}" specifies model "${agent.definition.model}" ` +
          `which is not in provider.models.available: [${provider.models.available.join(", ")}]`,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/agents.test.ts`
Expected: PASS

- [ ] **Step 5: Export from index**

Add to `packages/core/src/index.ts`:

```typescript
export { validateAgentModels } from "@/agents/validation";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agents/validation.ts packages/core/src/__tests__/agents.test.ts packages/core/src/index.ts
git commit -m "feat(core): add validateAgentModels — validates agent models against provider whitelist

Called at supervisor boot to catch model mismatches early."
```

---

### Task 10: Full Validation Pass

- [ ] **Step 1: Run typecheck**

Run: `cd /Users/karl/Documents/neo && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/karl/Documents/neo && pnpm test`
Expected: PASS (fix any remaining failures)

- [ ] **Step 3: Run build**

Run: `cd /Users/karl/Documents/neo && pnpm build`
Expected: PASS

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(core): resolve remaining compilation and test issues from provider-agnostic refactor"
```
