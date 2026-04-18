# Codex CLI Provider Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex CLI as an alternative AI provider in neo, activating the dormant adapter pattern for both supervisor and runner.

**Architecture:** Extend the existing `AIAdapter` interface with a `CodexAdapter` for the supervisor (backed by `@openai/codex-sdk`) and a `CodexSessionAdapter` for the runner (backed by `codex exec --json`). Refactor `HeartbeatLoop.callSdk()` and `runSession()` to consume adapters instead of calling the Claude SDK directly. Expose neo's supervisor tools to Codex via an MCP bridge.

**Tech Stack:** TypeScript, `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-16-codex-provider-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/supervisor/ai-adapter.ts` | Extended types: `SessionHandle` union, `SupervisorMessage.metadata`, `SessionAdapter` interface, `SessionRunOptions` |
| `packages/core/src/supervisor/adapters/claude.ts` | Existing `ClaudeAdapter` — updated to yield `metadata` on `end` messages |
| `packages/core/src/supervisor/adapters/codex.ts` | New `CodexAdapter implements AIAdapter` — wraps `@openai/codex-sdk` |
| `packages/core/src/supervisor/adapters/codex-mcp-bridge.ts` | New MCP bridge — exposes `ToolDefinition[]` as stdio MCP server for Codex |
| `packages/core/src/supervisor/adapters/index.ts` | New factory `createSupervisorAdapter(provider)` |
| `packages/core/src/runner/adapters/claude-session.ts` | New `ClaudeSessionAdapter` — extracted from current `session.ts` |
| `packages/core/src/runner/adapters/codex-session.ts` | New `CodexSessionAdapter` — spawns `codex exec --json` |
| `packages/core/src/runner/adapters/index.ts` | New factory `createSessionAdapter(provider)` |
| `packages/core/src/runner/session.ts` | Refactored to accept `SessionAdapter` param |
| `packages/core/src/supervisor/heartbeat.ts` | Refactored `callSdk()` → `callAdapter()`, accepts `AIAdapter` |
| `packages/core/src/config/schema.ts` | Add `provider` field to `supervisorConfigSchema` |
| `packages/core/package.json` | Add `@openai/codex-sdk` as optional peer dep |

---

### Task 1: Extend `ai-adapter.ts` Types

**Files:**
- Modify: `packages/core/src/supervisor/ai-adapter.ts`
- Test: `packages/core/src/__tests__/ai-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/ai-adapter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { SessionHandle, SupervisorMessage, SessionAdapter, SessionRunOptions } from "@/supervisor/ai-adapter";

describe("ai-adapter types", () => {
  it("SessionHandle accepts claude provider", () => {
    const handle: SessionHandle = { provider: "claude", sessionId: "abc" };
    expect(handle.provider).toBe("claude");
  });

  it("SessionHandle accepts codex provider", () => {
    const handle: SessionHandle = { provider: "codex", threadId: "thread_123" };
    expect(handle.provider).toBe("codex");
  });

  it("SupervisorMessage supports metadata on end kind", () => {
    const msg: SupervisorMessage = {
      kind: "end",
      metadata: { costUsd: 0.05, turnCount: 3 },
    };
    expect(msg.metadata?.costUsd).toBe(0.05);
    expect(msg.metadata?.turnCount).toBe(3);
  });

  it("SupervisorMessage metadata is optional", () => {
    const msg: SupervisorMessage = { kind: "end" };
    expect(msg.metadata).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/ai-adapter.test.ts`

Expected: FAIL — `SessionHandle` does not accept `codex` provider, `metadata` property does not exist.

- [ ] **Step 3: Update `ai-adapter.ts` with extended types**

Replace the contents of `packages/core/src/supervisor/ai-adapter.ts`:

```typescript
import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import type { SDKStreamMessage } from "@/sdk-types";
import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Provider type ──────────────────────────────────────

export type AIProvider = "claude" | "codex";

// ─── Session handles ──────────────────────────────────────

export type SessionHandle =
  | { provider: "claude"; sessionId: string }
  | { provider: "codex"; threadId: string };

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

// ─── Session Adapter (Runner) ────────────────────────────

export interface SessionRunOptions {
  prompt: string;
  cwd: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  maxTurns?: number;
  resumeSessionId?: string;
  model?: string;
  adapterOptions?: Record<string, unknown>;
}

export interface SessionAdapter {
  runSession(options: SessionRunOptions): AsyncIterable<SDKStreamMessage>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/ai-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Run full typecheck**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck`

Expected: PASS (existing code still imports the same named exports)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/ai-adapter.ts packages/core/src/__tests__/ai-adapter.test.ts
git commit -m "feat(core): extend AIAdapter types for multi-provider support

Add codex variant to SessionHandle union, metadata field to
SupervisorMessage, and new SessionAdapter/SessionRunOptions
interfaces for the runner layer."
```

---

### Task 2: Add `provider` to Supervisor Config Schema

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Test: `packages/core/src/__tests__/config-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/config-provider.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { supervisorConfigSchema } from "@/config/schema";

describe("supervisor config provider field", () => {
  it("defaults to claude", () => {
    const result = supervisorConfigSchema.parse({});
    expect(result.provider).toBe("claude");
  });

  it("accepts codex provider", () => {
    const result = supervisorConfigSchema.parse({ provider: "codex" });
    expect(result.provider).toBe("codex");
  });

  it("rejects unknown provider", () => {
    expect(() => supervisorConfigSchema.parse({ provider: "gemini" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/config-provider.test.ts`

Expected: FAIL — `provider` not in schema.

- [ ] **Step 3: Add `provider` field to `supervisorConfigSchema`**

In `packages/core/src/config/schema.ts`, add the provider field to the schema object (after the `autoDecide` field, before `model`):

```typescript
    /** AI provider for supervisor heartbeats */
    provider: z.enum(["claude", "codex"]).default("claude"),
```

Also add `provider: "claude"` to the `.default({...})` object at the bottom of the schema.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/config-provider.test.ts`

Expected: PASS

- [ ] **Step 5: Run full typecheck and existing tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/__tests__/config-provider.test.ts
git commit -m "feat(core): add provider field to supervisor config schema

Supports 'claude' (default) and 'codex' as AI provider options."
```

---

### Task 3: Create Supervisor Adapter Factory + Update ClaudeAdapter

**Files:**
- Modify: `packages/core/src/supervisor/adapters/claude.ts`
- Create: `packages/core/src/supervisor/adapters/index.ts`
- Test: `packages/core/src/__tests__/supervisor-adapter-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/supervisor-adapter-factory.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createSupervisorAdapter } from "@/supervisor/adapters/index";
import { ClaudeAdapter } from "@/supervisor/adapters/claude";

describe("createSupervisorAdapter", () => {
  it("returns ClaudeAdapter for claude provider", () => {
    const adapter = createSupervisorAdapter("claude");
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it("returns a CodexAdapter for codex provider", () => {
    // CodexAdapter defers SDK import to first query() call,
    // so construction succeeds even without @openai/codex-sdk installed.
    const adapter = createSupervisorAdapter("codex");
    expect(adapter).toBeDefined();
    expect(adapter.getSessionHandle()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/supervisor-adapter-factory.test.ts`

Expected: FAIL — `createSupervisorAdapter` does not exist.

- [ ] **Step 3: Update ClaudeAdapter to yield metadata on end**

In `packages/core/src/supervisor/adapters/claude.ts`, update the `isResultMessage` block to include metadata:

```typescript
      if (isResultMessage(message)) {
        yield {
          kind: "end",
          metadata: {
            costUsd: message.total_cost_usd ?? 0,
            turnCount: message.num_turns ?? 0,
          },
        };
      }
```

The full updated file:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { isAssistantMessage, isInitMessage, isResultMessage, isToolUseMessage } from "@/sdk-types";
import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "../ai-adapter.js";

export class ClaudeAdapter implements AIAdapter {
  private sessionHandle: SessionHandle | undefined;

  getSessionHandle(): SessionHandle | undefined {
    return this.sessionHandle;
  }

  restoreSession(handle: SessionHandle): void {
    if (handle.provider !== "claude") {
      throw new Error("ClaudeAdapter only accepts claude session handles");
    }
    this.sessionHandle = handle;
  }

  async *query(options: AIQueryOptions): AsyncIterable<SupervisorMessage> {
    const sdkTools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown>,
    }));

    const queryOptions = {
      prompt: options.prompt,
      options: {
        tools: sdkTools,
        ...(options.model ? { model: options.model } : {}),
        ...(this.sessionHandle ? { resume: this.sessionHandle.sessionId } : {}),
      },
    };

    for await (const message of query(queryOptions as never)) {
      if (isInitMessage(message)) {
        this.sessionHandle = { provider: "claude", sessionId: message.session_id };
        continue;
      }

      if (isToolUseMessage(message)) {
        yield {
          kind: "tool_use",
          toolName: message.tool,
          toolInput: message.input,
        };
        continue;
      }

      if (isAssistantMessage(message)) {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && block.text !== undefined) {
            yield { kind: "text", text: block.text };
          }
        }
        continue;
      }

      if (isResultMessage(message)) {
        yield {
          kind: "end",
          metadata: {
            costUsd: message.total_cost_usd ?? 0,
            turnCount: message.num_turns ?? 0,
          },
        };
      }
    }
  }
}
```

- [ ] **Step 4: Create the factory**

Create `packages/core/src/supervisor/adapters/index.ts`:

```typescript
import type { AIAdapter, AIProvider } from "../ai-adapter.js";
import { ClaudeAdapter } from "./claude.js";

export function createSupervisorAdapter(provider: AIProvider): AIAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeAdapter();
    case "codex": {
      // Import CodexAdapter — it defers the actual @openai/codex-sdk import
      // to the first query() call, so this is safe even if the SDK is not installed.
      // The error surfaces at runtime when query() is first called.
      const { CodexAdapter } = require("./codex.js") as { CodexAdapter: new () => AIAdapter };
      return new CodexAdapter();
    }
  }
}

export { ClaudeAdapter } from "./claude.js";
```

**Note:** The project is ESM-only (`"type": "module"`) but tsup bundles to CJS-compatible output, and Vitest supports `require()` in tests. If `require()` causes issues at runtime, replace with a synchronous import pattern or make the factory async. The CodexAdapter itself defers the heavy `@openai/codex-sdk` import to the first `query()` call via `await import()`, so the factory instantiation is lightweight.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/supervisor-adapter-factory.test.ts`

Expected: PASS — claude returns ClaudeAdapter, codex throws because SDK not installed.

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/adapters/claude.ts packages/core/src/supervisor/adapters/index.ts packages/core/src/__tests__/supervisor-adapter-factory.test.ts
git commit -m "feat(core): add supervisor adapter factory and update ClaudeAdapter

ClaudeAdapter now yields metadata (costUsd, turnCount) on end messages.
Factory function createSupervisorAdapter() selects adapter by provider."
```

---

### Task 4: Refactor HeartbeatLoop to Use AIAdapter

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Modify: `packages/core/src/supervisor/daemon.ts`
- Test: `packages/core/src/__tests__/heartbeat-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/heartbeat-adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "@/supervisor/ai-adapter";

// Minimal mock adapter to test that HeartbeatLoop calls adapter.query()
class MockAdapter implements AIAdapter {
  public lastPrompt = "";
  public callCount = 0;

  private handle: SessionHandle | undefined;

  getSessionHandle(): SessionHandle | undefined {
    return this.handle;
  }

  restoreSession(handle: SessionHandle): void {
    this.handle = handle;
  }

  async *query(options: AIQueryOptions): AsyncIterable<SupervisorMessage> {
    this.lastPrompt = options.prompt;
    this.callCount++;
    yield { kind: "text", text: "mock response" };
    yield { kind: "end", metadata: { costUsd: 0.01, turnCount: 1 } };
  }
}

describe("HeartbeatLoop adapter integration", () => {
  it("MockAdapter yields structured messages", async () => {
    const adapter = new MockAdapter();
    const messages: SupervisorMessage[] = [];

    for await (const msg of adapter.query({
      prompt: "test",
      tools: [],
    })) {
      messages.push(msg);
    }

    expect(adapter.callCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ kind: "text", text: "mock response" });
    expect(messages[1]).toEqual({
      kind: "end",
      metadata: { costUsd: 0.01, turnCount: 1 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/heartbeat-adapter.test.ts`

Expected: PASS — validates the mock adapter contract works before we wire it into HeartbeatLoop.

- [ ] **Step 3: Add `adapter` to `HeartbeatLoopOptions` and constructor**

In `packages/core/src/supervisor/heartbeat.ts`:

1. Add import at the top:
```typescript
import type { AIAdapter, SupervisorMessage } from "@/supervisor/ai-adapter";
```

2. Add to `HeartbeatLoopOptions` interface (after `directivesPath`):
```typescript
  /** AI adapter for supervisor queries (injected by daemon) */
  adapter: AIAdapter;
```

3. Add private field in `HeartbeatLoop` class (after `directivesPath`):
```typescript
  private readonly adapter: AIAdapter;
```

4. Add to constructor body (after `this.directivesPath = options.directivesPath;`):
```typescript
    this.adapter = options.adapter;
```

- [ ] **Step 4: Replace `callSdk` with `callAdapter`**

Replace the entire `callSdk` method (lines 1030-1120) with:

```typescript
  private async callAdapter(
    prompt: string,
    heartbeatId: string,
  ): Promise<{ output: string; costUsd: number; turnCount: number }> {
    const abortController = new AbortController();
    this.activeAbort = abortController;
    const timeout = setTimeout(() => {
      abortController.abort(new Error("Heartbeat timeout exceeded"));
    }, this.config.supervisor.heartbeatTimeoutMs);

    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    try {
      const stream = this.adapter.query({
        prompt,
        tools: [],
        model: this.config.supervisor.model,
      });

      // Create abort promise that resolves when signal fires
      const abortPromise = new Promise<{ aborted: true }>((resolve) => {
        if (abortController.signal.aborted) {
          resolve({ aborted: true });
          return;
        }
        abortController.signal.addEventListener("abort", () => resolve({ aborted: true }), {
          once: true,
        });
      });

      // Use Promise.race pattern for abortable stream iteration
      const iterator = stream[Symbol.asyncIterator]();
      try {
        while (true) {
          const raceResult = await Promise.race([iterator.next(), abortPromise]);

          // Check if abort triggered
          if ("aborted" in raceResult) {
            await this.activityLog.log("heartbeat", "Heartbeat aborted", { heartbeatId });
            break;
          }

          // Normal iterator result
          const iterResult = raceResult as IteratorResult<SupervisorMessage>;
          if (iterResult.done) break;

          const msg = iterResult.value;

          if (msg.kind === "text" && msg.text) {
            output += msg.text;
            await this.activityLog.log("plan", msg.text, { heartbeatId });
          }

          if (msg.kind === "tool_use") {
            await this.activityLog.log("tool_use", `Tool: ${msg.toolName}`, {
              heartbeatId,
              input: msg.toolInput,
            });
          }

          if (msg.kind === "end") {
            costUsd = msg.metadata?.costUsd ?? 0;
            turnCount = msg.metadata?.turnCount ?? 0;
          }
        }
      } finally {
        await iterator.return?.();
      }
    } finally {
      clearTimeout(timeout);
      this.activeAbort = null;
    }

    return { output, costUsd, turnCount };
  }
```

- [ ] **Step 5: Update the call site**

In the `runHeartbeat` method, change the line that calls `callSdk` (around line 581):

From: `const { costUsd, turnCount } = await this.callSdk(prompt, heartbeatId);`
To: `const { costUsd, turnCount } = await this.callAdapter(prompt, heartbeatId);`

- [ ] **Step 6: Remove unused SDK imports from heartbeat.ts**

Remove these imports that are no longer used in `callSdk`:
```typescript
import { homedir } from "node:os";
// Remove from the sdk-types import: isAssistantMessage, isInitMessage, isResultMessage, isToolResultMessage, isToolUseMessage, type SDKStreamMessage
```

Keep only the SDK type imports that are still used by `logStreamMessage` and other methods. Check which are still referenced — if `logStreamMessage` is no longer called (since the adapter handles message translation), remove it and its helper methods too.

**Important:** The `logStreamMessage`, `logContentBlocks`, `logToolUse`, and `logToolResult` methods are no longer called because `callAdapter` handles logging directly from `SupervisorMessage`. Remove all four methods.

Also remove the `sessionId` field update from `isInitMessage` — the adapter handles that internally via `getSessionHandle()`.

- [ ] **Step 7: Update `daemon.ts` to inject adapter**

In `packages/core/src/supervisor/daemon.ts`, update the HeartbeatLoop construction:

1. Add import:
```typescript
import { createSupervisorAdapter } from "@/supervisor/adapters/index";
```

2. Update the `new HeartbeatLoop({...})` call (around line 157) to include the adapter:
```typescript
    const adapter = createSupervisorAdapter(this.config.supervisor.provider);
    this.heartbeatLoop = new HeartbeatLoop({
      config: this.config,
      supervisorDir: this.dir,
      statePath,
      sessionId: this.sessionId,
      eventQueue: this.eventQueue,
      activityLog: this.activityLog,
      eventsPath,
      defaultInstructionsPath: this.defaultInstructionsPath,
      supervisorName: this.name,
      directivesPath,
      adapter,
    });
```

- [ ] **Step 8: Update existing heartbeat tests**

In `packages/core/src/__tests__/heartbeat-skip.test.ts`, every `new HeartbeatLoop({...})` call needs an `adapter` field. Add the MockAdapter at the top of the test file and pass it:

```typescript
import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "@/supervisor/ai-adapter";

class MockAdapter implements AIAdapter {
  getSessionHandle(): SessionHandle | undefined { return undefined; }
  restoreSession(): void {}
  async *query(): AsyncIterable<SupervisorMessage> {
    yield { kind: "end", metadata: { costUsd: 0, turnCount: 0 } };
  }
}
```

Add `adapter: new MockAdapter()` to every `new HeartbeatLoop({...})` call in the test file.

- [ ] **Step 9: Run all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test`

Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts packages/core/src/supervisor/daemon.ts packages/core/src/__tests__/heartbeat-adapter.test.ts packages/core/src/__tests__/heartbeat-skip.test.ts
git commit -m "refactor(core): replace direct SDK calls in HeartbeatLoop with AIAdapter

HeartbeatLoop now receives an AIAdapter via constructor injection.
callSdk() replaced by callAdapter() which iterates SupervisorMessages.
Removes direct @anthropic-ai/claude-agent-sdk import from heartbeat.ts."
```

---

### Task 5: Extract ClaudeSessionAdapter from session.ts

**Files:**
- Create: `packages/core/src/runner/adapters/claude-session.ts`
- Modify: `packages/core/src/runner/session.ts`
- Test: `packages/core/src/__tests__/claude-session-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/claude-session-adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(function* () {
    yield { type: "system", subtype: "init", session_id: "test-session-123" };
    yield {
      type: "result",
      subtype: "success",
      session_id: "test-session-123",
      result: "done",
      total_cost_usd: 0.05,
      num_turns: 2,
    };
  }),
}));

import { ClaudeSessionAdapter } from "@/runner/adapters/claude-session";
import type { SDKStreamMessage } from "@/sdk-types";

describe("ClaudeSessionAdapter", () => {
  it("yields SDKStreamMessages from Claude SDK", async () => {
    const adapter = new ClaudeSessionAdapter();
    const messages: SDKStreamMessage[] = [];

    const stream = adapter.runSession({
      prompt: "test prompt",
      cwd: "/tmp/test",
      sandboxConfig: {
        allowedTools: ["Bash", "Read"],
        readablePaths: [],
        writablePaths: [],
        writable: false,
      },
    });

    for await (const msg of stream) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(messages[1]).toMatchObject({ type: "result", subtype: "success" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/claude-session-adapter.test.ts`

Expected: FAIL — `ClaudeSessionAdapter` does not exist.

- [ ] **Step 3: Create `ClaudeSessionAdapter`**

Create `packages/core/src/runner/adapters/claude-session.ts`:

```typescript
import type { SDKStreamMessage } from "@/sdk-types";
import type { SessionAdapter, SessionRunOptions } from "@/supervisor/ai-adapter";

export class ClaudeSessionAdapter implements SessionAdapter {
  async *runSession(options: SessionRunOptions): AsyncIterable<SDKStreamMessage> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const queryOptions: Record<string, unknown> = {
      cwd: options.cwd,
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      allowedTools: options.sandboxConfig.allowedTools,
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

    // Pass through Claude-specific options (agents, claudeCodePath, hooks)
    if (options.adapterOptions) {
      if (options.adapterOptions.agents) {
        queryOptions.agents = options.adapterOptions.agents;
      }
      if (options.adapterOptions.claudeCodePath) {
        queryOptions.pathToClaudeCodeExecutable = options.adapterOptions.claudeCodePath;
      }
      if (options.adapterOptions.hooks) {
        queryOptions.hooks = options.adapterOptions.hooks;
      }
    }

    if (options.model) {
      queryOptions.model = options.model;
    }

    const stream = sdk.query({ prompt: options.prompt, options: queryOptions as never });

    for await (const message of stream) {
      yield message as SDKStreamMessage;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/claude-session-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runner/adapters/claude-session.ts packages/core/src/__tests__/claude-session-adapter.test.ts
git commit -m "feat(core): extract ClaudeSessionAdapter from session.ts

Encapsulates Claude SDK query options and stream in a SessionAdapter
implementation. Pure extract — no behavior change."
```

---

### Task 6: Refactor `session.ts` to Accept SessionAdapter

**Files:**
- Modify: `packages/core/src/runner/session.ts`
- Modify: `packages/core/src/runner/recovery.ts`
- Test: existing runner tests

- [ ] **Step 1: Refactor `session.ts`**

Replace `packages/core/src/runner/session.ts` with:

```typescript
import { isInitMessage, isResultMessage, type SDKStreamMessage } from "@/sdk-types";
import type { SessionAdapter, SessionRunOptions } from "@/supervisor/ai-adapter";
import { ClaudeSessionAdapter } from "./adapters/claude-session.js";

// ─── Types ──────────────────────────────────────────────

export interface SessionOptions extends SessionRunOptions {
  initTimeoutMs: number;
  maxDurationMs: number;
  onEvent?: ((event: SessionEvent) => void) | undefined;
  adapter?: SessionAdapter | undefined;
}

export interface SessionResult {
  sessionId: string;
  output: string;
  costUsd: number;
  durationMs: number;
  turnCount: number;
}

export type SessionEvent =
  | { type: "session:start"; sessionId: string }
  | { type: "session:complete"; sessionId: string; result: SessionResult }
  | { type: "session:fail"; sessionId: string; error: string };

// ─── Helpers ────────────────────────────────────────────

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

function toSessionError(error: unknown, isTimeout: boolean, sessionId: string): SessionError {
  if (error instanceof SessionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SessionError(message, isTimeout ? "timeout" : "unknown", sessionId);
}

// ─── Session Runner ─────────────────────────────────────

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { initTimeoutMs, maxDurationMs, onEvent, adapter: adapterParam, ...runOptions } = options;
  const adapter = adapterParam ?? new ClaudeSessionAdapter();

  const startTime = Date.now();
  let sessionId = "";

  const abortController = new AbortController();
  const initTimer = setTimeout(() => {
    abortController.abort(new Error("Session init timeout exceeded"));
  }, initTimeoutMs);
  const maxDurationTimer = setTimeout(() => {
    abortController.abort(new Error("Session max duration exceeded"));
  }, maxDurationMs);

  try {
    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    const stream = adapter.runSession(runOptions);

    for await (const message of stream) {
      checkAborted(abortController.signal);

      const msg = message as SDKStreamMessage;

      if (isInitMessage(msg)) {
        sessionId = msg.session_id;
        clearTimeout(initTimer);
        onEvent?.({ type: "session:start", sessionId });
      }

      if (isResultMessage(msg)) {
        output = msg.result ?? "";
        costUsd = msg.total_cost_usd ?? 0;
        turnCount = msg.num_turns ?? 0;
        sessionId = msg.session_id ?? sessionId;

        if (msg.subtype !== "success") {
          throw new SessionError(
            `Session ended with error: ${msg.subtype}`,
            msg.subtype,
            sessionId,
          );
        }
      }
    }

    const sessionResult: SessionResult = {
      sessionId,
      output,
      costUsd,
      durationMs: Date.now() - startTime,
      turnCount,
    };

    onEvent?.({ type: "session:complete", sessionId, result: sessionResult });
    return sessionResult;
  } catch (error) {
    const errorSessionId = sessionId || "unknown";
    const sessionError = toSessionError(error, abortController.signal.aborted, errorSessionId);

    onEvent?.({ type: "session:fail", sessionId: errorSessionId, error: sessionError.message });
    throw sessionError;
  } finally {
    clearTimeout(initTimer);
    clearTimeout(maxDurationTimer);
  }
}

// ─── Error class ────────────────────────────────────────

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly errorType: string,
    public readonly sessionId: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
```

Key changes:
- `SessionOptions extends SessionRunOptions` — adds `initTimeoutMs`, `maxDurationMs`, `onEvent`, `adapter`
- Removed `SessionOptions.agent`, `repoPath`, `sessionPath`, `hooks`, `mcpServers`, `env`, `maxTurns`, `resumeSessionId`, `agents`, `claudeCodePath` — these are now in `SessionRunOptions` (as `cwd`, etc.)
- `adapter` defaults to `new ClaudeSessionAdapter()` for backward compat
- Removed `buildQueryOptions()` — moved into `ClaudeSessionAdapter`
- Removed direct SDK import

**Important:** The `SessionOptions` interface changes. Check all callers to update them.

- [ ] **Step 2: Update recovery.ts**

In `packages/core/src/runner/recovery.ts`, update the import and the `runSession` call. The spread `...rest` should now conform to the new `SessionOptions` shape. If `recovery.ts` passes `SessionOptions` fields that moved to `SessionRunOptions`, they will still be inherited.

Check the existing call at line 140:
```typescript
const result = await runSession({
  ...rest,
  prompt,
  resumeSessionId: strategy === "resume" ? lastSessionId : undefined,
});
```

This should still work because `SessionOptions extends SessionRunOptions`, and `rest` contains the fields from `SessionRunOptions`. Verify by reading the types.

- [ ] **Step 3: Update callers of `runSession`**

Search all callers of `runSession` and update them to pass `cwd` instead of `sessionPath`/`repoPath`, and move Claude-specific options into `adapterOptions`. The main caller is in the orchestrator — check the dispatch flow.

Read the orchestrator file to find where `runSession` is called and update the arguments.

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck`

Fix any type errors from the interface change.

- [ ] **Step 5: Run all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test`

Expected: PASS — existing tests should work because ClaudeSessionAdapter is the default.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runner/session.ts packages/core/src/runner/recovery.ts
git commit -m "refactor(core): make session.ts adapter-aware with SessionAdapter injection

runSession() now accepts an optional SessionAdapter parameter.
Defaults to ClaudeSessionAdapter for backward compatibility.
Removed direct Claude SDK import from session.ts."
```

---

### Task 7: Create Session Adapter Factory

**Files:**
- Create: `packages/core/src/runner/adapters/index.ts`
- Test: `packages/core/src/__tests__/session-adapter-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/session-adapter-factory.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createSessionAdapter } from "@/runner/adapters/index";
import { ClaudeSessionAdapter } from "@/runner/adapters/claude-session";

describe("createSessionAdapter", () => {
  it("returns ClaudeSessionAdapter for claude provider", () => {
    const adapter = createSessionAdapter("claude");
    expect(adapter).toBeInstanceOf(ClaudeSessionAdapter);
  });

  it("throws for codex when codex CLI is not available", () => {
    // CodexSessionAdapter checks for codex binary — may throw
    // For now, just verify it doesn't return ClaudeSessionAdapter
    expect(() => createSessionAdapter("codex")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/session-adapter-factory.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create the factory**

Create `packages/core/src/runner/adapters/index.ts`:

```typescript
import type { AIProvider, SessionAdapter } from "@/supervisor/ai-adapter";
import { ClaudeSessionAdapter } from "./claude-session.js";

export function createSessionAdapter(provider: AIProvider): SessionAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeSessionAdapter();
    case "codex": {
      // Dynamic import to avoid loading codex-session when not needed
      const { CodexSessionAdapter } = require("./codex-session.js") as {
        CodexSessionAdapter: new () => SessionAdapter;
      };
      return new CodexSessionAdapter();
    }
  }
}

export { ClaudeSessionAdapter } from "./claude-session.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/session-adapter-factory.test.ts`

Expected: FAIL for codex (CodexSessionAdapter not created yet) — update test to expect throw for codex:

```typescript
  it("throws for codex when module is not yet available", () => {
    expect(() => createSessionAdapter("codex")).toThrow();
  });
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runner/adapters/index.ts packages/core/src/__tests__/session-adapter-factory.test.ts
git commit -m "feat(core): add session adapter factory

createSessionAdapter() returns ClaudeSessionAdapter or
CodexSessionAdapter based on provider string."
```

---

### Task 8: Create CodexAdapter (Supervisor)

**Files:**
- Create: `packages/core/src/supervisor/adapters/codex.ts`
- Test: `packages/core/src/__tests__/codex-adapter.test.ts`

- [ ] **Step 1: Write the test with mocked SDK**

Create `packages/core/src/__tests__/codex-adapter.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the @openai/codex-sdk module
const mockRunStreamed = vi.fn();
const mockStartThread = vi.fn(() => ({ runStreamed: mockRunStreamed }));
const mockResumeThread = vi.fn(() => ({ runStreamed: mockRunStreamed }));

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(() => ({
    startThread: mockStartThread,
    resumeThread: mockResumeThread,
  })),
}));

import { CodexAdapter } from "@/supervisor/adapters/codex";
import type { SupervisorMessage } from "@/supervisor/ai-adapter";

describe("CodexAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("yields text messages from Codex stream", async () => {
    mockRunStreamed.mockReturnValue(
      (async function* () {
        yield {
          type: "item.completed",
          item: { type: "message", content: [{ type: "text", text: "hello" }] },
        };
        yield {
          type: "turn.completed",
          usage: { total_cost_usd: 0.02, turn_count: 1 },
        };
      })(),
    );

    const adapter = new CodexAdapter();
    const messages: SupervisorMessage[] = [];

    for await (const msg of adapter.query({ prompt: "test", tools: [] })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ kind: "text", text: "hello" });
    expect(messages[1]).toEqual({
      kind: "end",
      metadata: { costUsd: 0.02, turnCount: 1 },
    });
  });

  it("yields tool_use messages", async () => {
    mockRunStreamed.mockReturnValue(
      (async function* () {
        yield {
          type: "item.completed",
          item: {
            type: "function_call",
            name: "dispatch_agent",
            arguments: '{"agent":"coder","prompt":"fix bug"}',
          },
        };
        yield { type: "turn.completed", usage: { total_cost_usd: 0, turn_count: 1 } };
      })(),
    );

    const adapter = new CodexAdapter();
    const messages: SupervisorMessage[] = [];

    for await (const msg of adapter.query({ prompt: "test", tools: [] })) {
      messages.push(msg);
    }

    expect(messages[0]).toEqual({
      kind: "tool_use",
      toolName: "dispatch_agent",
      toolInput: { agent: "coder", prompt: "fix bug" },
    });
  });

  it("starts a new thread on first query", async () => {
    mockRunStreamed.mockReturnValue((async function* () {
      yield { type: "turn.completed", usage: { total_cost_usd: 0, turn_count: 0 } };
    })());

    const adapter = new CodexAdapter();
    for await (const _ of adapter.query({ prompt: "test", tools: [] })) { /* drain */ }

    expect(mockStartThread).toHaveBeenCalled();
    expect(mockResumeThread).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/codex-adapter.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement CodexAdapter**

Create `packages/core/src/supervisor/adapters/codex.ts`:

```typescript
import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "../ai-adapter.js";

export class CodexAdapter implements AIAdapter {
  private codex: unknown;
  private threadId: string | undefined;

  private async getCodex(): Promise<unknown> {
    if (!this.codex) {
      const { Codex } = await import("@openai/codex-sdk");
      this.codex = new Codex();
    }
    return this.codex;
  }

  getSessionHandle(): SessionHandle | undefined {
    if (!this.threadId) return undefined;
    return { provider: "codex", threadId: this.threadId };
  }

  restoreSession(handle: SessionHandle): void {
    if (handle.provider !== "codex") {
      throw new Error("CodexAdapter only accepts codex session handles");
    }
    this.threadId = handle.threadId;
  }

  async *query(options: AIQueryOptions): AsyncIterable<SupervisorMessage> {
    const codex = (await this.getCodex()) as {
      startThread: (opts: Record<string, unknown>) => { runStreamed: (prompt: string) => AsyncIterable<unknown> };
      resumeThread: (id: string) => { runStreamed: (prompt: string) => AsyncIterable<unknown> };
    };

    const thread = this.threadId
      ? codex.resumeThread(this.threadId)
      : codex.startThread({
          ...(options.model ? { model: options.model } : {}),
        });

    for await (const event of thread.runStreamed(options.prompt)) {
      const e = event as Record<string, unknown>;

      if (e.type === "item.completed") {
        const item = e.item as Record<string, unknown>;

        // Text message
        if (item.type === "message") {
          const content = item.content as Array<{ type: string; text?: string }>;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              yield { kind: "text", text: block.text };
            }
          }
        }

        // Tool/function call
        if (item.type === "function_call") {
          const name = item.name as string;
          let input: unknown;
          try {
            input = JSON.parse(item.arguments as string);
          } catch {
            input = item.arguments;
          }
          yield { kind: "tool_use", toolName: name, toolInput: input };
        }
      }

      if (e.type === "turn.completed") {
        const usage = e.usage as { total_cost_usd?: number; turn_count?: number } | undefined;
        yield {
          kind: "end",
          metadata: {
            costUsd: usage?.total_cost_usd ?? 0,
            turnCount: usage?.turn_count ?? 0,
          },
        };
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/codex-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Update factory to use actual import**

In `packages/core/src/supervisor/adapters/index.ts`, update the codex case to use dynamic import instead of `require`:

```typescript
    case "codex": {
      const { CodexAdapter } = await import("./codex.js");
      return new CodexAdapter();
    }
```

Wait — `createSupervisorAdapter` is synchronous. Since CodexAdapter uses dynamic import internally (in `getCodex()`), we can import the class synchronously:

```typescript
    case "codex": {
      const { CodexAdapter } = require("./codex.js") as typeof import("./codex.js");
      return new CodexAdapter();
    }
```

Or make factory async. Prefer keeping it sync since CodexAdapter defers the SDK import to first `query()` call.

- [ ] **Step 6: Run typecheck and all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/adapters/codex.ts packages/core/src/supervisor/adapters/index.ts packages/core/src/__tests__/codex-adapter.test.ts
git commit -m "feat(core): add CodexAdapter for supervisor via @openai/codex-sdk

Maps Codex SDK events (item.completed, turn.completed) to
SupervisorMessage format. Uses dynamic import for lazy SDK loading."
```

---

### Task 9: Create CodexSessionAdapter (Runner)

**Files:**
- Create: `packages/core/src/runner/adapters/codex-session.ts`
- Test: `packages/core/src/__tests__/codex-session-adapter.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/core/src/__tests__/codex-session-adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

// Mock execFile to simulate codex exec --json output
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const jsonlLines = [
      JSON.stringify({ type: "session.start", id: "codex-session-1" }),
      JSON.stringify({
        type: "message.completed",
        message: { content: [{ type: "text", text: "fixed the bug" }] },
      }),
      JSON.stringify({
        type: "session.completed",
        usage: { total_cost_usd: 0.03, turns: 2 },
      }),
    ].join("\n") + "\n";

    const stdout = Readable.from([jsonlLines]);
    const child = {
      stdout,
      stderr: Readable.from([]),
      on: vi.fn((_event: string, cb: (code: number) => void) => {
        // Simulate process exit after stdout ends
        if (_event === "close") {
          setTimeout(() => cb(0), 10);
        }
        return child;
      }),
      kill: vi.fn(),
    };
    return child;
  }),
}));

import { CodexSessionAdapter } from "@/runner/adapters/codex-session";
import type { SDKStreamMessage } from "@/sdk-types";

describe("CodexSessionAdapter", () => {
  it("maps codex exec JSONL output to SDKStreamMessages", async () => {
    const adapter = new CodexSessionAdapter();
    const messages: SDKStreamMessage[] = [];

    const stream = adapter.runSession({
      prompt: "fix the bug",
      cwd: "/tmp/test-repo",
      sandboxConfig: {
        allowedTools: ["Bash", "Read"],
        readablePaths: [],
        writablePaths: [],
        writable: false,
      },
    });

    for await (const msg of stream) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(messages[1]).toMatchObject({ type: "assistant" });
    expect(messages[2]).toMatchObject({ type: "result" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/codex-session-adapter.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement CodexSessionAdapter**

Create `packages/core/src/runner/adapters/codex-session.ts`:

```typescript
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { SDKStreamMessage } from "@/sdk-types";
import type { SessionAdapter, SessionRunOptions } from "@/supervisor/ai-adapter";

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

export class CodexSessionAdapter implements SessionAdapter {
  async *runSession(options: SessionRunOptions): AsyncIterable<SDKStreamMessage> {
    const args = ["exec", "--json", "--full-auto"];

    // Sandbox mapping
    if (!options.sandboxConfig.writable) {
      args.push("--sandbox", "read-only");
    } else {
      args.push("--sandbox", "workspace-write");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Prompt is the last argument
    args.push(options.prompt);

    const child = execFile("codex", args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
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
        // Skip non-JSON lines (e.g. stderr leaking into stdout)
      }
    }

    // Wait for process to exit
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/codex-session-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Update session adapter factory**

In `packages/core/src/runner/adapters/index.ts`, the `codex` case should now work since `CodexSessionAdapter` exists. Update:

```typescript
    case "codex": {
      const { CodexSessionAdapter } = require("./codex-session.js") as typeof import("./codex-session.js");
      return new CodexSessionAdapter();
    }
```

- [ ] **Step 6: Run all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runner/adapters/codex-session.ts packages/core/src/runner/adapters/index.ts packages/core/src/__tests__/codex-session-adapter.test.ts
git commit -m "feat(core): add CodexSessionAdapter via codex exec --json

Spawns codex exec as child process, parses JSONL stdout, and maps
events to SDKStreamMessage format for session.ts consumption."
```

---

### Task 10: Create MCP Bridge for Supervisor Tools

**Files:**
- Create: `packages/core/src/supervisor/adapters/codex-mcp-bridge.ts`
- Test: `packages/core/src/__tests__/codex-mcp-bridge.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/core/src/__tests__/codex-mcp-bridge.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CodexMcpBridge } from "@/supervisor/adapters/codex-mcp-bridge";
import type { ToolDefinition } from "@/supervisor/supervisor-tools";

describe("CodexMcpBridge", () => {
  const tools: ToolDefinition[] = [
    {
      name: "dispatch_agent",
      description: "Dispatch an agent to work on a task",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["agent", "prompt"],
      },
    },
  ];

  it("generates MCP server config with correct structure", () => {
    const bridge = new CodexMcpBridge(tools);
    const config = bridge.toMcpServerConfig();

    expect(config).toHaveProperty("command");
    expect(config).toHaveProperty("args");
    expect(typeof config.command).toBe("string");
    expect(Array.isArray(config.args)).toBe(true);
  });

  it("serializes tool definitions for MCP", () => {
    const bridge = new CodexMcpBridge(tools);
    const serialized = bridge.getToolDefinitions();

    expect(serialized).toHaveLength(1);
    expect(serialized[0].name).toBe("dispatch_agent");
    expect(serialized[0].inputSchema).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/codex-mcp-bridge.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement CodexMcpBridge**

Create `packages/core/src/supervisor/adapters/codex-mcp-bridge.ts`:

```typescript
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../supervisor-tools.js";

interface McpServerConfig {
  command: string;
  args: string[];
}

/**
 * Bridges neo supervisor tools to an MCP server that Codex can consume.
 *
 * Generates a temporary Node.js script that implements the MCP stdio protocol
 * (JSON-RPC 2.0 over stdin/stdout) and exposes the tool definitions as MCP tools.
 *
 * The bridge script is stateless — tool execution results must be provided
 * by the caller via the onToolCall callback when integrating with the adapter.
 */
export class CodexMcpBridge {
  private scriptPath: string | undefined;

  constructor(private readonly tools: ToolDefinition[]) {}

  getToolDefinitions(): ToolDefinition[] {
    return this.tools;
  }

  toMcpServerConfig(): McpServerConfig {
    if (!this.scriptPath) {
      this.scriptPath = this.generateBridgeScript();
    }
    return {
      command: "node",
      args: [this.scriptPath],
    };
  }

  private generateBridgeScript(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "neo-mcp-bridge-"));
    const scriptPath = path.join(dir, "bridge.mjs");

    const toolsJson = JSON.stringify(
      this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    );

    const script = `
import { createInterface } from "node:readline";

const tools = ${toolsJson};

const rl = createInterface({ input: process.stdin });

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\\n");
}

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "neo-supervisor-tools", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      respondError(id, -32601, "Tool not found: " + toolName);
      return;
    }
    // Tool execution is handled externally — return a placeholder
    // The CodexAdapter intercepts tool calls before they reach MCP
    respond(id, {
      content: [{ type: "text", text: "Tool call received: " + toolName }],
    });
    return;
  }

  if (method === "notifications/initialized") {
    // No response needed for notifications
    return;
  }

  respondError(id, -32601, "Method not found: " + method);
});
`;

    writeFileSync(scriptPath, script, "utf-8");
    return scriptPath;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test -- --run src/__tests__/codex-mcp-bridge.test.ts`

Expected: PASS

- [ ] **Step 5: Wire bridge into CodexAdapter**

Update `packages/core/src/supervisor/adapters/codex.ts` to accept tools and create the MCP bridge when tools are provided:

Add to the `query` method, before creating the thread:

```typescript
    // If tools are provided, create MCP bridge for Codex to consume
    let mcpServers: Record<string, unknown> | undefined;
    if (options.tools.length > 0) {
      const { CodexMcpBridge } = await import("./codex-mcp-bridge.js");
      const bridge = new CodexMcpBridge(options.tools);
      mcpServers = { "neo-supervisor": bridge.toMcpServerConfig() };
    }
```

Then pass `mcpServers` to `startThread`:

```typescript
    const thread = this.threadId
      ? codex.resumeThread(this.threadId)
      : codex.startThread({
          ...(options.model ? { model: options.model } : {}),
          ...(mcpServers ? { mcpServers } : {}),
        });
```

- [ ] **Step 6: Run all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core test`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/adapters/codex-mcp-bridge.ts packages/core/src/supervisor/adapters/codex.ts packages/core/src/__tests__/codex-mcp-bridge.test.ts
git commit -m "feat(core): add MCP bridge for supervisor tools in CodexAdapter

Generates a lightweight stdio MCP server script that exposes neo's
supervisor ToolDefinitions to Codex via its native MCP support."
```

---

### Task 11: Add Optional Peer Dependency + Export Updates

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add optional peer dependency**

In `packages/core/package.json`, add:

```json
  "peerDependencies": {
    "@openai/codex-sdk": ">=0.1.0"
  },
  "peerDependenciesMeta": {
    "@openai/codex-sdk": {
      "optional": true
    }
  }
```

- [ ] **Step 2: Update exports in index.ts**

In `packages/core/src/index.ts`, add the new exports:

```typescript
export type { AIAdapter, AIProvider, SessionAdapter, SessionRunOptions, SessionHandle, SupervisorMessage } from "@/supervisor/ai-adapter";
export { createSupervisorAdapter } from "@/supervisor/adapters/index";
export { createSessionAdapter } from "@/runner/adapters/index";
```

- [ ] **Step 3: Run typecheck and build**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core typecheck && pnpm --filter @neotx/core build`

Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/src/index.ts
git commit -m "feat(core): add @openai/codex-sdk as optional peer dep and export adapters

New public API: createSupervisorAdapter(), createSessionAdapter(),
AIProvider, SessionAdapter, SessionRunOptions types."
```

---

### Task 12: Full Validation Pass

- [ ] **Step 1: Run full build**

Run: `cd /Users/karl/Documents/neo && pnpm build`

Expected: PASS

- [ ] **Step 2: Run full typecheck**

Run: `cd /Users/karl/Documents/neo && pnpm typecheck`

Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/karl/Documents/neo && pnpm test`

Expected: PASS

- [ ] **Step 4: Run linter**

Run: `cd /Users/karl/Documents/neo && pnpm --filter @neotx/core lint`

Expected: PASS (or fix any Biome issues)

- [ ] **Step 5: Verify backward compatibility**

Check that the default behavior (no `provider` config) still uses Claude:
1. Config without `provider` should default to `"claude"`
2. `runSession()` without `adapter` param should use `ClaudeSessionAdapter`
3. All existing tests pass unchanged

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore(core): fix lint and build issues from codex provider integration"
```
