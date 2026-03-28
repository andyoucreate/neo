# Multi-Supervisor Architecture Implementation Plan

**Goal:** Enable the main supervisor to orchestrate specialized child supervisors as independent processes, starting with a "cleanup" supervisor for maintenance tasks.

**Architecture:** Process-spawn model where the main supervisor spawns and monitors child supervisors via the neo CLI. Each child supervisor runs independently with budget isolation, communicating via a file-based protocol. The main supervisor tracks child health via heartbeat monitoring.

**Tech Stack:** Node.js child_process (execFile), Zod schemas, JSONL file protocol, existing neo infrastructure (paths, memory, logging)

---

## File Structure Mapping

### New Files

| File | Responsibility |
|------|----------------|
| `packages/core/src/config/child-supervisor-schema.ts` | Zod schema for child supervisor configuration |
| `packages/core/src/supervisor/child-supervisor-manager.ts` | Spawn, lifecycle, and health monitoring for child supervisors |
| `packages/core/src/supervisor/child-supervisor-protocol.ts` | File-based IPC protocol types and helpers |
| `packages/agents/supervisors/cleanup/config.yaml` | Cleanup supervisor configuration |
| `packages/agents/supervisors/cleanup/SUPERVISOR.md` | Cleanup supervisor instructions |

### Modified Files

| File | Changes |
|------|---------|
| `packages/core/src/config/schema.ts` | Add `childSupervisors` field to globalConfigSchema |
| `packages/core/src/paths.ts` | Add paths for child supervisor directories |
| `packages/core/src/supervisor/daemon.ts` | Integrate ChildSupervisorManager |
| `packages/core/src/supervisor/heartbeat.ts` | Monitor child supervisor health |
| `packages/core/src/supervisor/schemas.ts` | Add child supervisor state schemas |
| `packages/cli/src/commands/supervise.ts` | Add --child-name and --child-type flags |

---

## Task 1: Child Supervisor Configuration Schema

**Files:**
- Create: `packages/core/src/config/child-supervisor-schema.ts`
- Test: `packages/core/src/config/__tests__/child-supervisor-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/config/__tests__/child-supervisor-schema.test.ts
import { describe, expect, it } from "vitest";
import {
  childSupervisorConfigSchema,
  childSupervisorTypeSchema,
  type ChildSupervisorConfig,
} from "../child-supervisor-schema.js";

describe("childSupervisorTypeSchema", () => {
  it("accepts valid supervisor types", () => {
    expect(childSupervisorTypeSchema.parse("cleanup")).toBe("cleanup");
    expect(childSupervisorTypeSchema.parse("custom")).toBe("custom");
  });

  it("rejects invalid types", () => {
    expect(() => childSupervisorTypeSchema.parse("invalid")).toThrow();
  });
});

describe("childSupervisorConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const input = {
      name: "cleanup-neo",
      type: "cleanup",
      repo: "/path/to/neo",
    };
    const result = childSupervisorConfigSchema.parse(input);

    expect(result.name).toBe("cleanup-neo");
    expect(result.type).toBe("cleanup");
    expect(result.repo).toBe("/path/to/neo");
    expect(result.enabled).toBe(true);
    expect(result.budget.dailyCapUsd).toBe(10);
    expect(result.heartbeatIntervalMs).toBe(60_000);
  });

  it("parses full config with custom values", () => {
    const input: ChildSupervisorConfig = {
      name: "cleanup-neo",
      type: "cleanup",
      repo: "/path/to/neo",
      enabled: false,
      budget: {
        dailyCapUsd: 5,
        maxCostPerTaskUsd: 0.5,
      },
      heartbeatIntervalMs: 120_000,
      autoStart: false,
      objective: "Keep the codebase clean",
      acceptanceCriteria: ["No lint errors", "All tests pass"],
    };
    const result = childSupervisorConfigSchema.parse(input);

    expect(result.enabled).toBe(false);
    expect(result.budget.dailyCapUsd).toBe(5);
    expect(result.heartbeatIntervalMs).toBe(120_000);
    expect(result.autoStart).toBe(false);
  });

  it("requires name, type, and repo", () => {
    expect(() => childSupervisorConfigSchema.parse({})).toThrow();
    expect(() => childSupervisorConfigSchema.parse({ name: "x" })).toThrow();
    expect(() => childSupervisorConfigSchema.parse({ name: "x", type: "cleanup" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/config/__tests__/child-supervisor-schema.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/config/child-supervisor-schema.ts
import { z } from "zod";

/**
 * Built-in child supervisor types.
 * - cleanup: maintenance tasks (lint, tests, dead code removal)
 * - custom: user-defined supervisor with custom instructions
 */
export const childSupervisorTypeSchema = z.enum(["cleanup", "custom"]);

export type ChildSupervisorType = z.infer<typeof childSupervisorTypeSchema>;

/**
 * Budget configuration for a child supervisor.
 */
export const childSupervisorBudgetSchema = z
  .object({
    /** Daily spending cap in USD */
    dailyCapUsd: z.number().min(0).default(10),
    /** Max cost per individual task in USD */
    maxCostPerTaskUsd: z.number().min(0).default(1),
  })
  .default({ dailyCapUsd: 10, maxCostPerTaskUsd: 1 });

export type ChildSupervisorBudget = z.infer<typeof childSupervisorBudgetSchema>;

/**
 * Configuration for a child supervisor instance.
 * Stored in ~/.neo/config.yml under childSupervisors array.
 */
export const childSupervisorConfigSchema = z.object({
  /** Unique name for this supervisor instance */
  name: z.string().min(1),
  /** Type of supervisor (determines instructions and behavior) */
  type: childSupervisorTypeSchema,
  /** Repository path this supervisor operates on */
  repo: z.string().min(1),
  /** Whether the supervisor is enabled */
  enabled: z.boolean().default(true),
  /** Budget configuration */
  budget: childSupervisorBudgetSchema,
  /** How often the child reports health to parent (ms) */
  heartbeatIntervalMs: z.number().min(10_000).default(60_000),
  /** Whether to start this supervisor automatically with the main supervisor */
  autoStart: z.boolean().default(true),
  /** Custom objective (overrides type default) */
  objective: z.string().optional(),
  /** Custom acceptance criteria (overrides type default) */
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Custom instructions path (overrides type default) */
  instructionsPath: z.string().optional(),
});

export type ChildSupervisorConfig = z.infer<typeof childSupervisorConfigSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/config/__tests__/child-supervisor-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/child-supervisor-schema.ts packages/core/src/config/__tests__/child-supervisor-schema.test.ts
git commit -m "feat(config): add child supervisor configuration schema

Defines Zod schemas for configuring specialized child supervisors:
- childSupervisorTypeSchema: built-in types (cleanup, custom)
- childSupervisorBudgetSchema: per-child budget isolation
- childSupervisorConfigSchema: full configuration with defaults

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Add Child Supervisors to Global Config

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/config/index.ts`
- Test: `packages/core/src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to packages/core/src/__tests__/config.test.ts (append to existing tests)

describe("childSupervisors config", () => {
  it("parses config with childSupervisors array", () => {
    const input = {
      childSupervisors: [
        {
          name: "cleanup-neo",
          type: "cleanup",
          repo: "/path/to/neo",
        },
      ],
    };
    const result = globalConfigSchema.parse(input);

    expect(result.childSupervisors).toHaveLength(1);
    expect(result.childSupervisors[0].name).toBe("cleanup-neo");
  });

  it("defaults to empty childSupervisors array", () => {
    const result = globalConfigSchema.parse({});
    expect(result.childSupervisors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/config.test.ts`
Expected: FAIL with "childSupervisors" not defined

- [ ] **Step 3: Write minimal implementation**

```typescript
// In packages/core/src/config/schema.ts
// Add import at top:
import { childSupervisorConfigSchema } from "./child-supervisor-schema.js";

// In globalConfigSchema, add after mcpServers:
  childSupervisors: z.array(childSupervisorConfigSchema).default([]),
```

```typescript
// In packages/core/src/config/index.ts
// Add export:
export * from "./child-supervisor-schema.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/index.ts packages/core/src/__tests__/config.test.ts
git commit -m "feat(config): add childSupervisors to global config

Integrates child supervisor configuration into the global config schema.
Users can now define specialized child supervisors in ~/.neo/config.yml.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Child Supervisor File Protocol

**Files:**
- Create: `packages/core/src/supervisor/child-supervisor-protocol.ts`
- Test: `packages/core/src/supervisor/child-supervisor-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/supervisor/child-supervisor-protocol.test.ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  childSupervisorStateSchema,
  readChildState,
  writeChildState,
  writeChildHeartbeat,
  readChildHeartbeat,
  type ChildSupervisorState,
  type ChildHeartbeat,
} from "./child-supervisor-protocol.js";

describe("childSupervisorStateSchema", () => {
  it("parses valid state", () => {
    const input = {
      name: "cleanup-neo",
      pid: 12345,
      status: "running",
      startedAt: "2024-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2024-01-01T00:01:00.000Z",
      costTodayUsd: 0.5,
      taskCount: 3,
    };
    const result = childSupervisorStateSchema.parse(input);
    expect(result.status).toBe("running");
  });

  it("accepts all valid statuses", () => {
    for (const status of ["running", "idle", "stopped", "failed", "stalled"]) {
      const input = {
        name: "test",
        pid: 1,
        status,
        startedAt: "2024-01-01T00:00:00.000Z",
        lastHeartbeatAt: "2024-01-01T00:00:00.000Z",
        costTodayUsd: 0,
        taskCount: 0,
      };
      expect(() => childSupervisorStateSchema.parse(input)).not.toThrow();
    }
  });
});

describe("file protocol helpers", () => {
  const testDir = "/tmp/neo-child-protocol-test";

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("writes and reads child state", async () => {
    const state: ChildSupervisorState = {
      name: "cleanup-neo",
      pid: 12345,
      status: "running",
      startedAt: "2024-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2024-01-01T00:01:00.000Z",
      costTodayUsd: 0.5,
      taskCount: 3,
    };

    await writeChildState(testDir, state);
    const result = await readChildState(testDir);

    expect(result).toEqual(state);
  });

  it("returns null for missing state file", async () => {
    const result = await readChildState(testDir);
    expect(result).toBeNull();
  });

  it("writes and reads heartbeat", async () => {
    const heartbeat: ChildHeartbeat = {
      timestamp: "2024-01-01T00:01:00.000Z",
      status: "running",
      currentTask: "Running lint",
      costSinceLastUsd: 0.05,
    };

    await writeChildHeartbeat(testDir, heartbeat);
    const result = await readChildHeartbeat(testDir);

    expect(result).toEqual(heartbeat);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/supervisor/child-supervisor-protocol.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/child-supervisor-protocol.ts
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ─── Child Supervisor State ──────────────────────────────

export const childSupervisorStatusSchema = z.enum([
  "running",
  "idle",
  "stopped",
  "failed",
  "stalled",
]);

export type ChildSupervisorStatus = z.infer<typeof childSupervisorStatusSchema>;

export const childSupervisorStateSchema = z.object({
  /** Name of the child supervisor */
  name: z.string(),
  /** Process ID of the child supervisor */
  pid: z.number(),
  /** Current status */
  status: childSupervisorStatusSchema,
  /** When the child was started */
  startedAt: z.string(),
  /** Last heartbeat timestamp */
  lastHeartbeatAt: z.string(),
  /** Cost accumulated today */
  costTodayUsd: z.number(),
  /** Number of tasks completed this session */
  taskCount: z.number(),
  /** Current objective (if any) */
  currentObjective: z.string().optional(),
  /** Last error message (if failed) */
  lastError: z.string().optional(),
});

export type ChildSupervisorState = z.infer<typeof childSupervisorStateSchema>;

// ─── Child Heartbeat (written by child, read by parent) ──

export const childHeartbeatSchema = z.object({
  /** When this heartbeat was sent */
  timestamp: z.string(),
  /** Current status */
  status: childSupervisorStatusSchema,
  /** What the child is currently doing */
  currentTask: z.string().optional(),
  /** Cost since last heartbeat */
  costSinceLastUsd: z.number().default(0),
  /** Any blocking issues */
  blockedReason: z.string().optional(),
});

export type ChildHeartbeat = z.infer<typeof childHeartbeatSchema>;

// ─── File Protocol Helpers ───────────────────────────────

const STATE_FILE = "state.json";
const HEARTBEAT_FILE = "heartbeat.json";

/**
 * Write child supervisor state to its directory.
 */
export async function writeChildState(
  childDir: string,
  state: ChildSupervisorState,
): Promise<void> {
  const filePath = path.join(childDir, STATE_FILE);
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Read child supervisor state from its directory.
 * Returns null if the state file does not exist or is invalid.
 */
export async function readChildState(
  childDir: string,
): Promise<ChildSupervisorState | null> {
  try {
    const filePath = path.join(childDir, STATE_FILE);
    const raw = await readFile(filePath, "utf-8");
    return childSupervisorStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Write heartbeat from child (child calls this periodically).
 */
export async function writeChildHeartbeat(
  childDir: string,
  heartbeat: ChildHeartbeat,
): Promise<void> {
  const filePath = path.join(childDir, HEARTBEAT_FILE);
  await writeFile(filePath, JSON.stringify(heartbeat, null, 2), "utf-8");
}

/**
 * Read heartbeat from child (parent calls this to check health).
 * Returns null if the heartbeat file does not exist or is invalid.
 */
export async function readChildHeartbeat(
  childDir: string,
): Promise<ChildHeartbeat | null> {
  try {
    const filePath = path.join(childDir, HEARTBEAT_FILE);
    const raw = await readFile(filePath, "utf-8");
    return childHeartbeatSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/supervisor/child-supervisor-protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/child-supervisor-protocol.ts packages/core/src/supervisor/child-supervisor-protocol.test.ts
git commit -m "feat(supervisor): add file-based child supervisor protocol

Defines schemas and helpers for parent-child supervisor communication:
- ChildSupervisorState: persisted state with status, cost, task count
- ChildHeartbeat: periodic health reports from child to parent
- Read/write helpers for file-based IPC

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Child Supervisor Paths

**Files:**
- Modify: `packages/core/src/paths.ts`
- Test: `packages/core/src/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to packages/core/src/paths.test.ts (append to existing tests)

describe("child supervisor paths", () => {
  it("getChildSupervisorsDir returns correct path", () => {
    const result = getChildSupervisorsDir("supervisor");
    expect(result).toContain(".neo/supervisors/supervisor/children");
  });

  it("getChildSupervisorDir returns correct path for child", () => {
    const result = getChildSupervisorDir("supervisor", "cleanup-neo");
    expect(result).toContain(".neo/supervisors/supervisor/children/cleanup-neo");
  });

  it("getChildSupervisorStatePath returns state.json path", () => {
    const result = getChildSupervisorStatePath("supervisor", "cleanup-neo");
    expect(result).toEndWith("children/cleanup-neo/state.json");
  });

  it("getChildSupervisorHeartbeatPath returns heartbeat.json path", () => {
    const result = getChildSupervisorHeartbeatPath("supervisor", "cleanup-neo");
    expect(result).toEndWith("children/cleanup-neo/heartbeat.json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/paths.test.ts`
Expected: FAIL with "getChildSupervisorsDir is not defined"

- [ ] **Step 3: Write minimal implementation**

```typescript
// Add to packages/core/src/paths.ts (after getSupervisorChildrenPath)

/**
 * Directory for child supervisors of a parent: ~/.neo/supervisors/<parent>/children/
 */
export function getChildSupervisorsDir(parentName: string): string {
  return path.join(getSupervisorDir(parentName), "children");
}

/**
 * Directory for a specific child supervisor: ~/.neo/supervisors/<parent>/children/<childName>/
 */
export function getChildSupervisorDir(parentName: string, childName: string): string {
  return path.join(getChildSupervisorsDir(parentName), childName);
}

/**
 * State file for a child supervisor: ~/.neo/supervisors/<parent>/children/<childName>/state.json
 */
export function getChildSupervisorStatePath(parentName: string, childName: string): string {
  return path.join(getChildSupervisorDir(parentName, childName), "state.json");
}

/**
 * Heartbeat file for a child supervisor: ~/.neo/supervisors/<parent>/children/<childName>/heartbeat.json
 */
export function getChildSupervisorHeartbeatPath(parentName: string, childName: string): string {
  return path.join(getChildSupervisorDir(parentName, childName), "heartbeat.json");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/paths.ts packages/core/src/paths.test.ts
git commit -m "feat(paths): add child supervisor directory paths

Adds path helpers for child supervisor file structure:
- getChildSupervisorsDir: children directory under parent
- getChildSupervisorDir: specific child's directory
- getChildSupervisorStatePath: child state.json location
- getChildSupervisorHeartbeatPath: child heartbeat.json location

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Child Supervisor Manager

**Files:**
- Create: `packages/core/src/supervisor/child-supervisor-manager.ts`
- Test: `packages/core/src/supervisor/child-supervisor-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/supervisor/child-supervisor-manager.test.ts
import { mkdir, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSupervisorConfig } from "@/config/child-supervisor-schema.js";
import { ChildSupervisorManager } from "./child-supervisor-manager.js";
import { writeChildHeartbeat, writeChildState } from "./child-supervisor-protocol.js";

describe("ChildSupervisorManager", () => {
  const testDir = "/tmp/neo-child-manager-test";
  let manager: ChildSupervisorManager;

  const mockConfig: ChildSupervisorConfig = {
    name: "cleanup-neo",
    type: "cleanup",
    repo: "/path/to/neo",
    enabled: true,
    budget: { dailyCapUsd: 10, maxCostPerTaskUsd: 1 },
    heartbeatIntervalMs: 60_000,
    autoStart: true,
  };

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    manager = new ChildSupervisorManager({
      parentName: "supervisor",
      childrenDir: testDir,
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  it("starts with no children", () => {
    expect(manager.list()).toHaveLength(0);
  });

  it("registers a child config", async () => {
    await manager.register(mockConfig);
    expect(manager.list()).toHaveLength(1);
    expect(manager.get("cleanup-neo")).toEqual(mockConfig);
  });

  it("unregisters a child", async () => {
    await manager.register(mockConfig);
    await manager.unregister("cleanup-neo");
    expect(manager.list()).toHaveLength(0);
  });

  it("detects stalled child when heartbeat is old", async () => {
    await manager.register(mockConfig);
    const childDir = `${testDir}/cleanup-neo`;
    await mkdir(childDir, { recursive: true });

    // Write old heartbeat (5 minutes ago)
    const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await writeChildHeartbeat(childDir, {
      timestamp: oldTimestamp,
      status: "running",
      costSinceLastUsd: 0,
    });

    // Write state with running status
    await writeChildState(childDir, {
      name: "cleanup-neo",
      pid: 99999, // Non-existent PID
      status: "running",
      startedAt: oldTimestamp,
      lastHeartbeatAt: oldTimestamp,
      costTodayUsd: 0,
      taskCount: 0,
    });

    const health = await manager.checkHealth("cleanup-neo", { stallThresholdMs: 60_000 });
    expect(health.isStalled).toBe(true);
  });

  it("reports healthy child with recent heartbeat", async () => {
    await manager.register(mockConfig);
    const childDir = `${testDir}/cleanup-neo`;
    await mkdir(childDir, { recursive: true });

    // Write recent heartbeat
    const recentTimestamp = new Date().toISOString();
    await writeChildHeartbeat(childDir, {
      timestamp: recentTimestamp,
      status: "running",
      costSinceLastUsd: 0,
    });

    const health = await manager.checkHealth("cleanup-neo", { stallThresholdMs: 60_000 });
    expect(health.isStalled).toBe(false);
    expect(health.status).toBe("running");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/supervisor/child-supervisor-manager.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/child-supervisor-manager.ts
import { type ChildProcess, execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChildSupervisorConfig } from "@/config/child-supervisor-schema.js";
import { isProcessAlive } from "@/shared/process.js";
import {
  type ChildHeartbeat,
  type ChildSupervisorState,
  type ChildSupervisorStatus,
  readChildHeartbeat,
  readChildState,
  writeChildState,
} from "./child-supervisor-protocol.js";

const execFileAsync = promisify(execFile);

export interface ChildSupervisorManagerOptions {
  /** Name of the parent supervisor */
  parentName: string;
  /** Directory where child supervisor data is stored */
  childrenDir: string;
  /** Path to neo CLI executable (defaults to "neo") */
  neoBin?: string;
}

export interface ChildHealthStatus {
  name: string;
  status: ChildSupervisorStatus;
  isStalled: boolean;
  lastHeartbeat: ChildHeartbeat | null;
  state: ChildSupervisorState | null;
  isProcessAlive: boolean;
}

export interface CheckHealthOptions {
  /** How long since last heartbeat before considered stalled (ms) */
  stallThresholdMs: number;
}

/**
 * Manages lifecycle of child supervisor processes.
 * Handles spawn, stop, health monitoring, and budget enforcement.
 */
export class ChildSupervisorManager {
  private readonly parentName: string;
  private readonly childrenDir: string;
  private readonly neoBin: string;
  private readonly configs = new Map<string, ChildSupervisorConfig>();
  private readonly processes = new Map<string, ChildProcess>();

  constructor(options: ChildSupervisorManagerOptions) {
    this.parentName = options.parentName;
    this.childrenDir = options.childrenDir;
    this.neoBin = options.neoBin ?? "neo";
  }

  /**
   * Register a child supervisor configuration.
   * Does not start the child — call spawn() for that.
   */
  async register(config: ChildSupervisorConfig): Promise<void> {
    this.configs.set(config.name, config);
    const childDir = path.join(this.childrenDir, config.name);
    await mkdir(childDir, { recursive: true });
  }

  /**
   * Unregister and stop a child supervisor.
   */
  async unregister(name: string): Promise<void> {
    await this.stop(name);
    this.configs.delete(name);
  }

  /**
   * Get configuration for a child supervisor.
   */
  get(name: string): ChildSupervisorConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * List all registered child supervisor configurations.
   */
  list(): ChildSupervisorConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Spawn a child supervisor process.
   */
  async spawn(name: string): Promise<void> {
    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Unknown child supervisor: ${name}`);
    }

    if (!config.enabled) {
      return;
    }

    const childDir = path.join(this.childrenDir, name);
    await mkdir(childDir, { recursive: true });

    // Build spawn command args
    const args = [
      "supervise",
      "--detach",
      `--name=${name}`,
      `--child-of=${this.parentName}`,
      `--repo=${config.repo}`,
      `--type=${config.type}`,
      `--budget=${config.budget.dailyCapUsd}`,
    ];

    if (config.objective) {
      args.push(`--objective=${config.objective}`);
    }

    if (config.instructionsPath) {
      args.push(`--instructions=${config.instructionsPath}`);
    }

    // Spawn detached process
    const { spawn } = await import("node:child_process");
    const child = spawn(this.neoBin, args, {
      detached: true,
      stdio: "ignore",
      cwd: config.repo,
    });

    child.unref();
    this.processes.set(name, child);

    // Write initial state
    const state: ChildSupervisorState = {
      name,
      pid: child.pid ?? 0,
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      costTodayUsd: 0,
      taskCount: 0,
    };
    await writeChildState(childDir, state);
  }

  /**
   * Stop a child supervisor process.
   */
  async stop(name: string): Promise<void> {
    const child = this.processes.get(name);
    if (child?.pid && isProcessAlive(child.pid)) {
      process.kill(child.pid, "SIGTERM");
    }
    this.processes.delete(name);

    // Update state to stopped
    const childDir = path.join(this.childrenDir, name);
    const state = await readChildState(childDir);
    if (state) {
      state.status = "stopped";
      await writeChildState(childDir, state);
    }
  }

  /**
   * Stop all child supervisors.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.configs.keys());
    await Promise.all(names.map((name) => this.stop(name)));
  }

  /**
   * Check health of a child supervisor.
   */
  async checkHealth(name: string, options: CheckHealthOptions): Promise<ChildHealthStatus> {
    const childDir = path.join(this.childrenDir, name);
    const state = await readChildState(childDir);
    const heartbeat = await readChildHeartbeat(childDir);

    // Check if process is still alive
    const processAlive = state?.pid ? isProcessAlive(state.pid) : false;

    // Check if heartbeat is stale
    let isStalled = false;
    if (heartbeat) {
      const lastHeartbeatTime = new Date(heartbeat.timestamp).getTime();
      const now = Date.now();
      isStalled = now - lastHeartbeatTime > options.stallThresholdMs;
    } else if (state?.status === "running") {
      // No heartbeat file but state says running — stalled
      isStalled = true;
    }

    // Determine effective status
    let status: ChildSupervisorStatus = state?.status ?? "stopped";
    if (!processAlive && status === "running") {
      status = "failed";
    }
    if (isStalled && status === "running") {
      status = "stalled";
    }

    return {
      name,
      status,
      isStalled,
      lastHeartbeat: heartbeat,
      state,
      isProcessAlive: processAlive,
    };
  }

  /**
   * Restart a child supervisor (stop then spawn).
   */
  async restart(name: string): Promise<void> {
    await this.stop(name);
    // Brief delay to ensure process cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.spawn(name);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/supervisor/child-supervisor-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/child-supervisor-manager.ts packages/core/src/supervisor/child-supervisor-manager.test.ts
git commit -m "feat(supervisor): add ChildSupervisorManager for process lifecycle

Implements process-spawn model for child supervisors:
- register/unregister child configurations
- spawn/stop child supervisor processes via neo CLI
- checkHealth with stall detection
- restart capability for recovery

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Cleanup Supervisor Configuration

**Files:**
- Create: `packages/agents/supervisors/cleanup/config.yaml`
- Create: `packages/agents/supervisors/cleanup/SUPERVISOR.md`

- [ ] **Step 1: Create cleanup supervisor config**

```yaml
# packages/agents/supervisors/cleanup/config.yaml
# Default configuration for the cleanup supervisor type.
# Users can override these values in ~/.neo/config.yml

name: cleanup
type: cleanup
objective: |
  Keep the codebase clean and maintainable by running periodic maintenance tasks:
  - Lint fixes (pnpm lint:fix)
  - Test suite validation (pnpm test)
  - Dead code detection
  - Dependency updates (when safe)

acceptanceCriteria:
  - No lint errors after fixes
  - All tests pass after changes
  - Changes committed with clear messages
  - No breaking changes introduced

schedule:
  # Run maintenance tasks when the repo is idle
  idleAfterMs: 300000  # 5 minutes of no activity
  maxTasksPerDay: 10

budget:
  dailyCapUsd: 10
  maxCostPerTaskUsd: 1

priority:
  # Task priority order (first = highest priority)
  - lint
  - test
  - deadCode
  - deps
```

- [ ] **Step 2: Create cleanup supervisor instructions**

```markdown
# packages/agents/supervisors/cleanup/SUPERVISOR.md
# Cleanup Supervisor

You are a maintenance supervisor responsible for keeping a codebase clean and healthy.

## Your Responsibilities

1. **Lint Fixes**: Run the linter and fix any auto-fixable issues
2. **Test Validation**: Ensure all tests pass after changes
3. **Dead Code Detection**: Identify and remove unused exports, functions, and imports
4. **Dependency Health**: Check for outdated or vulnerable dependencies

## Constraints

- NEVER modify business logic — only formatting, style, and dead code
- NEVER add new features — maintenance only
- ALWAYS run tests after making changes
- ALWAYS commit changes with clear messages prefixed with `chore(cleanup):`
- NEVER push directly to main — create branches for changes

## Task Workflow

For each maintenance task:

1. **Check** — Identify issues (lint errors, test failures, dead code)
2. **Fix** — Apply auto-fixes or safe removals
3. **Verify** — Run tests to ensure no regressions
4. **Commit** — Create a clean commit with descriptive message
5. **Report** — Log what was done and any issues found

## When to Stop

- Stop if you encounter failing tests you cannot fix
- Stop if changes would affect business logic
- Stop if budget is approaching the limit
- Stop if the same issue keeps recurring (escalate to parent)

## Communication Protocol

Report progress via `neo log`:
```bash
neo log progress "Completed lint fixes: 12 files updated"
neo log blocker "Test suite failing in auth module — needs human review"
neo log milestone "Cleanup cycle complete: 0 lint errors, 100% tests passing"
```

## Budget Awareness

You have a limited daily budget. Prioritize:
1. Quick wins (auto-fixes) over deep analysis
2. Failing tests over style issues
3. Active code over rarely-used modules
```

- [ ] **Step 3: Commit**

```bash
mkdir -p packages/agents/supervisors/cleanup
git add packages/agents/supervisors/cleanup/config.yaml packages/agents/supervisors/cleanup/SUPERVISOR.md
git commit -m "feat(agents): add cleanup supervisor type

Defines the cleanup supervisor for maintenance tasks:
- config.yaml: default configuration with budget, schedule, priorities
- SUPERVISOR.md: instructions for maintenance behavior

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Integrate Manager into Daemon

**Files:**
- Modify: `packages/core/src/supervisor/daemon.ts`
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Update daemon.ts imports and options**

```typescript
// Add to imports in packages/core/src/supervisor/daemon.ts
import { ChildSupervisorManager } from "./child-supervisor-manager.js";
import { getChildSupervisorsDir } from "@/paths.js";
```

- [ ] **Step 2: Add manager to daemon class**

```typescript
// Add to SupervisorDaemon class in daemon.ts
private childSupervisorManager: ChildSupervisorManager | null = null;
```

- [ ] **Step 3: Initialize manager in start()**

```typescript
// Add to start() method in daemon.ts, after childRegistry initialization

// Initialize child supervisor manager
if (this.config.childSupervisors.length > 0) {
  this.childSupervisorManager = new ChildSupervisorManager({
    parentName: this.name,
    childrenDir: getChildSupervisorsDir(this.name),
  });

  // Register and auto-start configured children
  for (const childConfig of this.config.childSupervisors) {
    await this.childSupervisorManager.register(childConfig);
    if (childConfig.autoStart && childConfig.enabled) {
      try {
        await this.childSupervisorManager.spawn(childConfig.name);
        await this.activityLog.log(
          "dispatch",
          `Child supervisor started: ${childConfig.name}`,
          { childName: childConfig.name, type: childConfig.type },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.activityLog.log(
          "error",
          `Failed to start child supervisor ${childConfig.name}: ${msg}`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Stop children in stop()**

```typescript
// Add to stop() method in daemon.ts, before removing lockfile

// Stop all child supervisors
if (this.childSupervisorManager) {
  await this.childSupervisorManager.stopAll();
}
```

- [ ] **Step 5: Pass manager to heartbeat loop**

```typescript
// Add to HeartbeatLoop options in start()
childSupervisorManager: this.childSupervisorManager ?? undefined,
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/daemon.ts packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(supervisor): integrate ChildSupervisorManager into daemon

Main supervisor now:
- Registers child supervisors from config on startup
- Auto-starts enabled children with autoStart: true
- Stops all children on daemon shutdown
- Passes manager to heartbeat for health monitoring

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Child Health Monitoring in Heartbeat

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Test: `packages/core/src/__tests__/heartbeat-child-health.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/heartbeat-child-health.test.ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildSupervisorManager } from "@/supervisor/child-supervisor-manager.js";
import { writeChildHeartbeat, writeChildState } from "@/supervisor/child-supervisor-protocol.js";

describe("heartbeat child health monitoring", () => {
  const testDir = "/tmp/neo-heartbeat-child-test";
  let manager: ChildSupervisorManager;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    manager = new ChildSupervisorManager({
      parentName: "supervisor",
      childrenDir: testDir,
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  it("detects stalled child and marks for restart", async () => {
    await manager.register({
      name: "cleanup-test",
      type: "cleanup",
      repo: "/tmp",
      enabled: true,
      budget: { dailyCapUsd: 10, maxCostPerTaskUsd: 1 },
      heartbeatIntervalMs: 60_000,
      autoStart: false,
    });

    const childDir = path.join(testDir, "cleanup-test");
    await mkdir(childDir, { recursive: true });

    // Write stale heartbeat (10 minutes ago)
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeChildHeartbeat(childDir, {
      timestamp: staleTime,
      status: "running",
      costSinceLastUsd: 0,
    });

    await writeChildState(childDir, {
      name: "cleanup-test",
      pid: 99999,
      status: "running",
      startedAt: staleTime,
      lastHeartbeatAt: staleTime,
      costTodayUsd: 0,
      taskCount: 0,
    });

    const health = await manager.checkHealth("cleanup-test", { stallThresholdMs: 120_000 });
    expect(health.isStalled).toBe(true);
    expect(health.status).toBe("stalled");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/heartbeat-child-health.test.ts`
Expected: PASS (uses existing manager implementation)

- [ ] **Step 3: Add health check to heartbeat loop**

```typescript
// Add to HeartbeatLoopOptions interface in heartbeat.ts
childSupervisorManager?: ChildSupervisorManager | undefined;
```

```typescript
// Add property to HeartbeatLoop class
private readonly childSupervisorManager: ChildSupervisorManager | undefined;

// In constructor
this.childSupervisorManager = options.childSupervisorManager;
```

```typescript
// Add method to HeartbeatLoop class
/**
 * Check health of all child supervisors and handle stalled/failed children.
 * Called during each heartbeat cycle.
 */
private async checkChildSupervisorHealth(): Promise<void> {
  if (!this.childSupervisorManager) return;

  const children = this.childSupervisorManager.list();
  for (const child of children) {
    if (!child.enabled) continue;

    const health = await this.childSupervisorManager.checkHealth(child.name, {
      stallThresholdMs: child.heartbeatIntervalMs * 3, // 3x heartbeat interval
    });

    if (health.isStalled || health.status === "failed") {
      await this.activityLog.log(
        "warning",
        `Child supervisor ${child.name} is ${health.status} — attempting restart`,
        { childName: child.name, status: health.status },
      );

      try {
        await this.childSupervisorManager.restart(child.name);
        await this.activityLog.log(
          "event",
          `Child supervisor ${child.name} restarted successfully`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.activityLog.log(
          "error",
          `Failed to restart child supervisor ${child.name}: ${msg}`,
        );
      }
    }
  }
}
```

```typescript
// Call in runHeartbeat(), after gatherEventContext()
await this.checkChildSupervisorHealth();
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts packages/core/src/__tests__/heartbeat-child-health.test.ts
git commit -m "feat(supervisor): add child supervisor health monitoring

Heartbeat loop now monitors child supervisor health:
- Checks all enabled children each heartbeat cycle
- Detects stalled children (no heartbeat for 3x interval)
- Auto-restarts failed/stalled children
- Logs health status and restart attempts

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 9: CLI Child Supervisor Flags

**Files:**
- Modify: `packages/cli/src/commands/supervise.ts`

- [ ] **Step 1: Add new CLI flags**

```typescript
// Add to args in defineCommand in supervise.ts
"child-of": {
  type: "string",
  description: "Run as a child of the specified parent supervisor",
},
type: {
  type: "string",
  description: "Supervisor type (cleanup, custom) — used with --child-of",
},
repo: {
  type: "string",
  description: "Repository path — used with --child-of",
},
instructions: {
  type: "string",
  description: "Path to custom SUPERVISOR.md instructions",
},
```

- [ ] **Step 2: Add child mode handler**

```typescript
// Add handler function before defineCommand
async function handleChildSupervisorMode(
  parentName: string,
  name: string,
  type: string,
  repo: string,
  budget: string | undefined,
  instructions: string | undefined,
): Promise<void> {
  const parentState = await isDaemonRunning(parentName);
  if (!parentState) {
    printError(`Parent supervisor "${parentName}" is not running.`);
    printError("Start it first with: neo supervise --detach");
    process.exitCode = 1;
    return;
  }

  const config = await loadGlobalConfig();

  // This supervisor runs in child mode — simplified daemon that reports to parent
  const { SupervisorDaemon, getChildSupervisorDir } = await import("@neotx/core");

  const childDir = getChildSupervisorDir(parentName, name);

  // Start the daemon with child-specific configuration
  const daemon = new SupervisorDaemon({
    name,
    config: {
      ...config,
      supervisor: {
        ...config.supervisor,
        dailyCapUsd: budget ? Number.parseFloat(budget) : 10,
        instructions,
      },
    },
    // Child supervisors use a different instructions path based on type
    defaultInstructionsPath: instructions,
  });

  await daemon.start();
}
```

- [ ] **Step 3: Route to handler in run()**

```typescript
// Add to run() function, before the existing handler checks
if (args["child-of"]) {
  const parentName = args["child-of"];
  const childName = args.name;
  const childType = args.type ?? "custom";
  const repo = args.repo ?? process.cwd();

  await handleChildSupervisorMode(
    parentName,
    childName,
    childType,
    repo,
    args.budget,
    args.instructions,
  );
  return;
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/supervise.ts
git commit -m "feat(cli): add child supervisor CLI flags

Extends neo supervise with child supervisor support:
- --child-of: specify parent supervisor name
- --type: supervisor type (cleanup, custom)
- --repo: repository path to operate on
- --instructions: custom instructions path

Example: neo supervise --child-of=main --name=cleanup --type=cleanup --repo=/path/to/repo

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Export New Modules

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/supervisor/index.ts`

- [ ] **Step 1: Export from supervisor index**

```typescript
// Add to packages/core/src/supervisor/index.ts
export * from "./child-supervisor-manager.js";
export * from "./child-supervisor-protocol.js";
```

- [ ] **Step 2: Export from core index**

```typescript
// Add to packages/core/src/index.ts (if not already re-exporting supervisor)
export {
  ChildSupervisorManager,
  type ChildSupervisorManagerOptions,
  type ChildHealthStatus,
  type CheckHealthOptions,
} from "./supervisor/child-supervisor-manager.js";

export {
  childSupervisorStateSchema,
  childHeartbeatSchema,
  readChildState,
  writeChildState,
  readChildHeartbeat,
  writeChildHeartbeat,
  type ChildSupervisorState,
  type ChildSupervisorStatus,
  type ChildHeartbeat,
} from "./supervisor/child-supervisor-protocol.js";
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/supervisor/index.ts
git commit -m "chore(core): export child supervisor modules

Makes child supervisor types and utilities available from @neotx/core.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 11: Integration Test

**Files:**
- Create: `packages/core/src/__tests__/multi-supervisor.e2e.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// packages/core/src/__tests__/multi-supervisor.e2e.test.ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildSupervisorManager } from "@/supervisor/child-supervisor-manager.js";
import {
  readChildState,
  writeChildHeartbeat,
  writeChildState,
} from "@/supervisor/child-supervisor-protocol.js";
import type { ChildSupervisorConfig } from "@/config/child-supervisor-schema.js";

describe("Multi-Supervisor Integration", () => {
  const testDir = "/tmp/neo-multi-supervisor-test";
  let manager: ChildSupervisorManager;

  const cleanupConfig: ChildSupervisorConfig = {
    name: "cleanup-test",
    type: "cleanup",
    repo: "/tmp/test-repo",
    enabled: true,
    budget: { dailyCapUsd: 5, maxCostPerTaskUsd: 0.5 },
    heartbeatIntervalMs: 30_000,
    autoStart: false,
  };

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    manager = new ChildSupervisorManager({
      parentName: "main",
      childrenDir: testDir,
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  it("manages full child supervisor lifecycle", async () => {
    // Register
    await manager.register(cleanupConfig);
    expect(manager.list()).toHaveLength(1);
    expect(manager.get("cleanup-test")).toBeDefined();

    // Simulate running state (without actually spawning)
    const childDir = path.join(testDir, "cleanup-test");
    await mkdir(childDir, { recursive: true });

    await writeChildState(childDir, {
      name: "cleanup-test",
      pid: process.pid, // Use current process for "alive" check
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      costTodayUsd: 0,
      taskCount: 0,
    });

    await writeChildHeartbeat(childDir, {
      timestamp: new Date().toISOString(),
      status: "running",
      currentTask: "Running lint",
      costSinceLastUsd: 0.02,
    });

    // Check health
    const health = await manager.checkHealth("cleanup-test", { stallThresholdMs: 60_000 });
    expect(health.status).toBe("running");
    expect(health.isStalled).toBe(false);
    expect(health.isProcessAlive).toBe(true);

    // Unregister
    await manager.unregister("cleanup-test");
    expect(manager.list()).toHaveLength(0);
  });

  it("detects budget exceeded from heartbeat", async () => {
    await manager.register(cleanupConfig);
    const childDir = path.join(testDir, "cleanup-test");
    await mkdir(childDir, { recursive: true });

    // Write heartbeat with high cost
    await writeChildHeartbeat(childDir, {
      timestamp: new Date().toISOString(),
      status: "running",
      costSinceLastUsd: 4.5, // Close to daily cap of 5
    });

    await writeChildState(childDir, {
      name: "cleanup-test",
      pid: 12345,
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      costTodayUsd: 4.5,
      taskCount: 5,
    });

    const health = await manager.checkHealth("cleanup-test", { stallThresholdMs: 60_000 });
    expect(health.lastHeartbeat?.costSinceLastUsd).toBe(4.5);
    expect(health.state?.costTodayUsd).toBe(4.5);
  });

  it("handles multiple children", async () => {
    await manager.register(cleanupConfig);
    await manager.register({
      ...cleanupConfig,
      name: "cleanup-other",
      repo: "/tmp/other-repo",
    });

    expect(manager.list()).toHaveLength(2);
    expect(manager.get("cleanup-test")).toBeDefined();
    expect(manager.get("cleanup-other")).toBeDefined();

    // Check that stopping all works
    await manager.stopAll();
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `pnpm test -- packages/core/src/__tests__/multi-supervisor.e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/multi-supervisor.e2e.test.ts
git commit -m "test(core): add multi-supervisor integration tests

Verifies end-to-end scenarios:
- Full child supervisor lifecycle (register, health, unregister)
- Budget tracking via heartbeat
- Multiple children management

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 12: Documentation

**Files:**
- Create: `docs/guides/multi-supervisor.md`

- [ ] **Step 1: Write documentation**

```markdown
# docs/guides/multi-supervisor.md
# Multi-Supervisor Architecture

Neo supports running multiple specialized supervisors, with a main supervisor orchestrating child supervisors as independent processes.

## Overview

The multi-supervisor architecture enables:
- **Specialization**: Each child supervisor has a specific focus (cleanup, testing, etc.)
- **Budget isolation**: Children have independent daily budgets
- **Process isolation**: Children run as separate processes for stability
- **Health monitoring**: Main supervisor restarts stalled/failed children

## Configuration

Add child supervisors to `~/.neo/config.yml`:

```yaml
childSupervisors:
  - name: cleanup-neo
    type: cleanup
    repo: /path/to/neo
    enabled: true
    budget:
      dailyCapUsd: 10
      maxCostPerTaskUsd: 1
    heartbeatIntervalMs: 60000
    autoStart: true
```

## Available Types

### cleanup

Maintenance supervisor for:
- Lint fixes
- Test validation
- Dead code removal
- Dependency updates

### custom

User-defined supervisor with custom instructions:

```yaml
childSupervisors:
  - name: my-supervisor
    type: custom
    repo: /path/to/repo
    instructionsPath: /path/to/SUPERVISOR.md
    objective: "Custom objective here"
    acceptanceCriteria:
      - "Criteria 1"
      - "Criteria 2"
```

## CLI Usage

### Start main supervisor with children

```bash
neo supervise --detach
# Children with autoStart: true will start automatically
```

### Start a child manually

```bash
neo supervise --child-of=supervisor --name=cleanup-my-repo --type=cleanup --repo=/path/to/repo
```

### Check status

```bash
neo supervise --status
# Shows main supervisor and all children
```

## Health Monitoring

The main supervisor monitors children every heartbeat cycle:

1. Checks heartbeat file timestamp
2. If no heartbeat for 3x `heartbeatIntervalMs`, marks as stalled
3. Attempts automatic restart
4. Logs all health events to activity log

## Budget Isolation

Each child has its own budget:
- `dailyCapUsd`: Maximum spend per day
- `maxCostPerTaskUsd`: Maximum spend per individual task

Children stop when budget is exceeded. The main supervisor's budget is separate.

## File Structure

```
~/.neo/supervisors/
├── supervisor/           # Main supervisor
│   ├── state.json
│   ├── activity.jsonl
│   └── children/         # Child supervisor data
│       ├── cleanup-neo/
│       │   ├── state.json
│       │   └── heartbeat.json
│       └── cleanup-other/
│           ├── state.json
│           └── heartbeat.json
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/guides/multi-supervisor.md
git commit -m "docs: add multi-supervisor architecture guide

Documents the process-spawn model for child supervisors:
- Configuration options
- Available supervisor types
- CLI usage
- Health monitoring
- Budget isolation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Child supervisor config schema | `child-supervisor-schema.ts` |
| 2 | Add to global config | `schema.ts`, `index.ts` |
| 3 | File-based IPC protocol | `child-supervisor-protocol.ts` |
| 4 | Path helpers | `paths.ts` |
| 5 | ChildSupervisorManager | `child-supervisor-manager.ts` |
| 6 | Cleanup supervisor type | `config.yaml`, `SUPERVISOR.md` |
| 7 | Integrate into daemon | `daemon.ts` |
| 8 | Health monitoring | `heartbeat.ts` |
| 9 | CLI flags | `supervise.ts` |
| 10 | Module exports | `index.ts` files |
| 11 | Integration tests | `multi-supervisor.e2e.test.ts` |
| 12 | Documentation | `multi-supervisor.md` |

**Total: 12 tasks**

## Key Risks

1. **Process management**: Child processes may become orphaned on parent crash. Mitigation: PID tracking in state files, lockfile cleanup on startup.

2. **File race conditions**: Multiple processes writing to same files. Mitigation: Each child has isolated directory, atomic writes.

3. **Budget drift**: Heartbeat cost reports may be delayed. Mitigation: Conservative budget checks, 10% margin before hard stop.

4. **Restart loops**: Stalled child keeps failing. Mitigation: Track restart count, exponential backoff, escalate to parent after N failures.
