# Multi-Provider Model Catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `provider` config block with a built-in model catalog that auto-resolves adapters from model strings, enabling per-agent multi-provider.

**Architecture:** Create `models.ts` with `SUPPORTED_MODELS` map and `MODEL_ALIASES`. Config reduces to `models.default`. Adapter factory takes a string instead of `ProviderConfig`. Delete `providerConfigSchema`, `ProviderConfig`, `validateAgentModels`.

**Tech Stack:** TypeScript, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-18-multi-provider-models-design.md`

---

### Task 1: Create Model Catalog

**Files:**
- Create: `packages/core/src/models.ts`
- Test: `packages/core/src/__tests__/models.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/models.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getAdapter, listModels, MODEL_ALIASES, resolveModel, SUPPORTED_MODELS } from "@/models";

describe("SUPPORTED_MODELS", () => {
  it("contains claude models", () => {
    expect(SUPPORTED_MODELS["claude-sonnet-4-6"]).toBe("claude");
    expect(SUPPORTED_MODELS["claude-opus-4-7"]).toBe("claude");
    expect(SUPPORTED_MODELS["claude-opus-4-6"]).toBe("claude");
    expect(SUPPORTED_MODELS["claude-haiku-4-5"]).toBe("claude");
  });

  it("contains codex models", () => {
    expect(SUPPORTED_MODELS["gpt-5.4"]).toBe("codex");
    expect(SUPPORTED_MODELS["gpt-5.4-mini"]).toBe("codex");
  });
});

describe("MODEL_ALIASES", () => {
  it("maps short names to canonical IDs", () => {
    expect(MODEL_ALIASES.opus).toBe("claude-opus-4-7");
    expect(MODEL_ALIASES.sonnet).toBe("claude-sonnet-4-6");
    expect(MODEL_ALIASES.haiku).toBe("claude-haiku-4-5");
  });
});

describe("resolveModel", () => {
  it("resolves aliases to canonical model ID", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-7");
    expect(resolveModel("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("returns non-alias model as-is", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModel("gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("getAdapter", () => {
  it("returns claude for claude models", () => {
    expect(getAdapter("claude-sonnet-4-6")).toBe("claude");
    expect(getAdapter("claude-opus-4-7")).toBe("claude");
  });

  it("returns codex for codex models", () => {
    expect(getAdapter("gpt-5.4")).toBe("codex");
    expect(getAdapter("gpt-5.4-mini")).toBe("codex");
  });

  it("resolves aliases before lookup", () => {
    expect(getAdapter("opus")).toBe("claude");
    expect(getAdapter("sonnet")).toBe("claude");
  });

  it("throws for unknown model", () => {
    expect(() => getAdapter("unknown-model")).toThrow('Unknown model "unknown-model"');
  });
});

describe("listModels", () => {
  it("returns all supported model IDs", () => {
    const models = listModels();
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("gpt-5.4");
    expect(models.length).toBeGreaterThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/models.test.ts`
Expected: FAIL — module `@/models` doesn't exist.

- [ ] **Step 3: Create models.ts**

Create `packages/core/src/models.ts`:

```typescript
// ─── Supported models ───────────────────────────────────
// Single source of truth: model ID → adapter name.
// Adding a model = adding one line here.

export const SUPPORTED_MODELS: Record<string, string> = {
  // Anthropic — via claude CLI
  "claude-opus-4-7": "claude",
  "claude-opus-4-6": "claude",
  "claude-sonnet-4-6": "claude",
  "claude-haiku-4-5": "claude",

  // OpenAI — via codex CLI
  "gpt-5.4": "codex",
  "gpt-5.4-mini": "codex",
};

// ─── Aliases ────────────────────────────────────────────
// Short names → canonical model ID.

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

// ─── Functions ──────────────────────────────────────────

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export function getAdapter(model: string): string {
  const resolved = resolveModel(model);
  const adapter = SUPPORTED_MODELS[resolved];
  if (!adapter) {
    throw new Error(
      `Unknown model "${model}". Supported: ${[...Object.keys(SUPPORTED_MODELS), ...Object.keys(MODEL_ALIASES)].join(", ")}`,
    );
  }
  return adapter;
}

export function listModels(): string[] {
  return Object.keys(SUPPORTED_MODELS);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/models.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/models.ts packages/core/src/__tests__/models.test.ts
git commit -m "feat(core): add model catalog with SUPPORTED_MODELS, aliases, and getAdapter

Single source of truth for model → adapter mapping.
Aliases: opus, sonnet, haiku → canonical Claude model IDs."
```

---

### Task 2: Replace Provider Config with Models Config

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/config/merge.ts`
- Modify: `packages/core/src/config/index.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config/parser.ts`
- Test: `packages/core/src/__tests__/config.test.ts`

- [ ] **Step 1: Update config/schema.ts**

1. Delete `providerModelsSchema` and `providerConfigSchema`.
2. Add `modelsConfigSchema` before `supervisorConfigSchema`:

```typescript
// ─── Models config schema ───────────────────────────────

export const modelsConfigSchema = z.object({
  default: z.string(),
}).default({
  default: "claude-sonnet-4-6",
});
```

3. In `globalConfigSchema`, replace the `provider` field:

```typescript
  // Replace:
  // provider: providerConfigSchema.default({...}),
  // With:
  models: modelsConfigSchema,
```

4. Remove `supervisor.adapter` field from `supervisorConfigSchema` (adapter is now auto-resolved from model).

5. Update the `ProviderConfig` type export — delete it and add:
```typescript
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
```

- [ ] **Step 2: Update config/merge.ts**

Replace the `provider` block in `defaultConfig` with:

```typescript
  models: { default: "claude-sonnet-4-6" },
```

Remove the old `provider: { adapter: ..., models: ..., args: ..., env: ... }` block.

- [ ] **Step 3: Update config/index.ts and config.ts**

Replace `ProviderConfig` and `providerConfigSchema` exports with `ModelsConfig` and `modelsConfigSchema`.

- [ ] **Step 4: Update config/parser.ts**

Replace `provider.*` known keys with `models.default`.

- [ ] **Step 5: Update config tests**

In `packages/core/src/__tests__/config.test.ts`, replace provider config tests with models config tests:

```typescript
describe("models config", () => {
  it("parses valid models config", () => {
    const config = neoConfigSchema.parse({
      models: { default: "claude-sonnet-4-6" },
    });
    expect(config.models.default).toBe("claude-sonnet-4-6");
  });

  it("uses default when models not specified", () => {
    const config = neoConfigSchema.parse({});
    expect(config.models.default).toBe("claude-sonnet-4-6");
  });
});
```

Remove tests that reference `provider.adapter`, `provider.models.available`, etc.

- [ ] **Step 6: Fix all test files that reference `provider`**

Search for `provider:` in test config fixtures and replace with `models:`. Search for `config.provider` in source and test files and fix.

- [ ] **Step 7: Run typecheck and tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test -- --run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/config/ packages/core/src/__tests__/
git commit -m "refactor(core): replace provider config with models.default

Deleted providerConfigSchema, ProviderConfig.
New modelsConfigSchema with single default field.
Config reduces from provider block to models.default."
```

---

### Task 3: Simplify Adapter Factory and AgentRunOptions

**Files:**
- Modify: `packages/core/src/supervisor/ai-adapter.ts`
- Modify: `packages/core/src/runner/adapters/index.ts`
- Modify: `packages/core/src/runner/adapters/codex-session.ts`
- Modify: `packages/core/src/runner/session.ts`
- Test: `packages/core/src/__tests__/session-adapter-factory.test.ts`

- [ ] **Step 1: Remove providerConfig from AgentRunOptions**

In `packages/core/src/supervisor/ai-adapter.ts`, remove the `providerConfig` field and the `ProviderConfig` import:

```typescript
import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import type { SDKStreamMessage } from "@/sdk-types";

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  maxTurns?: number;
  resumeSessionId?: string;
  model?: string;
}
```

- [ ] **Step 2: Simplify adapter factory**

Replace `packages/core/src/runner/adapters/index.ts`:

```typescript
import type { AgentRunner } from "@/supervisor/ai-adapter";
import { ClaudeAgentRunner } from "./claude-session.js";
import { CodexAgentRunner } from "./codex-session.js";

export interface AgentRunnerFactory {
  create(): AgentRunner;
}

const registry = new Map<string, AgentRunnerFactory>();

registry.set("claude", { create: () => new ClaudeAgentRunner() });
registry.set("codex", { create: () => new CodexAgentRunner() });

export function createAgentRunner(adapter: string): AgentRunner {
  const factory = registry.get(adapter);
  if (!factory) {
    throw new Error(
      `Unknown adapter "${adapter}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return factory.create();
}

export function registerAdapter(name: string, factory: AgentRunnerFactory): void {
  registry.set(name, factory);
}

export { ClaudeAgentRunner } from "./claude-session.js";
export { CodexAgentRunner } from "./codex-session.js";
```

- [ ] **Step 3: Clean up CodexAgentRunner**

In `packages/core/src/runner/adapters/codex-session.ts`, remove `providerConfig` references. The `additionalDirectories` line that used `providerConfig.args` should be removed:

```typescript
  async *run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    const codex = await this.getCodex();

    const thread = codex.startThread({
      ...(options.model ? { model: options.model } : {}),
      workingDirectory: options.cwd,
      sandboxMode: options.sandboxConfig.writable ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      webSearchEnabled: true,
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
    });

    const { events } = await thread.runStreamed(options.prompt);

    for await (const event of events) {
      const mapped = mapThreadEvent(event as ThreadEvent);
      if (mapped) yield mapped;
    }
  }
```

- [ ] **Step 4: Clean up session.ts**

In `packages/core/src/runner/session.ts`, remove `providerConfig` from `SessionOptions` and `buildRunOptions`. Remove the `ProviderConfig` import.

- [ ] **Step 5: Update adapter factory tests**

Replace `packages/core/src/__tests__/session-adapter-factory.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ClaudeAgentRunner } from "@/runner/adapters/claude-session";
import { CodexAgentRunner } from "@/runner/adapters/codex-session";
import { createAgentRunner } from "@/runner/adapters/index";

describe("createAgentRunner", () => {
  it("returns ClaudeAgentRunner for claude adapter", () => {
    const runner = createAgentRunner("claude");
    expect(runner).toBeInstanceOf(ClaudeAgentRunner);
  });

  it("returns CodexAgentRunner for codex adapter", () => {
    const runner = createAgentRunner("codex");
    expect(runner).toBeInstanceOf(CodexAgentRunner);
  });

  it("throws for unknown adapter", () => {
    expect(() => createAgentRunner("gemini")).toThrow('Unknown adapter "gemini"');
  });
});
```

- [ ] **Step 6: Fix all remaining ProviderConfig references**

Search for `ProviderConfig` and `providerConfig` across all source and test files. Fix or remove every reference. Key files:
- `packages/core/src/supervisor/daemon.ts` — change `createAgentRunner(providerConfig)` to `createAgentRunner(getAdapter(model))`
- `packages/core/src/supervisor/heartbeat.ts` — remove providerConfig references
- `packages/core/src/__tests__/codex-session-adapter.test.ts`
- `packages/core/src/__tests__/heartbeat-adapter.test.ts`

- [ ] **Step 7: Run typecheck and tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test -- --run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/ packages/core/src/__tests__/
git commit -m "refactor(core): simplify adapter factory — takes string instead of ProviderConfig

createAgentRunner('claude') instead of createAgentRunner(providerConfig).
Removed providerConfig from AgentRunOptions and SessionOptions.
Deleted ProviderConfig references."
```

---

### Task 4: Wire Model Resolution in Orchestrator and Supervisor

**Files:**
- Modify: `packages/core/src/supervisor/daemon.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Delete: `packages/core/src/agents/validation.ts`

- [ ] **Step 1: Update daemon.ts to use getAdapter**

In `packages/core/src/supervisor/daemon.ts`, replace the adapter creation logic. Import `getAdapter` from `@/models`:

```typescript
import { getAdapter } from "@/models";
```

Where it creates the agent runner (currently using `config.provider`), change to:

```typescript
const supervisorModel = this.config.supervisor.model;
const adapter = getAdapter(supervisorModel);
const runner = createAgentRunner(adapter);
```

- [ ] **Step 2: Update orchestrator.ts**

In the orchestrator, where it dispatches agents, resolve the model and create the appropriate runner:

```typescript
import { getAdapter, resolveModel } from "@/models";
import { createAgentRunner } from "@/runner/adapters/index";

// When dispatching an agent:
const model = resolveModel(agent.definition.model ?? this.config.models.default);
const adapter = getAdapter(model);
const runner = createAgentRunner(adapter);
```

Pass `model` through to the session so the runner receives the resolved model string.

- [ ] **Step 3: Delete validation.ts**

Delete `packages/core/src/agents/validation.ts` — `getAdapter()` now throws on unknown models, making the separate validation function redundant.

- [ ] **Step 4: Update index.ts exports**

In `packages/core/src/index.ts`:
- Remove: `export { validateAgentModels } from "@/agents/validation"`
- Remove: `ProviderConfig` from type exports
- Remove: `providerConfigSchema` from schema exports
- Add: `export { getAdapter, listModels, MODEL_ALIASES, resolveModel, SUPPORTED_MODELS } from "@/models"`
- Add: `export { modelsConfigSchema } from "@/config"`
- Add: `export type { ModelsConfig } from "@/config"`

- [ ] **Step 5: Run full typecheck and tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test -- --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/
git commit -m "refactor(core): wire model catalog into orchestrator and supervisor

getAdapter() auto-resolves model → adapter for both agents and supervisor.
Deleted validateAgentModels (replaced by getAdapter).
Exported SUPPORTED_MODELS, getAdapter, resolveModel, listModels."
```

---

### Task 5: Update Config File and Full Validation

**Files:**
- Modify: `~/.neo/config.yml` (user config)
- Modify: `packages/agents/agents/architect.yml`
- Modify: `packages/agents/agents/scout.yml`

- [ ] **Step 1: Update user config**

Replace `~/.neo/config.yml` `provider` block with:

```yaml
models:
  default: claude-sonnet-4-6
```

Remove the entire `provider:` block.

- [ ] **Step 2: Update agent YAML models to use aliases or valid IDs**

In `packages/agents/agents/architect.yml`, change `model: claude-opus-4-6` to `model: opus` (uses alias).
In `packages/agents/agents/scout.yml`, change `model: claude-opus-4-6` to `model: opus`.

- [ ] **Step 3: Run full build and tests**

```bash
cd /Users/karl/Documents/neo && pnpm build && pnpm typecheck && pnpm test
```

Expected: all pass.

- [ ] **Step 4: Run a real agent test**

```bash
node packages/cli/dist/index.js agents list
node packages/cli/dist/index.js run --agent reviewer --repo /Users/karl/Documents/neo --prompt "What is this project? One sentence."
```

- [ ] **Step 5: Commit**

```bash
git add packages/agents/ 
git commit -m "chore: update config and agents to use model catalog

agents use aliases (opus). Config uses models.default."
```
