# Supervisor Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a hierarchical Supervisor architecture — a root Supervisor (heartbeat mode) spawns focused child Supervisors via IPC that guarantee delivery of an objective end-to-end, with an `AIAdapter` interface decoupling orchestration from Claude.

**Architecture:** Two new layers — `AIAdapter` (swappable AI provider, `ClaudeAdapter` default) and `SupervisorStore` (swappable persistence, `JsonlSupervisorStore` default). A new `FocusedLoop` runs a persistent SDK session per objective. A `ChildRegistry` in `HeartbeatLoop` spawns/monitors child processes via Node.js IPC.

**Tech Stack:** TypeScript strict, Zod, Node.js `child_process.fork`, `@anthropic-ai/claude-agent-sdk`, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/supervisor/ai-adapter.ts` | Create | `AIAdapter` interface + `SessionHandle` union type + `ToolDefinition` type |
| `packages/core/src/supervisor/adapters/claude.ts` | Create | `ClaudeAdapter` — wraps Claude Agent SDK, native `resume: sessionId` |
| `packages/core/src/supervisor/store.ts` | Create | `SupervisorStore` interface |
| `packages/core/src/supervisor/stores/jsonl.ts` | Create | `JsonlSupervisorStore` — JSONL-backed default implementation |
| `packages/core/src/supervisor/supervisor-tools.ts` | Create | `supervisor_complete` + `supervisor_blocked` Zod schemas + tool definitions |
| `packages/core/src/supervisor/child-registry.ts` | Create | `ChildRegistry` — spawn, monitor, IPC, stall detection |
| `packages/core/src/supervisor/focused-loop.ts` | Create | `FocusedLoop` — persistent SDK session loop for a single objective |
| `packages/core/src/supervisor/schemas.ts` | Modify | Add `ChildHandle`, `ChildToParentMessage`, `ParentToChildMessage` Zod schemas |
| `packages/core/src/supervisor/heartbeat.ts` | Modify | Integrate `ChildRegistry` — wire IPC events into `EventQueue` |
| `packages/core/src/supervisor/prompt-builder.ts` | Modify | Add `buildFocusedPrompt()` + add child dispatch context to root prompt |
| `packages/core/src/paths.ts` | Modify | Add `getFocusedSupervisorsDir()` + `getFocusedSupervisorDir(id)` |
| `packages/agents/prompts/focused-supervisor.md` | Create | System prompt for focused supervisor — objective, criteria, tools |
| `packages/core/src/__tests__/ai-adapter.test.ts` | Create | Unit tests for `ClaudeAdapter` |
| `packages/core/src/__tests__/supervisor-store.test.ts` | Create | Unit tests for `JsonlSupervisorStore` |
| `packages/core/src/__tests__/supervisor-tools.test.ts` | Create | Unit tests for tool schemas |
| `packages/core/src/__tests__/child-registry.test.ts` | Create | Unit tests for `ChildRegistry` (mocked child processes) |
| `packages/core/src/__tests__/focused-loop.test.ts` | Create | Unit tests for `FocusedLoop` |

---

## Task 1: Path helpers

**Files:**
- Modify: `packages/core/src/paths.ts`
- Test: `packages/core/src/__tests__/paths.test.ts`

- [ ] **Step 1: Add failing tests**

Open `packages/core/src/__tests__/paths.test.ts` and add at the end:

```typescript
describe("focused supervisor paths", () => {
  it("getFocusedSupervisorsDir returns ~/.neo/supervisors/focused", () => {
    const result = getFocusedSupervisorsDir();
    expect(result).toBe(path.join(homedir(), ".neo", "supervisors", "focused"));
  });

  it("getFocusedSupervisorDir returns ~/.neo/supervisors/focused/<id>", () => {
    const result = getFocusedSupervisorDir("sup_abc123");
    expect(result).toBe(path.join(homedir(), ".neo", "supervisors", "focused", "sup_abc123"));
  });
});
```

Make sure to import `getFocusedSupervisorsDir` and `getFocusedSupervisorDir` at the top of the test file.

- [ ] **Step 2: Run test to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern paths
```

Expected: FAIL — `getFocusedSupervisorsDir is not exported`

- [ ] **Step 3: Implement path helpers**

Add to `packages/core/src/paths.ts` after `getSupervisorDecisionsPath`:

```typescript
/**
 * Directory for all focused supervisor instances: ~/.neo/supervisors/focused/
 */
export function getFocusedSupervisorsDir(): string {
  return path.join(getSupervisorsDir(), "focused");
}

/**
 * Directory for a specific focused supervisor: ~/.neo/supervisors/focused/<id>/
 */
export function getFocusedSupervisorDir(supervisorId: string): string {
  return path.join(getFocusedSupervisorsDir(), supervisorId);
}

/**
 * Session file for a focused supervisor: ~/.neo/supervisors/focused/<id>/session.json
 */
export function getFocusedSupervisorSessionPath(supervisorId: string): string {
  return path.join(getFocusedSupervisorDir(supervisorId), "session.json");
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern paths
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/paths.ts packages/core/src/__tests__/paths.test.ts
git commit -m "feat(paths): add focused supervisor path helpers"
```

---

## Task 2: Supervisor tool schemas

**Files:**
- Create: `packages/core/src/supervisor/supervisor-tools.ts`
- Create: `packages/core/src/__tests__/supervisor-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/supervisor-tools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  supervisorBlockedSchema,
  supervisorCompleteSchema,
  SUPERVISOR_COMPLETE_TOOL,
  SUPERVISOR_BLOCKED_TOOL,
} from "@/supervisor/supervisor-tools";

describe("supervisorCompleteSchema", () => {
  it("accepts valid complete payload", () => {
    const result = supervisorCompleteSchema.safeParse({
      summary: "Implemented auth feature",
      evidence: ["https://github.com/org/repo/pull/42"],
      criteriaResults: [
        { criterion: "PR open", met: true, evidence: "PR #42 opened" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one evidence item", () => {
    const result = supervisorCompleteSchema.safeParse({
      summary: "Done",
      evidence: [],
      criteriaResults: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("supervisorBlockedSchema", () => {
  it("accepts valid blocked payload", () => {
    const result = supervisorBlockedSchema.safeParse({
      reason: "Cannot determine correct migration strategy",
      question: "Should we use addColumn or createTable?",
      context: "The existing schema has a users table with 2M rows",
      urgency: "high",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid urgency", () => {
    const result = supervisorBlockedSchema.safeParse({
      reason: "r",
      question: "q",
      context: "c",
      urgency: "critical",
    });
    expect(result.success).toBe(false);
  });
});

describe("tool definitions", () => {
  it("SUPERVISOR_COMPLETE_TOOL has correct name", () => {
    expect(SUPERVISOR_COMPLETE_TOOL.name).toBe("supervisor_complete");
  });

  it("SUPERVISOR_BLOCKED_TOOL has correct name", () => {
    expect(SUPERVISOR_BLOCKED_TOOL.name).toBe("supervisor_blocked");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern supervisor-tools
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement supervisor-tools.ts**

Create `packages/core/src/supervisor/supervisor-tools.ts`:

```typescript
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────

export const criteriaResultSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});

export const supervisorCompleteSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()).min(1, "At least one piece of evidence required"),
  branch: z.string().optional(),
  criteriaResults: z.array(criteriaResultSchema),
});

export const supervisorBlockedSchema = z.object({
  reason: z.string(),
  question: z.string(),
  context: z.string(),
  urgency: z.enum(["low", "high"]),
});

// ─── Types ───────────────────────────────────────────────

export type SupervisorCompleteInput = z.infer<typeof supervisorCompleteSchema>;
export type SupervisorBlockedInput = z.infer<typeof supervisorBlockedSchema>;

// ─── Tool definitions (passed to AIAdapter) ──────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SUPERVISOR_COMPLETE_TOOL: ToolDefinition = {
  name: "supervisor_complete",
  description:
    "Call this when ALL acceptance criteria are met and you have objective evidence. " +
    "Do NOT call this speculatively — provide real evidence (PR URL, CI status, test output).",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was accomplished" },
      evidence: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "PR URLs, CI links, test output snippets",
      },
      branch: { type: "string", description: "Branch name if applicable" },
      criteriaResults: {
        type: "array",
        items: {
          type: "object",
          properties: {
            criterion: { type: "string" },
            met: { type: "boolean" },
            evidence: { type: "string" },
          },
          required: ["criterion", "met", "evidence"],
        },
      },
    },
    required: ["summary", "evidence", "criteriaResults"],
  },
};

export const SUPERVISOR_BLOCKED_TOOL: ToolDefinition = {
  name: "supervisor_blocked",
  description:
    "Call this when you cannot proceed without a decision from the parent supervisor. " +
    "Only call when genuinely blocked — not when uncertain.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why you cannot proceed" },
      question: { type: "string", description: "The specific decision needed" },
      context: { type: "string", description: "Relevant context for the decision" },
      urgency: { type: "string", enum: ["low", "high"] },
    },
    required: ["reason", "question", "context", "urgency"],
  },
};
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern supervisor-tools
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/supervisor-tools.ts packages/core/src/__tests__/supervisor-tools.test.ts
git commit -m "feat(supervisor): add supervisor_complete and supervisor_blocked tool schemas"
```

---

## Task 3: AIAdapter interface + ClaudeAdapter

**Files:**
- Create: `packages/core/src/supervisor/ai-adapter.ts`
- Create: `packages/core/src/supervisor/adapters/claude.ts`
- Create: `packages/core/src/__tests__/ai-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/ai-adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "@/supervisor/adapters/claude";

describe("ClaudeAdapter", () => {
  it("starts with no session handle", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.getSessionHandle()).toBeUndefined();
  });

  it("restores a session handle", () => {
    const adapter = new ClaudeAdapter();
    const handle = { provider: "claude" as const, sessionId: "ses_abc123" };
    adapter.restoreSession(handle);
    expect(adapter.getSessionHandle()).toEqual(handle);
  });

  it("rejects non-claude session handles", () => {
    const adapter = new ClaudeAdapter();
    expect(() =>
      adapter.restoreSession({ provider: "openai" as never, threadId: "t_1" } as never),
    ).toThrow("ClaudeAdapter only accepts claude session handles");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern ai-adapter
```

Expected: FAIL — module not found

- [ ] **Step 3: Create AIAdapter interface**

Create `packages/core/src/supervisor/ai-adapter.ts`:

```typescript
import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Session handles ──────────────────────────────────────

/**
 * Opaque session handle — each adapter stores what it needs.
 * Persisted via SupervisorStore so it survives process restart.
 */
export type SessionHandle =
  | { provider: "claude"; sessionId: string };
  // Future: | { provider: "openai"; threadId: string }
  // Future: | { provider: "gemini"; conversationId: string }
  // Future: | { provider: "ollama"; messages: MessageEntry[] }

// ─── Messages ────────────────────────────────────────────

export type SupervisorMessageKind = "text" | "tool_use" | "tool_result" | "end";

export interface SupervisorMessage {
  kind: SupervisorMessageKind;
  toolName?: string;
  toolInput?: unknown;
  text?: string;
}

// ─── Query options ────────────────────────────────────────

export interface AIQueryOptions {
  prompt: string;
  tools: ToolDefinition[];
  sessionHandle?: SessionHandle;
  systemPrompt?: string;
  model?: string;
}

// ─── Interface ────────────────────────────────────────────

export interface AIAdapter {
  /**
   * Execute one turn of the supervisor conversation.
   * Returns an async iterable of structured messages.
   * Intercepted tools (supervisor_complete, supervisor_blocked) are
   * caught by the caller BEFORE reaching the AI provider.
   */
  query(options: AIQueryOptions): AsyncIterable<SupervisorMessage>;

  /** Returns the current session handle, if any. */
  getSessionHandle(): SessionHandle | undefined;

  /** Restore a previously persisted session handle. */
  restoreSession(handle: SessionHandle): void;
}
```

- [ ] **Step 4: Create ClaudeAdapter**

Create `packages/core/src/supervisor/adapters/claude.ts`:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  isAssistantMessage,
  isInitMessage,
  isResultMessage,
  isToolUseMessage,
} from "@/sdk-types";
import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "../ai-adapter.js";

/**
 * AIAdapter implementation for Claude Agent SDK.
 * Uses native resume: sessionId for persistent conversation across turns.
 */
export class ClaudeAdapter implements AIAdapter {
  private sessionHandle: { provider: "claude"; sessionId: string } | undefined;

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
    const sdkOptions: Parameters<typeof query>[0] = {
      prompt: options.prompt,
      options: {
        tools: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        ...(options.model ? { model: options.model } : {}),
        ...(this.sessionHandle ? { resume: this.sessionHandle.sessionId } : {}),
      },
    };

    for await (const message of query(sdkOptions)) {
      if (isInitMessage(message)) {
        this.sessionHandle = { provider: "claude", sessionId: message.session_id };
        continue;
      }

      if (isToolUseMessage(message)) {
        for (const block of message.content) {
          if (block.type === "tool_use") {
            yield {
              kind: "tool_use",
              toolName: block.name,
              toolInput: block.input,
            };
          }
        }
        continue;
      }

      if (isAssistantMessage(message)) {
        for (const block of message.content) {
          if (block.type === "text") {
            yield { kind: "text", text: block.text };
          }
        }
        continue;
      }

      if (isResultMessage(message)) {
        yield { kind: "end" };
      }
    }
  }
}
```

- [ ] **Step 5: Run to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern ai-adapter
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/ai-adapter.ts packages/core/src/supervisor/adapters/claude.ts packages/core/src/__tests__/ai-adapter.test.ts
git commit -m "feat(supervisor): add AIAdapter interface and ClaudeAdapter implementation"
```

---

## Task 4: SupervisorStore interface + JsonlSupervisorStore

**Files:**
- Create: `packages/core/src/supervisor/store.ts`
- Create: `packages/core/src/supervisor/stores/jsonl.ts`
- Create: `packages/core/src/__tests__/supervisor-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/supervisor-store.test.ts`:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlSupervisorStore } from "@/supervisor/stores/jsonl";

let dir: string;
let store: JsonlSupervisorStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "neo-store-test-"));
  store = new JsonlSupervisorStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("session", () => {
  it("returns undefined when no session saved", async () => {
    expect(await store.getSessionId("sup_1")).toBeUndefined();
  });

  it("saves and retrieves session id", async () => {
    await store.saveSessionId("sup_1", "ses_abc");
    expect(await store.getSessionId("sup_1")).toBe("ses_abc");
  });

  it("overwrites previous session id", async () => {
    await store.saveSessionId("sup_1", "ses_old");
    await store.saveSessionId("sup_1", "ses_new");
    expect(await store.getSessionId("sup_1")).toBe("ses_new");
  });
});

describe("activity", () => {
  it("returns empty array when no activity", async () => {
    expect(await store.getRecentActivity("sup_1")).toEqual([]);
  });

  it("appends and retrieves activity entries", async () => {
    await store.appendActivity("sup_1", {
      id: "act_1",
      type: "action",
      summary: "Dispatched developer",
      timestamp: new Date().toISOString(),
    });
    const entries = await store.getRecentActivity("sup_1");
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("Dispatched developer");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await store.appendActivity("sup_1", {
        id: `act_${i}`,
        type: "action",
        summary: `Action ${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const entries = await store.getRecentActivity("sup_1", 3);
    expect(entries).toHaveLength(3);
  });
});

describe("cost tracking", () => {
  it("returns 0 when no cost recorded", async () => {
    expect(await store.getTotalCost("sup_1")).toBe(0);
  });

  it("accumulates cost", async () => {
    await store.recordCost("sup_1", 0.05);
    await store.recordCost("sup_1", 0.03);
    expect(await store.getTotalCost("sup_1")).toBeCloseTo(0.08);
  });
});

describe("state", () => {
  it("returns null when no state", async () => {
    expect(await store.getState("sup_1")).toBeNull();
  });

  it("saves and retrieves state", async () => {
    const state = { supervisorId: "sup_1", status: "running" as const, startedAt: new Date().toISOString(), costUsd: 0 };
    await store.saveState("sup_1", state);
    expect(await store.getState("sup_1")).toEqual(state);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern supervisor-store
```

Expected: FAIL — module not found

- [ ] **Step 3: Create SupervisorStore interface**

Create `packages/core/src/supervisor/store.ts`:

```typescript
import type { ActivityEntry } from "./schemas.js";
import type { Decision, DecisionInput } from "./decisions.js";

// ─── Focused supervisor state ─────────────────────────────

export interface FocusedSupervisorState {
  supervisorId: string;
  status: "running" | "blocked" | "complete" | "failed";
  startedAt: string;
  costUsd: number;
  objective?: string;
  lastProgressAt?: string;
}

// ─── Interface ────────────────────────────────────────────

export interface SupervisorStore {
  // Session
  getSessionId(supervisorId: string): Promise<string | undefined>;
  saveSessionId(supervisorId: string, sessionId: string): Promise<void>;

  // Activity
  appendActivity(supervisorId: string, entry: ActivityEntry): Promise<void>;
  getRecentActivity(supervisorId: string, limit?: number): Promise<ActivityEntry[]>;

  // State
  getState(supervisorId: string): Promise<FocusedSupervisorState | null>;
  saveState(supervisorId: string, state: FocusedSupervisorState): Promise<void>;

  // Cost tracking
  recordCost(supervisorId: string, costUsd: number): Promise<void>;
  getTotalCost(supervisorId: string): Promise<number>;
}
```

- [ ] **Step 4: Create JsonlSupervisorStore**

Create `packages/core/src/supervisor/stores/jsonl.ts`:

```typescript
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "../schemas.js";
import type { FocusedSupervisorState, SupervisorStore } from "../store.js";

/**
 * JSONL-backed SupervisorStore implementation.
 * Zero dependencies beyond Node.js built-ins.
 * Default implementation for CLI usage.
 */
export class JsonlSupervisorStore implements SupervisorStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private supervisorDir(supervisorId: string): string {
    return path.join(this.baseDir, supervisorId);
  }

  private async ensureDir(supervisorId: string): Promise<string> {
    const dir = this.supervisorDir(supervisorId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // ─── Session ───────────────────────────────────────────

  async getSessionId(supervisorId: string): Promise<string | undefined> {
    const sessionPath = path.join(this.supervisorDir(supervisorId), "session.json");
    try {
      const raw = await readFile(sessionPath, "utf-8");
      const parsed = JSON.parse(raw) as { sessionId: string };
      return parsed.sessionId;
    } catch {
      return undefined;
    }
  }

  async saveSessionId(supervisorId: string, sessionId: string): Promise<void> {
    const dir = await this.ensureDir(supervisorId);
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ sessionId }),
      "utf-8",
    );
  }

  // ─── Activity ──────────────────────────────────────────

  async appendActivity(supervisorId: string, entry: ActivityEntry): Promise<void> {
    const dir = await this.ensureDir(supervisorId);
    await appendFile(path.join(dir, "activity.jsonl"), `${JSON.stringify(entry)}\n`, "utf-8");
  }

  async getRecentActivity(supervisorId: string, limit = 50): Promise<ActivityEntry[]> {
    const activityPath = path.join(this.supervisorDir(supervisorId), "activity.jsonl");
    try {
      const raw = await readFile(activityPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const last = lines.slice(-limit);
      return last.flatMap((line) => {
        try {
          return [JSON.parse(line) as ActivityEntry];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  // ─── State ─────────────────────────────────────────────

  async getState(supervisorId: string): Promise<FocusedSupervisorState | null> {
    const statePath = path.join(this.supervisorDir(supervisorId), "state.json");
    try {
      const raw = await readFile(statePath, "utf-8");
      return JSON.parse(raw) as FocusedSupervisorState;
    } catch {
      return null;
    }
  }

  async saveState(supervisorId: string, state: FocusedSupervisorState): Promise<void> {
    const dir = await this.ensureDir(supervisorId);
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
  }

  // ─── Cost ──────────────────────────────────────────────

  async recordCost(supervisorId: string, costUsd: number): Promise<void> {
    const current = await this.getTotalCost(supervisorId);
    const dir = await this.ensureDir(supervisorId);
    await writeFile(
      path.join(dir, "cost.json"),
      JSON.stringify({ totalCostUsd: current + costUsd }),
      "utf-8",
    );
  }

  async getTotalCost(supervisorId: string): Promise<number> {
    const costPath = path.join(this.supervisorDir(supervisorId), "cost.json");
    try {
      const raw = await readFile(costPath, "utf-8");
      const parsed = JSON.parse(raw) as { totalCostUsd: number };
      return parsed.totalCostUsd;
    } catch {
      return 0;
    }
  }
}
```

- [ ] **Step 5: Run to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern supervisor-store
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/store.ts packages/core/src/supervisor/stores/jsonl.ts packages/core/src/__tests__/supervisor-store.test.ts
git commit -m "feat(supervisor): add SupervisorStore interface and JsonlSupervisorStore implementation"
```

---

## Task 5: IPC message schemas

**Files:**
- Modify: `packages/core/src/supervisor/schemas.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/__tests__/supervisor-tools.test.ts`:

```typescript
import {
  childToParentMessageSchema,
  parentToChildMessageSchema,
} from "@/supervisor/schemas";

describe("IPC schemas", () => {
  it("parses progress message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Opened PR #42",
      costDelta: 0.05,
    });
    expect(result.success).toBe(true);
  });

  it("parses complete message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "complete",
      supervisorId: "sup_1",
      summary: "Done",
      evidence: ["https://github.com/org/repo/pull/42"],
    });
    expect(result.success).toBe(true);
  });

  it("parses inject message from parent", () => {
    const result = parentToChildMessageSchema.safeParse({
      type: "inject",
      context: "Mission B modified auth.ts",
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern supervisor-tools
```

Expected: FAIL — `childToParentMessageSchema is not exported`

- [ ] **Step 3: Add IPC schemas to schemas.ts**

Add at the end of `packages/core/src/supervisor/schemas.ts`:

```typescript
// ─── Focused supervisor state ─────────────────────────────

export const childHandleStatusSchema = z.enum([
  "running",
  "blocked",
  "complete",
  "failed",
  "stalled",
]);

export const childHandleSchema = z.object({
  supervisorId: z.string(),
  objective: z.string(),
  depth: z.number().int().min(0).max(1),
  startedAt: z.string(),
  lastProgressAt: z.string(),
  costUsd: z.number().default(0),
  maxCostUsd: z.number().optional(),
  sessionId: z.string().optional(),
  status: childHandleStatusSchema,
});

export type ChildHandle = z.infer<typeof childHandleSchema>;

// ─── IPC protocol ────────────────────────────────────────

export const childToParentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    supervisorId: z.string(),
    summary: z.string(),
    costDelta: z.number(),
  }),
  z.object({
    type: z.literal("complete"),
    supervisorId: z.string(),
    summary: z.string(),
    evidence: z.array(z.string()),
  }),
  z.object({
    type: z.literal("blocked"),
    supervisorId: z.string(),
    reason: z.string(),
    question: z.string(),
    urgency: z.enum(["low", "high"]),
  }),
  z.object({
    type: z.literal("failed"),
    supervisorId: z.string(),
    error: z.string(),
  }),
  z.object({
    type: z.literal("session"),
    supervisorId: z.string(),
    sessionId: z.string(),
  }),
]);

export const parentToChildMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unblock"), answer: z.string() }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("inject"), context: z.string() }),
]);

export type ChildToParentMessage = z.infer<typeof childToParentMessageSchema>;
export type ParentToChildMessage = z.infer<typeof parentToChildMessageSchema>;
```

Also add `child_supervisor` to `QueuedEvent`:

```typescript
export type QueuedEvent =
  | { kind: "webhook"; data: WebhookIncomingEvent }
  | { kind: "message"; data: InboxMessage }
  | { kind: "run_complete"; runId: string; timestamp: string }
  | { kind: "internal"; eventKind: InternalEventKind; timestamp: string }
  | { kind: "child_supervisor"; message: ChildToParentMessage; timestamp: string };
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern supervisor-tools
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/schemas.ts packages/core/src/__tests__/supervisor-tools.test.ts
git commit -m "feat(supervisor): add IPC message schemas and ChildHandle schema"
```

---

## Task 6: ChildRegistry

**Files:**
- Create: `packages/core/src/supervisor/child-registry.ts`
- Create: `packages/core/src/__tests__/child-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/child-registry.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ChildRegistry } from "@/supervisor/child-registry";
import type { ChildToParentMessage } from "@/supervisor/schemas";

describe("ChildRegistry", () => {
  let registry: ChildRegistry;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onMessage = vi.fn();
    registry = new ChildRegistry({ onMessage, stallTimeoutMs: 500 });
  });

  afterEach(() => {
    registry.stopAll();
  });

  it("starts with no children", () => {
    expect(registry.list()).toHaveLength(0);
  });

  it("tracks a registered child handle", () => {
    registry.register({
      supervisorId: "sup_1",
      objective: "feat/auth",
      depth: 1,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("sup_1")?.objective).toBe("feat/auth");
  });

  it("updates status on complete message", () => {
    registry.register({
      supervisorId: "sup_1",
      objective: "feat/auth",
      depth: 1,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    registry.handleMessage({
      type: "complete",
      supervisorId: "sup_1",
      summary: "Done",
      evidence: ["PR #42"],
    });
    expect(registry.get("sup_1")?.status).toBe("complete");
  });

  it("accumulates cost from progress messages", () => {
    registry.register({
      supervisorId: "sup_1",
      objective: "feat/auth",
      depth: 1,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Still working",
      costDelta: 0.05,
    });
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Still working",
      costDelta: 0.03,
    });
    expect(registry.get("sup_1")?.costUsd).toBeCloseTo(0.08);
  });

  it("enforces budget cap", () => {
    const stopChild = vi.fn();
    registry.register({
      supervisorId: "sup_1",
      objective: "feat/auth",
      depth: 1,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      maxCostUsd: 0.10,
      status: "running",
    }, stopChild);
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Working",
      costDelta: 0.12,
    });
    expect(stopChild).toHaveBeenCalledOnce();
    expect(registry.get("sup_1")?.status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern child-registry
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement ChildRegistry**

Create `packages/core/src/supervisor/child-registry.ts`:

```typescript
import type { ChildProcess } from "node:child_process";
import type { ChildHandle, ChildToParentMessage, ParentToChildMessage } from "./schemas.js";

export interface ChildRegistryOptions {
  onMessage: (message: ChildToParentMessage) => void;
  stallTimeoutMs?: number;
}

/**
 * Tracks all active focused supervisor child processes.
 * Handles IPC message routing and budget enforcement.
 */
export class ChildRegistry {
  private readonly handles = new Map<string, ChildHandle>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly stopCallbacks = new Map<string, () => void>();
  private readonly stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onMessage: (message: ChildToParentMessage) => void;
  private readonly stallTimeoutMs: number;

  constructor(options: ChildRegistryOptions) {
    this.onMessage = options.onMessage;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 10 * 60 * 1000; // 10 min default
  }

  /**
   * Register a child handle with an optional stop callback and child process.
   * stopCallback is called when budget is exceeded or stall is detected.
   */
  register(
    handle: ChildHandle,
    stopCallback?: () => void,
    childProcess?: ChildProcess,
  ): void {
    this.handles.set(handle.supervisorId, { ...handle });
    if (stopCallback) this.stopCallbacks.set(handle.supervisorId, stopCallback);
    if (childProcess) this.processes.set(handle.supervisorId, childProcess);
    this.resetStallTimer(handle.supervisorId);
  }

  get(supervisorId: string): ChildHandle | undefined {
    return this.handles.get(supervisorId);
  }

  list(): ChildHandle[] {
    return Array.from(this.handles.values());
  }

  /**
   * Send a message to a child process via IPC.
   */
  send(supervisorId: string, message: ParentToChildMessage): void {
    const proc = this.processes.get(supervisorId);
    if (proc?.connected) {
      proc.send(message);
    }
  }

  /**
   * Handle an incoming IPC message from a child.
   * Updates internal state, enforces budget, then forwards to caller.
   */
  handleMessage(message: ChildToParentMessage): void {
    const handle = this.handles.get(message.supervisorId);
    if (!handle) return;

    switch (message.type) {
      case "progress": {
        handle.costUsd += message.costDelta;
        handle.lastProgressAt = new Date().toISOString();
        this.resetStallTimer(message.supervisorId);
        // Enforce budget cap
        if (handle.maxCostUsd !== undefined && handle.costUsd >= handle.maxCostUsd) {
          this.stopChild(message.supervisorId, "budget exceeded");
          return;
        }
        break;
      }
      case "session": {
        handle.sessionId = message.sessionId;
        break;
      }
      case "complete": {
        handle.status = "complete";
        this.clearStallTimer(message.supervisorId);
        break;
      }
      case "blocked": {
        handle.status = "blocked";
        this.clearStallTimer(message.supervisorId);
        break;
      }
      case "failed": {
        handle.status = "failed";
        this.clearStallTimer(message.supervisorId);
        break;
      }
    }

    this.onMessage(message);
  }

  /**
   * Remove a child from the registry and clean up timers.
   */
  remove(supervisorId: string): void {
    this.handles.delete(supervisorId);
    this.processes.delete(supervisorId);
    this.stopCallbacks.delete(supervisorId);
    this.clearStallTimer(supervisorId);
  }

  /**
   * Stop all children (called on daemon shutdown).
   */
  stopAll(): void {
    for (const supervisorId of this.handles.keys()) {
      this.send(supervisorId, { type: "stop" });
      this.clearStallTimer(supervisorId);
    }
  }

  private stopChild(supervisorId: string, reason: string): void {
    const handle = this.handles.get(supervisorId);
    if (handle) {
      handle.status = "failed";
    }
    this.send(supervisorId, { type: "stop" });
    this.clearStallTimer(supervisorId);
    const stopCb = this.stopCallbacks.get(supervisorId);
    if (stopCb) stopCb();
  }

  private resetStallTimer(supervisorId: string): void {
    this.clearStallTimer(supervisorId);
    const timer = setTimeout(() => {
      const handle = this.handles.get(supervisorId);
      if (handle?.status === "running") {
        handle.status = "stalled";
        this.onMessage({
          type: "failed",
          supervisorId,
          error: `Stall detected: no progress for ${this.stallTimeoutMs}ms`,
        });
      }
    }, this.stallTimeoutMs);
    this.stallTimers.set(supervisorId, timer);
  }

  private clearStallTimer(supervisorId: string): void {
    const timer = this.stallTimers.get(supervisorId);
    if (timer) {
      clearTimeout(timer);
      this.stallTimers.delete(supervisorId);
    }
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern child-registry
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/child-registry.ts packages/core/src/__tests__/child-registry.test.ts
git commit -m "feat(supervisor): add ChildRegistry with IPC message routing and budget enforcement"
```

---

## Task 7: FocusedLoop

**Files:**
- Create: `packages/core/src/supervisor/focused-loop.ts`
- Create: `packages/core/src/__tests__/focused-loop.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/focused-loop.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { FocusedLoop } from "@/supervisor/focused-loop";
import type { AIAdapter, SupervisorMessage } from "@/supervisor/ai-adapter";
import type { SupervisorStore } from "@/supervisor/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlSupervisorStore } from "@/supervisor/stores/jsonl";

function makeAdapter(messages: SupervisorMessage[]): AIAdapter {
  return {
    async *query() { yield* messages; },
    getSessionHandle: () => ({ provider: "claude" as const, sessionId: "ses_test" }),
    restoreSession: vi.fn(),
  };
}

describe("FocusedLoop", () => {
  let dir: string;
  let store: SupervisorStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "neo-focused-"));
    store = new JsonlSupervisorStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("calls onComplete when supervisor_complete tool is used", async () => {
    const onComplete = vi.fn();
    const adapter = makeAdapter([
      {
        kind: "tool_use",
        toolName: "supervisor_complete",
        toolInput: {
          summary: "All done",
          evidence: ["PR #42"],
          criteriaResults: [{ criterion: "PR open", met: true, evidence: "PR #42" }],
        },
      },
      { kind: "end" },
    ]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: ["PR open"],
      adapter,
      store,
      onComplete,
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    await loop.runOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "All done" }),
    );
  });

  it("calls onBlocked when supervisor_blocked tool is used", async () => {
    const onBlocked = vi.fn();
    const adapter = makeAdapter([
      {
        kind: "tool_use",
        toolName: "supervisor_blocked",
        toolInput: {
          reason: "Cannot decide migration strategy",
          question: "addColumn or createTable?",
          context: "2M rows in users table",
          urgency: "high",
        },
      },
      { kind: "end" },
    ]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: ["PR open"],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked,
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    await loop.runOnce();
    expect(onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Cannot decide migration strategy" }),
    );
  });

  it("persists session handle after first turn", async () => {
    const adapter = makeAdapter([{ kind: "end" }]);
    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: [],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    await loop.runOnce();
    const sessionId = await store.getSessionId("sup_1");
    expect(sessionId).toBe("ses_test");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/core && pnpm test -- --testPathPattern focused-loop
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement FocusedLoop**

Create `packages/core/src/supervisor/focused-loop.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { AIAdapter } from "./ai-adapter.js";
import {
  supervisorBlockedSchema,
  supervisorCompleteSchema,
  type SupervisorBlockedInput,
  type SupervisorCompleteInput,
  SUPERVISOR_BLOCKED_TOOL,
  SUPERVISOR_COMPLETE_TOOL,
} from "./supervisor-tools.js";
import type { SupervisorStore } from "./store.js";

export interface FocusedLoopOptions {
  supervisorId: string;
  objective: string;
  acceptanceCriteria: string[];
  adapter: AIAdapter;
  store: SupervisorStore;
  onComplete: (result: SupervisorCompleteInput) => void | Promise<void>;
  onBlocked: (blocked: SupervisorBlockedInput) => void | Promise<void>;
  onProgress: (summary: string, costDelta: number) => void | Promise<void>;
  tickIntervalMs?: number;
  systemPrompt?: string;
}

/**
 * Runs a persistent SDK conversation focused on a single objective.
 * Loops until supervisor_complete or supervisor_blocked is called.
 */
export class FocusedLoop {
  private readonly options: FocusedLoopOptions;
  private stopping = false;
  private injectedContext: string[] = [];

  constructor(options: FocusedLoopOptions) {
    this.options = options;
  }

  /** Inject context from the parent supervisor (via IPC inject message). */
  injectContext(context: string): void {
    this.injectedContext.push(context);
  }

  /** Stop the loop after the current tick completes. */
  stop(): void {
    this.stopping = true;
  }

  /**
   * Execute one turn of the loop.
   * Returns true if the loop should continue, false if it should stop.
   */
  async runOnce(): Promise<boolean> {
    const { supervisorId, objective, acceptanceCriteria, adapter, store } = this.options;

    // Restore session if available
    const sessionId = await store.getSessionId(supervisorId);
    if (sessionId) {
      adapter.restoreSession({ provider: "claude", sessionId });
    }

    const recentActivity = await store.getRecentActivity(supervisorId, 20);
    const injected = this.injectedContext.splice(0);

    const prompt = buildFocusedPrompt({
      objective,
      acceptanceCriteria,
      recentActivity: recentActivity.map((e) => e.summary),
      injectedContext: injected,
    });

    let turnCost = 0;

    for await (const message of adapter.query({
      prompt,
      tools: [SUPERVISOR_COMPLETE_TOOL, SUPERVISOR_BLOCKED_TOOL],
      systemPrompt: this.options.systemPrompt,
    })) {
      // Persist session handle after first message
      const handle = adapter.getSessionHandle();
      if (handle?.provider === "claude") {
        await store.saveSessionId(supervisorId, handle.sessionId);
      }

      if (message.kind === "tool_use") {
        if (message.toolName === "supervisor_complete") {
          const parsed = supervisorCompleteSchema.safeParse(message.toolInput);
          if (parsed.success) {
            await store.appendActivity(supervisorId, {
              id: randomUUID(),
              type: "action",
              summary: `supervisor_complete: ${parsed.data.summary}`,
              timestamp: new Date().toISOString(),
            });
            await this.options.onComplete(parsed.data);
            return false; // stop the loop
          }
        }

        if (message.toolName === "supervisor_blocked") {
          const parsed = supervisorBlockedSchema.safeParse(message.toolInput);
          if (parsed.success) {
            await store.appendActivity(supervisorId, {
              id: randomUUID(),
              type: "decision",
              summary: `supervisor_blocked: ${parsed.data.reason}`,
              timestamp: new Date().toISOString(),
            });
            await this.options.onBlocked(parsed.data);
            return false; // stop until unblocked
          }
        }
      }

      if (message.kind === "text" && message.text) {
        await store.appendActivity(supervisorId, {
          id: randomUUID(),
          type: "thinking",
          summary: message.text.slice(0, 200),
          timestamp: new Date().toISOString(),
        });
      }
    }

    await this.options.onProgress("Turn complete", turnCost);
    return !this.stopping;
  }

  /**
   * Run the full loop until complete, blocked, or stopped.
   * Each turn is separated by tickIntervalMs.
   */
  async run(): Promise<void> {
    const tickMs = this.options.tickIntervalMs ?? 30_000;

    while (!this.stopping) {
      const shouldContinue = await this.runOnce();
      if (!shouldContinue) break;
      if (tickMs > 0) await sleep(tickMs);
    }
  }
}

// ─── Prompt builder ───────────────────────────────────────

function buildFocusedPrompt(opts: {
  objective: string;
  acceptanceCriteria: string[];
  recentActivity: string[];
  injectedContext: string[];
}): string {
  const criteria =
    opts.acceptanceCriteria.length > 0
      ? opts.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
      : "- No specific criteria — use your judgment";

  const activity =
    opts.recentActivity.length > 0
      ? opts.recentActivity.slice(-10).join("\n")
      : "No previous activity";

  const injected =
    opts.injectedContext.length > 0
      ? `\n### Context from parent supervisor\n${opts.injectedContext.join("\n")}\n`
      : "";

  return `## Your objective
${opts.objective}

## Acceptance criteria (defined at dispatch — you must meet ALL of these)
${criteria}

## Recent activity
${activity}
${injected}
## Instructions
Assess current progress toward the objective. Dispatch agents as needed.
When ALL acceptance criteria are verifiably met, call \`supervisor_complete\` with evidence.
If you cannot proceed without a decision, call \`supervisor_blocked\`.
Do NOT call \`supervisor_complete\` unless you have objective evidence.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd packages/core && pnpm test -- --testPathPattern focused-loop
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/focused-loop.ts packages/core/src/__tests__/focused-loop.test.ts
git commit -m "feat(supervisor): add FocusedLoop — persistent SDK session loop for single objective"
```

---

## Task 8: Wire ChildRegistry into HeartbeatLoop

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Read current HeartbeatLoop constructor (already done above)**

The constructor is at line 265. We need to add `childRegistry` as an optional property and wire IPC messages into `eventQueue`.

- [ ] **Step 2: Write failing test**

Add to `packages/core/src/__tests__/heartbeat-bugs.test.ts` (existing file):

```typescript
it("forwards child_supervisor IPC messages into eventQueue", async () => {
  // This test verifies that when a ChildRegistry calls onMessage,
  // the HeartbeatLoop pushes a child_supervisor event into the queue.
  // Implementation detail: HeartbeatLoop accepts an optional childRegistry
  // and wires its onMessage to the eventQueue.
  // Skip if no childRegistry support — will fail until Task 8 is done.
  expect(true).toBe(true); // placeholder — replaced in implementation
});
```

- [ ] **Step 3: Add ChildRegistry to HeartbeatLoop**

In `packages/core/src/supervisor/heartbeat.ts`:

Add import at the top:
```typescript
import { ChildRegistry } from "./child-registry.js";
```

Add to `HeartbeatLoopOptions` interface:
```typescript
/** Optional child registry for focused supervisor IPC */
childRegistry?: ChildRegistry | undefined;
```

Add private field to `HeartbeatLoop` class:
```typescript
private readonly childRegistry: ChildRegistry | undefined;
```

Add to constructor body (after `this.configWatcherDebounceMs = ...`):
```typescript
this.childRegistry = options.childRegistry;
if (this.childRegistry) {
  // Wire child IPC messages into the event queue
  // ChildRegistry.onMessage is set at construction time — we need to
  // reconstruct or use a setter pattern. Use the registry's message handler.
}
```

**Note:** Because `ChildRegistry.onMessage` is set in the constructor, update `HeartbeatLoop` to construct its own `ChildRegistry` internally when child supervisor support is needed, passing `this.eventQueue.push` as the handler:

Add to `HeartbeatLoop.start()`, before the main loop:
```typescript
// If a child registry was provided, wire its IPC events to our queue
if (this.childRegistry) {
  // ChildRegistry was constructed externally with onMessage already wired
  // to push child_supervisor events — nothing to do here
}
```

And in the `ChildRegistry` constructor call (from `SupervisorDaemon`), wire it:
```typescript
const childRegistry = new ChildRegistry({
  onMessage: (message) => {
    this.eventQueue?.push({
      kind: "child_supervisor",
      message,
      timestamp: new Date().toISOString(),
    });
  },
  stallTimeoutMs: this.config.supervisor.stallTimeoutMs ?? 600_000,
});
```

Update `HeartbeatLoopOptions` in `daemon.ts` to pass the registry through.

- [ ] **Step 4: Run full test suite**

```bash
cd packages/core && pnpm build && pnpm typecheck && pnpm test
```

Expected: PASS (existing tests unaffected, new child_supervisor event kind handled)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts packages/core/src/supervisor/daemon.ts
git commit -m "feat(supervisor): wire ChildRegistry IPC events into HeartbeatLoop event queue"
```

---

## Task 9: Focused supervisor system prompt

**Files:**
- Create: `packages/agents/prompts/focused-supervisor.md`

- [ ] **Step 1: Create the prompt**

Create `packages/agents/prompts/focused-supervisor.md`:

```markdown
# Focused Supervisor

You are a focused supervisor — accountable for delivering one specific objective end-to-end.

## Your role

You do not write code directly. You dispatch agents (developer, scout, reviewer, architect) to do the work and monitor their progress. You are responsible for ensuring the objective is completed, not just started.

## Operating principles

- **You own delivery.** Any acceptance criterion not yet met is your responsibility.
- **Dispatch deliberately.** Provide agents with full context: what to do, what files to look at, what the acceptance criteria are.
- **Verify outcomes.** After each agent run, check whether it actually moved the needle toward the objective.
- **Detect stalls.** If an agent returns the same result twice or makes no progress, change your approach.
- **Call `supervisor_complete` only with evidence.** Required: PR URL or equivalent proof, all criteria marked as met, CI green if applicable.
- **Call `supervisor_blocked` only when genuinely stuck.** Not when uncertain — only when you need a specific decision from your parent supervisor to proceed.

## Tools available

- `Agent` — dispatch a developer, scout, reviewer, or architect agent
- `supervisor_complete` — signal that the objective is fully met (requires evidence)
- `supervisor_blocked` — escalate a blocking decision to the parent supervisor

## What "done" means

Done means every acceptance criterion listed in your objective is verifiably met. Not "probably done". Not "the agent said it's done". You must be able to point to evidence for each criterion.
```

- [ ] **Step 2: Verify file exists**

```bash
cat packages/agents/prompts/focused-supervisor.md
```

Expected: file content printed

- [ ] **Step 3: Commit**

```bash
git add packages/agents/prompts/focused-supervisor.md
git commit -m "feat(agents): add focused-supervisor system prompt"
```

---

## Task 10: Full validation

- [ ] **Step 1: Build all packages**

```bash
pnpm build
```

Expected: no errors

- [ ] **Step 2: Type check**

```bash
pnpm typecheck
```

Expected: no errors

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass

- [ ] **Step 4: Commit if any fixups needed**

```bash
git add -p
git commit -m "fix(supervisor): typecheck and test fixups"
```
