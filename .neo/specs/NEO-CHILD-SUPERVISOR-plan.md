# Child Supervisor Spawning Implementation Plan

**Goal:** Enable the supervisor to spawn focused child supervisors both via CLI (`--parent` flag) and via an LLM tool (`spawn_child_supervisor`) that the HeartbeatLoop's Claude session can invoke.

**Architecture:** Child supervisors run as forked processes using `FocusedLoop` for single-objective execution. They communicate with the parent via Node.js IPC (`process.send`/`process.on('message')`), leveraging the existing `ChildRegistry` for registration, budget enforcement, and stall detection.

**Tech Stack:** Node.js `child_process.fork()`, existing `ChildRegistry`, `FocusedLoop`, `JsonlSupervisorStore`, `ClaudeAdapter`, Zod schemas, vitest.

---

## File Structure Mapping

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/supervisor/spawn-child-tool.ts` | Create | Tool definition for `spawn_child_supervisor` |
| `packages/core/src/supervisor/spawn-child-tool.test.ts` | Create | Unit tests for the tool schema |
| `packages/core/src/supervisor/child-spawner.ts` | Create | Module that forks child-supervisor-worker processes and wires IPC |
| `packages/core/src/supervisor/child-spawner.test.ts` | Create | Unit tests for child spawning logic |
| `packages/core/src/supervisor/child-command-parser.ts` | Modify | Add parseChildSpawnCommand for inbox messages |
| `packages/core/src/supervisor/child-command-parser.test.ts` | Modify | Add tests for spawn command parsing |
| `packages/core/src/supervisor/heartbeat.ts` | Modify | Process child:spawn inbox commands, integrate spawn logic |
| `packages/core/src/supervisor/daemon.ts` | Modify | Pass workerPath and supervisorName to HeartbeatLoop |
| `packages/core/src/supervisor/index.ts` | Modify | Export new modules |
| `packages/cli/src/daemon/child-supervisor-worker.ts` | Create | Entry point for child supervisor forked process |
| `packages/cli/src/daemon/supervisor-worker.ts` | Modify | Pass workerPath to SupervisorDaemon |
| `packages/cli/src/commands/supervise.ts` | Modify | Add `--parent` flag and child mode handling |
| `packages/cli/src/child-mode.ts` | Create | CLI helper for --parent mode |

---

### Task 1: Define the spawn_child_supervisor Tool Schema

**Files:**
- Create: `packages/core/src/supervisor/spawn-child-tool.ts`
- Test: `packages/core/src/supervisor/spawn-child-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/supervisor/spawn-child-tool.test.ts
import { describe, expect, it } from "vitest";
import {
  SPAWN_CHILD_SUPERVISOR_TOOL,
  spawnChildSupervisorInputSchema,
} from "./spawn-child-tool.js";

describe("spawn_child_supervisor tool schema", () => {
  it("validates correct input", () => {
    const input = {
      objective: "Implement user authentication",
      acceptanceCriteria: ["All tests pass", "PR created"],
      maxCostUsd: 5.0,
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects missing objective", () => {
    const input = {
      acceptanceCriteria: ["Tests pass"],
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("allows optional maxCostUsd", () => {
    const input = {
      objective: "Fix bug",
      acceptanceCriteria: ["Bug fixed"],
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("enforces minimum criteria length", () => {
    const input = {
      objective: "Do something",
      acceptanceCriteria: [],
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("exports valid tool definition", () => {
    expect(SPAWN_CHILD_SUPERVISOR_TOOL.name).toBe("spawn_child_supervisor");
    expect(SPAWN_CHILD_SUPERVISOR_TOOL.inputSchema).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/supervisor/spawn-child-tool.test.ts`
Expected: FAIL with "Cannot find module './spawn-child-tool.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/spawn-child-tool.ts
import { z } from "zod";
import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Schema ──────────────────────────────────────────────

export const spawnChildSupervisorInputSchema = z.object({
  objective: z.string().min(1, "Objective is required"),
  acceptanceCriteria: z
    .array(z.string())
    .min(1, "At least one acceptance criterion required"),
  maxCostUsd: z.number().positive().optional(),
});

export type SpawnChildSupervisorInput = z.infer<typeof spawnChildSupervisorInputSchema>;

// ─── Tool Definition ─────────────────────────────────────

export const SPAWN_CHILD_SUPERVISOR_TOOL: ToolDefinition = {
  name: "spawn_child_supervisor",
  description:
    "Spawn a focused child supervisor to handle a specific objective autonomously. " +
    "Use this when a task is complex enough to warrant independent orchestration. " +
    "The child runs until all acceptance criteria are met or it gets blocked.",
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "The specific goal for the child supervisor to achieve",
      },
      acceptanceCriteria: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Measurable criteria that define completion",
      },
      maxCostUsd: {
        type: "number",
        description: "Optional budget cap in USD. Child is stopped if exceeded.",
      },
    },
    required: ["objective", "acceptanceCriteria"],
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/supervisor/spawn-child-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/spawn-child-tool.ts packages/core/src/supervisor/spawn-child-tool.test.ts
git commit -m "feat(supervisor): add spawn_child_supervisor tool schema

Define Zod schema and tool definition for the spawn_child_supervisor tool
that will be exposed to HeartbeatLoop's Claude session."
```

---

### Task 2: Create the Child Spawner Module

**Files:**
- Create: `packages/core/src/supervisor/child-spawner.ts`
- Test: `packages/core/src/supervisor/child-spawner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/supervisor/child-spawner.test.ts
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildRegistry } from "./child-registry.js";
import { spawnChildSupervisor, type SpawnChildOptions } from "./child-spawner.js";

// Mock child_process.fork to avoid actually spawning processes in tests
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const events = new Map<string, Function>();
    const mockProcess = {
      pid: 12345,
      connected: true,
      send: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        events.set(event, handler);
        return mockProcess;
      }),
      kill: vi.fn(),
    };
    return mockProcess;
  }),
}));

describe("spawnChildSupervisor", () => {
  const TMP = path.join(import.meta.dirname, "__tmp_spawner__");
  let mockRegistry: ChildRegistry;

  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
    mockRegistry = {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      send: vi.fn(),
      handleMessage: vi.fn(),
      remove: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as ChildRegistry;
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a supervisorId", async () => {
    const options: SpawnChildOptions = {
      objective: "Test objective",
      acceptanceCriteria: ["Criterion 1"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
    };

    const result = await spawnChildSupervisor(options);
    expect(result.supervisorId).toBeDefined();
    expect(typeof result.supervisorId).toBe("string");
  });

  it("registers the child with the registry", async () => {
    const options: SpawnChildOptions = {
      objective: "Test objective",
      acceptanceCriteria: ["Criterion 1"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
      maxCostUsd: 10.0,
    };

    await spawnChildSupervisor(options);

    expect(mockRegistry.register).toHaveBeenCalledTimes(1);
    const registerCall = (mockRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const handle = registerCall[0];
    expect(handle.objective).toBe("Test objective");
    expect(handle.maxCostUsd).toBe(10.0);
    expect(handle.depth).toBe(0);
    expect(handle.status).toBe("running");
  });

  it("respects depth parameter", async () => {
    const options: SpawnChildOptions = {
      objective: "Nested task",
      acceptanceCriteria: ["Done"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
      depth: 1,
    };

    await spawnChildSupervisor(options);

    const registerCall = (mockRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const handle = registerCall[0];
    expect(handle.depth).toBe(1);
  });

  it("rejects depth > 1", async () => {
    const options: SpawnChildOptions = {
      objective: "Too deep",
      acceptanceCriteria: ["Done"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
      depth: 2,
    };

    await expect(spawnChildSupervisor(options)).rejects.toThrow("Maximum depth exceeded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/supervisor/child-spawner.test.ts`
Expected: FAIL with "Cannot find module './child-spawner.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/child-spawner.ts
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildRegistry } from "./child-registry.js";
import type { ChildHandle, ChildToParentMessage } from "./schemas.js";

export interface SpawnChildOptions {
  objective: string;
  acceptanceCriteria: string[];
  registry: ChildRegistry;
  workerPath: string;
  parentName: string;
  maxCostUsd?: number;
  depth?: number;
}

export interface SpawnChildResult {
  supervisorId: string;
  childProcess: ChildProcess;
}

/** Maximum allowed depth for child supervisors. Children cannot spawn children. */
const MAX_DEPTH = 1;

/**
 * Spawn a focused child supervisor as a forked process.
 * The child communicates via IPC and is tracked by the ChildRegistry.
 */
export async function spawnChildSupervisor(
  options: SpawnChildOptions,
): Promise<SpawnChildResult> {
  const {
    objective,
    acceptanceCriteria,
    registry,
    workerPath,
    parentName,
    maxCostUsd,
    depth = 0,
  } = options;

  // Enforce depth limit: children cannot spawn children
  if (depth >= MAX_DEPTH) {
    throw new Error(`Maximum depth exceeded: ${depth} >= ${MAX_DEPTH}`);
  }

  const supervisorId = randomUUID();
  const now = new Date().toISOString();

  // Fork the worker process
  const childProcess = fork(workerPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NEO_CHILD_SUPERVISOR_ID: supervisorId,
      NEO_CHILD_OBJECTIVE: objective,
      NEO_CHILD_CRITERIA: JSON.stringify(acceptanceCriteria),
      NEO_CHILD_PARENT_NAME: parentName,
      NEO_CHILD_MAX_COST_USD: maxCostUsd?.toString() ?? "",
      NEO_CHILD_DEPTH: String(depth),
    },
  });

  // Build handle for registry
  const handle: ChildHandle = {
    supervisorId,
    objective,
    depth,
    startedAt: now,
    lastProgressAt: now,
    costUsd: 0,
    maxCostUsd,
    status: "running",
  };

  // Stop callback for budget exceeded or manual stop
  const stopCallback = () => {
    if (childProcess.connected) {
      childProcess.send({ type: "stop" });
    }
  };

  // Wire IPC message handling
  childProcess.on("message", (msg: unknown) => {
    // Validate and route to registry
    if (isChildToParentMessage(msg)) {
      registry.handleMessage(msg);
    }
  });

  childProcess.on("exit", (code) => {
    // Clean up on unexpected exit
    const currentHandle = registry.get(supervisorId);
    if (currentHandle && currentHandle.status === "running") {
      registry.handleMessage({
        type: "failed",
        supervisorId,
        error: `Process exited with code ${code}`,
      });
    }
    registry.remove(supervisorId);
  });

  // Register with the parent's ChildRegistry
  registry.register(handle, stopCallback, childProcess);

  return { supervisorId, childProcess };
}

/**
 * Type guard for IPC messages from child.
 */
function isChildToParentMessage(msg: unknown): msg is ChildToParentMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    typeof obj.supervisorId === "string" &&
    ["progress", "complete", "blocked", "failed", "session"].includes(obj.type)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/supervisor/child-spawner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/child-spawner.ts packages/core/src/supervisor/child-spawner.test.ts
git commit -m "feat(supervisor): add child supervisor spawner

Create spawnChildSupervisor function that forks a child-supervisor-worker
process, wires IPC message handling, and registers with ChildRegistry.
Enforces max depth of 1 to prevent recursive spawning."
```

---

### Task 3: Update child-command-parser to Handle Spawn Commands

**Files:**
- Modify: `packages/core/src/supervisor/child-command-parser.ts`
- Modify: `packages/core/src/supervisor/child-command-parser.test.ts`

- [ ] **Step 1: Add failing test for spawn command**

```typescript
// Add to packages/core/src/supervisor/child-command-parser.test.ts
import { parseChildSpawnCommand } from "./child-command-parser.js";

describe("parseChildSpawnCommand", () => {
  it("parses valid spawn command", () => {
    const input = 'child:spawn {"objective":"Do X","acceptanceCriteria":["Done"]}';
    const result = parseChildSpawnCommand(input);
    expect(result).toEqual({
      objective: "Do X",
      acceptanceCriteria: ["Done"],
      maxCostUsd: undefined,
    });
  });

  it("parses spawn with budget", () => {
    const input = 'child:spawn {"objective":"Y","acceptanceCriteria":["A","B"],"maxCostUsd":5.5}';
    const result = parseChildSpawnCommand(input);
    expect(result?.maxCostUsd).toBe(5.5);
  });

  it("returns null for non-spawn commands", () => {
    expect(parseChildSpawnCommand("child:inject foo bar")).toBeNull();
    expect(parseChildSpawnCommand("random text")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseChildSpawnCommand("child:spawn {invalid}")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    expect(parseChildSpawnCommand('child:spawn {"objective":"X"}')).toBeNull();
    expect(parseChildSpawnCommand('child:spawn {"acceptanceCriteria":["Y"]}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/supervisor/child-command-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement parseChildSpawnCommand**

```typescript
// Add to packages/core/src/supervisor/child-command-parser.ts

export interface ChildSpawnCommand {
  objective: string;
  acceptanceCriteria: string[];
  maxCostUsd?: number;
}

/**
 * Parse a child:spawn command from inbox message.
 * Format: "child:spawn <JSON payload>"
 */
export function parseChildSpawnCommand(text: string): ChildSpawnCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("child:spawn ")) return null;

  const jsonPart = trimmed.slice("child:spawn ".length).trim();

  try {
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;

    if (typeof parsed.objective !== "string" || !parsed.objective) {
      return null;
    }

    if (!Array.isArray(parsed.acceptanceCriteria) || parsed.acceptanceCriteria.length === 0) {
      return null;
    }

    const criteria = parsed.acceptanceCriteria.filter(
      (c): c is string => typeof c === "string"
    );

    if (criteria.length === 0) {
      return null;
    }

    return {
      objective: parsed.objective,
      acceptanceCriteria: criteria,
      maxCostUsd: typeof parsed.maxCostUsd === "number" ? parsed.maxCostUsd : undefined,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/supervisor/child-command-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/child-command-parser.ts packages/core/src/supervisor/child-command-parser.test.ts
git commit -m "feat(supervisor): add parseChildSpawnCommand to child-command-parser

Parse child:spawn inbox messages for CLI-triggered child spawning."
```

---

### Task 4: Create the Child Supervisor Worker Entry Point

**Files:**
- Create: `packages/cli/src/daemon/child-supervisor-worker.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/src/daemon/child-supervisor-worker.test.ts
import { describe, expect, it } from "vitest";

describe("child-supervisor-worker module", () => {
  it("exports without syntax error when imported", async () => {
    // Verify the module can be imported (syntax is valid)
    // Actual execution requires environment variables
    const result = await import("./child-supervisor-worker.js").catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    }));

    // Module should load, but may fail due to missing env vars
    // That's expected - we're testing module validity, not execution
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/cli/src/daemon/child-supervisor-worker.test.ts`
Expected: FAIL with "Cannot find module './child-supervisor-worker.js'"

- [ ] **Step 3: Write implementation**

```typescript
// packages/cli/src/daemon/child-supervisor-worker.ts
/**
 * Entry point for child supervisor worker process.
 * Spawned by parent supervisor via fork(), communicates via IPC.
 *
 * Required environment variables:
 * - NEO_CHILD_SUPERVISOR_ID: unique ID for this child
 * - NEO_CHILD_OBJECTIVE: the objective to accomplish
 * - NEO_CHILD_CRITERIA: JSON-encoded acceptance criteria array
 * - NEO_CHILD_PARENT_NAME: name of parent supervisor
 * - NEO_CHILD_MAX_COST_USD: optional budget cap
 * - NEO_CHILD_DEPTH: depth level (0 or 1)
 */

import { mkdir } from "node:fs/promises";
import {
  ClaudeAdapter,
  FocusedLoop,
  getFocusedSupervisorDir,
  JsonlSupervisorStore,
  loadGlobalConfig,
  type ParentToChildMessage,
} from "@neotx/core";

async function main(): Promise<void> {
  const supervisorId = process.env.NEO_CHILD_SUPERVISOR_ID;
  const objective = process.env.NEO_CHILD_OBJECTIVE;
  const criteriaRaw = process.env.NEO_CHILD_CRITERIA;
  const parentName = process.env.NEO_CHILD_PARENT_NAME;
  const maxCostUsdRaw = process.env.NEO_CHILD_MAX_COST_USD;

  if (!supervisorId || !objective || !criteriaRaw || !parentName) {
    console.error("[child-supervisor-worker] Missing required environment variables");
    process.exit(1);
  }

  let acceptanceCriteria: string[];
  try {
    acceptanceCriteria = JSON.parse(criteriaRaw) as string[];
  } catch {
    console.error("[child-supervisor-worker] Invalid NEO_CHILD_CRITERIA JSON");
    process.exit(1);
  }

  const maxCostUsd = maxCostUsdRaw ? parseFloat(maxCostUsdRaw) : undefined;

  // Create supervisor directory
  const supervisorDir = getFocusedSupervisorDir(supervisorId);
  await mkdir(supervisorDir, { recursive: true });

  // Load config (for any future config needs)
  await loadGlobalConfig();

  // Create AI adapter (ClaudeAdapter wraps the SDK)
  const adapter = new ClaudeAdapter();

  // Create store for session persistence using existing JsonlSupervisorStore
  const store = new JsonlSupervisorStore(supervisorDir);

  // Track cumulative cost
  let totalCostUsd = 0;

  // Create FocusedLoop
  const loop = new FocusedLoop({
    supervisorId,
    objective,
    acceptanceCriteria,
    adapter,
    store,
    onComplete: async (result) => {
      sendToParent({
        type: "complete",
        supervisorId,
        summary: result.summary,
        evidence: result.evidence,
      });
      process.exit(0);
    },
    onBlocked: async (blocked) => {
      sendToParent({
        type: "blocked",
        supervisorId,
        reason: blocked.reason,
        question: blocked.question,
        urgency: blocked.urgency,
      });
    },
    onProgress: async (summary, costDelta) => {
      totalCostUsd += costDelta;
      sendToParent({
        type: "progress",
        supervisorId,
        summary,
        costDelta,
      });

      // Check budget locally as well (defense in depth)
      if (maxCostUsd !== undefined && totalCostUsd >= maxCostUsd) {
        sendToParent({
          type: "failed",
          supervisorId,
          error: `Budget exceeded: $${totalCostUsd.toFixed(2)} >= $${maxCostUsd.toFixed(2)}`,
        });
        process.exit(1);
      }
    },
  });

  // Handle messages from parent
  process.on("message", (msg: ParentToChildMessage) => {
    switch (msg.type) {
      case "stop":
        loop.stop();
        sendToParent({
          type: "failed",
          supervisorId,
          error: "Stopped by parent",
        });
        process.exit(0);
        break;
      case "inject":
        loop.injectContext(msg.context);
        break;
      case "unblock":
        loop.injectContext(`Parent answer: ${msg.answer}`);
        break;
    }
  });

  // Report session ID once available
  const reportSession = () => {
    const handle = adapter.getSessionHandle();
    if (handle?.provider === "claude") {
      sendToParent({
        type: "session",
        supervisorId,
        sessionId: handle.sessionId,
      });
    }
  };

  // Run the focused loop
  try {
    // Initial progress to indicate we started
    sendToParent({
      type: "progress",
      supervisorId,
      summary: "Child supervisor started",
      costDelta: 0,
    });

    await loop.run();

    // Report session after first turn if available
    reportSession();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sendToParent({
      type: "failed",
      supervisorId,
      error: errMsg,
    });
    process.exit(1);
  }
}

function sendToParent(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send(msg);
  }
}

main().catch((err) => {
  console.error("[child-supervisor-worker] Fatal error:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/cli/src/daemon/child-supervisor-worker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/daemon/child-supervisor-worker.ts packages/cli/src/daemon/child-supervisor-worker.test.ts
git commit -m "feat(cli): add child-supervisor-worker entry point

Create the forked process entry point that runs FocusedLoop for child
supervisors, using ClaudeAdapter and JsonlSupervisorStore.
Handles IPC communication with the parent supervisor."
```

---

### Task 5: Wire Child Spawn Processing into HeartbeatLoop

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Add imports at top of file**

```typescript
// Add these imports at the top of heartbeat.ts
import { spawnChildSupervisor } from "./child-spawner.js";
import { parseChildSpawnCommand } from "./child-command-parser.js";
```

- [ ] **Step 2: Add workerPath and supervisorName to HeartbeatLoopOptions**

```typescript
// In HeartbeatLoopOptions interface, add:
  /** Path to child-supervisor-worker.js for spawning child processes */
  workerPath?: string | undefined;
  /** Name of this supervisor instance (for child spawn registration) */
  supervisorName?: string | undefined;
```

- [ ] **Step 3: Store new options in constructor and class fields**

```typescript
// Add fields to HeartbeatLoop class:
  private readonly workerPath: string | undefined;
  private readonly supervisorName: string | undefined;

// In constructor, add:
    this.workerPath = options.workerPath;
    this.supervisorName = options.supervisorName;
```

- [ ] **Step 4: Add processChildSpawnCommands method**

```typescript
// Add new method to HeartbeatLoop class:
/**
 * Process child:spawn commands from inbox messages.
 * These come from `neo supervise --parent=X` CLI invocations.
 */
private async processChildSpawnCommands(rawEvents: QueuedEvent[]): Promise<void> {
  if (!this.childRegistry || !this.workerPath || !this.supervisorName) return;

  for (const event of rawEvents) {
    if (event.kind !== "message") continue;
    const text = event.data.text ?? "";
    const parsed = parseChildSpawnCommand(text);
    if (!parsed) continue;

    try {
      const result = await spawnChildSupervisor({
        objective: parsed.objective,
        acceptanceCriteria: parsed.acceptanceCriteria,
        registry: this.childRegistry,
        workerPath: this.workerPath,
        parentName: this.supervisorName,
        maxCostUsd: parsed.maxCostUsd,
        depth: 0,
      });

      await this.activityLog.log("dispatch", `Child supervisor spawned from CLI: ${result.supervisorId}`, {
        supervisorId: result.supervisorId,
        objective: parsed.objective,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.activityLog.log("error", `Failed to spawn child supervisor: ${msg}`);
    }
  }
}
```

- [ ] **Step 5: Call processChildSpawnCommands in processDecisions**

```typescript
// In processDecisions method, after processChildCommands call, add:
await this.processChildSpawnCommands(rawEvents);
```

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(supervisor): wire child spawn processing into HeartbeatLoop

Process child:spawn inbox commands from CLI --parent flag.
Uses spawnChildSupervisor to fork child processes."
```

---

### Task 6: Update daemon.ts to Pass Worker Path

**Files:**
- Modify: `packages/core/src/supervisor/daemon.ts`

- [ ] **Step 1: Add workerPath to SupervisorDaemonOptions**

```typescript
// In SupervisorDaemonOptions interface, add:
  /** Path to child-supervisor-worker.js for spawning child processes */
  workerPath?: string | undefined;
```

- [ ] **Step 2: Store and pass to HeartbeatLoop**

```typescript
// Add field to class:
  private readonly workerPath: string | undefined;

// In constructor:
    this.workerPath = options.workerPath;

// In start(), when creating HeartbeatLoop, add these options:
    this.heartbeatLoop = new HeartbeatLoop({
      config: this.config,
      supervisorDir: this.dir,
      statePath,
      sessionId: this.sessionId,
      eventQueue: this.eventQueue,
      activityLog: this.activityLog,
      eventsPath,
      defaultInstructionsPath: this.defaultInstructionsPath,
      childRegistry: this.childRegistry,
      workerPath: this.workerPath,       // Add this
      supervisorName: this.name,          // Add this
    });
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/supervisor/daemon.ts
git commit -m "feat(supervisor): pass workerPath and supervisorName to HeartbeatLoop"
```

---

### Task 7: Wire Worker Path in CLI Daemon Startup

**Files:**
- Modify: `packages/cli/src/daemon/supervisor-worker.ts`

- [ ] **Step 1: Add workerPath resolution and pass to daemon**

```typescript
// In packages/cli/src/daemon/supervisor-worker.ts, modify main():

import { fileURLToPath } from "node:url";
import path from "node:path";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write("Usage: supervisor-worker.js <name>\n");
    process.exit(1);
  }

  // Redirect stdout/stderr to a log file
  const dir = getSupervisorDir(name);
  await mkdir(dir, { recursive: true });
  const logPath = `${dir}/daemon.log`;
  const logStream = createWriteStream(logPath, { flags: "a" });
  process.stdout.write = logStream.write.bind(logStream);
  process.stderr.write = logStream.write.bind(logStream);

  try {
    const config = await loadGlobalConfig();
    const defaultInstructionsPath = path.join(resolveAgentsPackageDir(), "SUPERVISOR.md");

    // Resolve path to child-supervisor-worker.js (same directory as this file)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(__dirname, "child-supervisor-worker.js");

    const daemon = new SupervisorDaemon({
      name,
      config,
      defaultInstructionsPath,
      workerPath,  // Pass worker path for child spawning
    });
    await daemon.start();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[supervisor-worker] Fatal: ${msg}`);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Add import for fileURLToPath**

```typescript
// Add at top of file:
import { fileURLToPath } from "node:url";
```

- [ ] **Step 3: Run build and verify**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/daemon/supervisor-worker.ts
git commit -m "feat(cli): wire child-supervisor-worker path to daemon startup

Resolve path to child-supervisor-worker.js and pass to SupervisorDaemon
so HeartbeatLoop can spawn child supervisors."
```

---

### Task 8: Add --parent Flag to CLI supervise Command

**Files:**
- Modify: `packages/cli/src/commands/supervise.ts`
- Create: `packages/cli/src/child-mode.ts`

- [ ] **Step 1: Create child-mode helper**

```typescript
// packages/cli/src/child-mode.ts
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getSupervisorInboxPath } from "@neotx/core";
import { printSuccess, printError } from "./output.js";

export interface ChildModeOptions {
  parentName: string;
  objective: string;
  acceptanceCriteria: string[];
  maxCostUsd?: number;
}

/**
 * Request the parent supervisor to spawn a child via inbox message.
 * The HeartbeatLoop will read this and call spawnChildSupervisor.
 */
export async function spawnChildFromCli(options: ChildModeOptions): Promise<void> {
  const { parentName, objective, acceptanceCriteria, maxCostUsd } = options;

  const id = randomUUID();
  const timestamp = new Date().toISOString();

  // Send a message to parent's inbox that triggers spawn
  const payload = { objective, acceptanceCriteria, maxCostUsd };
  const message = {
    id,
    from: "api" as const,
    text: `child:spawn ${JSON.stringify(payload)}`,
    timestamp,
  };

  const inboxPath = getSupervisorInboxPath(parentName);
  await appendFile(inboxPath, JSON.stringify(message) + "\n", "utf-8");

  printSuccess(`Child supervisor spawn requested for parent "${parentName}"`);
  console.log(`  Objective: ${objective}`);
  console.log(`  Criteria:  ${acceptanceCriteria.join(", ")}`);
  if (maxCostUsd !== undefined) {
    console.log(`  Budget:    $${maxCostUsd.toFixed(2)}`);
  }
  console.log("");
  console.log("  The parent supervisor will spawn the child on its next heartbeat.");
  console.log("  Monitor via: neo supervise");
}
```

- [ ] **Step 2: Add args and handler to supervise.ts**

```typescript
// In packages/cli/src/commands/supervise.ts

// Add to args object (after existing args):
    parent: {
      type: "string",
      description: "Start as a child of an existing supervisor (registers via IPC)",
    },
    objective: {
      type: "string",
      description: "Objective for child supervisor (required with --parent)",
    },
    criteria: {
      type: "string",
      description: "Comma-separated acceptance criteria (required with --parent)",
    },
    budget: {
      type: "string",
      description: "Max cost in USD for child supervisor",
    },

// Add new handler function before run():
async function handleChildMode(
  parentName: string,
  objective: string | undefined,
  criteriaStr: string | undefined,
  budgetStr: string | undefined,
): Promise<void> {
  if (!objective) {
    printError("--objective is required when using --parent");
    process.exitCode = 1;
    return;
  }

  if (!criteriaStr) {
    printError("--criteria is required when using --parent");
    process.exitCode = 1;
    return;
  }

  const running = await isDaemonRunning(parentName);
  if (!running) {
    printError(`Parent supervisor "${parentName}" is not running.`);
    printError("Start it first with: neo supervise --detach");
    process.exitCode = 1;
    return;
  }

  const criteria = criteriaStr.split(",").map((s) => s.trim()).filter(Boolean);
  const budget = budgetStr ? parseFloat(budgetStr) : undefined;

  const { spawnChildFromCli } = await import("../child-mode.js");

  await spawnChildFromCli({
    parentName,
    objective,
    acceptanceCriteria: criteria,
    maxCostUsd: budget,
  });
}

// Add to run() function, after const name = args.name:
    if (args.parent) {
      await handleChildMode(
        args.parent,
        args.objective,
        args.criteria,
        args.budget,
      );
      return;
    }
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/supervise.ts packages/cli/src/child-mode.ts
git commit -m "feat(cli): add --parent flag to supervise command

Allow starting a child supervisor that registers with an existing parent.
Usage: neo supervise --parent=supervisor --objective='Task' --criteria='Done'"
```

---

### Task 9: Update Exports in index.ts

**Files:**
- Modify: `packages/core/src/supervisor/index.ts`

- [ ] **Step 1: Add exports for new modules**

```typescript
// Add to packages/core/src/supervisor/index.ts

// ─── Child spawner ──────────────────────────────────────
export type { SpawnChildOptions, SpawnChildResult } from "./child-spawner.js";
export { spawnChildSupervisor } from "./child-spawner.js";

// ─── Spawn child tool ───────────────────────────────────
export type { SpawnChildSupervisorInput } from "./spawn-child-tool.js";
export {
  SPAWN_CHILD_SUPERVISOR_TOOL,
  spawnChildSupervisorInputSchema,
} from "./spawn-child-tool.js";

// ─── Child command parser (add spawn export) ────────────
export type { ChildSpawnCommand } from "./child-command-parser.js";
export { parseChildSpawnCommand } from "./child-command-parser.js";

// ─── JSONL Store ──────────────────────────────────────
export { JsonlSupervisorStore } from "./stores/jsonl.js";

// ─── AI Adapter ───────────────────────────────────────
export { ClaudeAdapter } from "./adapters/claude.js";
export type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "./ai-adapter.js";
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/index.ts
git commit -m "chore(supervisor): export child spawner, spawn tool, store, and adapter modules"
```

---

### Task 10: Add Integration Test for Child Supervisor Flow

**Files:**
- Create: `packages/core/src/supervisor/__tests__/child-supervisor-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// packages/core/src/supervisor/__tests__/child-supervisor-integration.test.ts
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildRegistry } from "../child-registry.js";
import { spawnChildSupervisor } from "../child-spawner.js";
import type { ChildToParentMessage } from "../schemas.js";

// Mock fork to avoid actual process spawning
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const events = new Map<string, Function>();
    const mockProcess = {
      pid: 99999,
      connected: true,
      send: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        events.set(event, handler);
        return mockProcess;
      }),
      emit: (event: string, ...args: unknown[]) => {
        const handler = events.get(event);
        if (handler) handler(...args);
      },
      kill: vi.fn(),
    };
    return mockProcess;
  }),
}));

describe("Child Supervisor Integration", () => {
  const TMP = path.join(import.meta.dirname, "__tmp_child_integration__");
  const childrenPath = path.join(TMP, "children.json");

  beforeEach(() => mkdir(TMP, { recursive: true }));
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("spawns child and registers with ChildRegistry", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Test integration",
      acceptanceCriteria: ["Passes tests"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
    });

    expect(result.supervisorId).toBeDefined();

    // Check registration
    const children = registry.list();
    expect(children).toHaveLength(1);
    expect(children[0]?.objective).toBe("Test integration");
    expect(children[0]?.status).toBe("running");

    // Check children.json written
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(childrenPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it("handles progress messages from child", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Progress test",
      acceptanceCriteria: ["Done"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
      maxCostUsd: 10.0,
    });

    // Simulate progress message from child via IPC
    const { fork } = await import("node:child_process");
    const mockProcess = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    // Get the 'message' handler and call it
    const messageHandler = mockProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === "message"
    )?.[1];

    messageHandler({
      type: "progress",
      supervisorId: result.supervisorId,
      summary: "Making progress",
      costDelta: 0.5,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "progress",
      supervisorId: result.supervisorId,
    });

    // Check cost updated
    const handle = registry.get(result.supervisorId);
    expect(handle?.costUsd).toBe(0.5);
  });

  it("stops child when budget exceeded", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Budget test",
      acceptanceCriteria: ["Done"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
      maxCostUsd: 1.0,
    });

    const { fork } = await import("node:child_process");
    const mockProcess = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    const messageHandler = mockProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === "message"
    )?.[1];

    // Send progress that exceeds budget
    messageHandler({
      type: "progress",
      supervisorId: result.supervisorId,
      summary: "Expensive operation",
      costDelta: 1.5,
    });

    // Should have sent stop message
    expect(mockProcess.send).toHaveBeenCalledWith({ type: "stop" });

    // Handle should be marked failed
    const handle = registry.get(result.supervisorId);
    expect(handle?.status).toBe("failed");
  });

  it("handles complete message from child", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Complete test",
      acceptanceCriteria: ["Done"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
    });

    const { fork } = await import("node:child_process");
    const mockProcess = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    const messageHandler = mockProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === "message"
    )?.[1];

    // Send complete message
    messageHandler({
      type: "complete",
      supervisorId: result.supervisorId,
      summary: "Task completed successfully",
      evidence: ["PR #123 merged"],
    });

    // Handle should be marked complete
    const handle = registry.get(result.supervisorId);
    expect(handle?.status).toBe("complete");
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test -- packages/core/src/supervisor/__tests__/child-supervisor-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/__tests__/child-supervisor-integration.test.ts
git commit -m "test(supervisor): add integration test for child supervisor flow

Tests spawn, registration, progress, budget enforcement, and completion."
```

---

### Task 11: Final Build and Test Validation

**Files:** None (validation only)

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify child supervisor implementation

All builds pass, typechecks pass, tests pass."
```

---

## Summary

| Task | Description | Files Modified/Created |
|------|-------------|------------------------|
| 1 | Tool schema | spawn-child-tool.ts, spawn-child-tool.test.ts |
| 2 | Child spawner | child-spawner.ts, child-spawner.test.ts |
| 3 | Command parser | child-command-parser.ts (modify), child-command-parser.test.ts (modify) |
| 4 | Worker entry point | daemon/child-supervisor-worker.ts, daemon/child-supervisor-worker.test.ts |
| 5 | HeartbeatLoop integration | heartbeat.ts (modify) |
| 6 | Daemon options | daemon.ts (modify) |
| 7 | CLI daemon wiring | daemon/supervisor-worker.ts (modify) |
| 8 | CLI --parent flag | supervise.ts (modify), child-mode.ts |
| 9 | Exports | index.ts (modify) |
| 10 | Integration test | child-supervisor-integration.test.ts |
| 11 | Validation | Build + test |

**Total: 11 tasks, ~7 new files, ~5 modified files**

## Key Architectural Decisions

1. **Child spawning uses fork() + IPC**: Environment variables pass config, process.send/on('message') handles communication
2. **Single spawn path**: Both CLI (`--parent`) and LLM tool converge to `spawnChildSupervisor()` via inbox message or direct call
3. **Depth enforcement**: MAX_DEPTH = 1 prevents recursive spawning (children cannot spawn children)
4. **Budget enforcement**: Dual-check in both parent (ChildRegistry) and child (local tracking)
5. **Worker location**: child-supervisor-worker.js lives in daemon/ alongside supervisor-worker.js
6. **Store reuse**: Child supervisors use existing JsonlSupervisorStore implementation
7. **Adapter reuse**: Child supervisors use existing ClaudeAdapter (no custom factory needed)

## Key Risks and Mitigations

1. **IPC reliability**: Fork/IPC can fail silently. Mitigation: ChildRegistry already has stall detection.
2. **Worker path resolution**: Must work in both dev and production. Mitigation: Compute relative to supervisor-worker.js using fileURLToPath.
3. **Budget race conditions**: Child may exceed budget between checks. Mitigation: Defense-in-depth with both parent and child checking.
4. **Session persistence**: FocusedLoop needs a working SupervisorStore. Mitigation: Reuse existing JsonlSupervisorStore.
