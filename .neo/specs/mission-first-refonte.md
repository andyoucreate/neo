# Mission-First Architecture Refactoring

**Goal:** Refactor neo around runtime missions dispatched via `neo do`, with a root supervisor that qualifies and routes missions to itself or dedicated mission supervisors.

**Architecture:** Mission-centric model where `neo do` creates a `MissionRequest`, the root supervisor qualifies it (simple → self-handle, complex+async → spawn dedicated supervisor), and dedicated supervisors are finite, persistent, and crash-resumable. Observability is the top priority — activity logs are the primary surface, transcripts are debug-only.

**Tech Stack:** Zod schemas (single source of truth), TypeScript strict mode, JSONL storage (zero-infra), Claude Agent SDK via AIAdapter.

---

## ADR-030: Mission-First Architecture

### Status

Proposed

### Context

The current neo architecture centers on agents and the `Orchestrator` class. Users dispatch agents to repos, and the supervisor daemon monitors runs. This agent-centric model creates friction:

1. **Vocabulary mismatch**: Users think in tasks ("fix the auth bug"), not agents ("dispatch developer to neo-org/app")
2. **Implicit delegation**: The supervisor dispatches child supervisors, but the user has no control over routing
3. **Opaque execution**: When a mission spawns a child supervisor, observability degrades — the user loses track of what's happening
4. **Inheritance complexity**: Agent YAML uses `extends` and `$inherited` which creates implicit coupling and override rules

The mission-first refactoring addresses these issues by making missions the primary runtime concept.

### Decision

Adopt a mission-first architecture with these principles:

1. **MissionRequest as the entry point**: `neo do "fix auth bug"` creates a `MissionRequest`, not a raw task
2. **Root supervisor as qualifier**: The root (heartbeat mode) receives missions and decides: handle itself or delegate to a named dedicated supervisor
3. **Dedicated supervisors are finite**: They work on one mission until done, then exit. They are not event loops
4. **Session persistence for dedicated supervisors**: On crash, a dedicated supervisor resumes its SDK session — full conversation history preserved
5. **Activity-first observability**: The primary observability surface is `activity.jsonl` with explicit entries. SDK transcripts are debug-only
6. **No inheritance**: Remove `extends`, `$inherited`, and implicit name-based override. YAML is flat.

### Consequences

**Positive:**
- Users think in missions, neo speaks in missions
- Explicit routing via `neo do --to <supervisor>` gives control
- Activity logs provide full visibility into what's happening
- Simpler agent authoring (no inheritance rules)

**Negative:**
- Breaking change: existing agent YAMLs using `extends` must be migrated
- More explicit configuration required (no implicit inheritance)

---

## Part 1: Runtime Data Model

### MissionRequest

A mission request represents user intent, created when `neo do` is called.

```typescript
// packages/core/src/mission/schemas.ts

import { z } from "zod";

export const missionPrioritySchema = z.enum(["critical", "high", "medium", "low"]);

export const missionRequestSchema = z.object({
  /** Unique identifier for this mission request */
  id: z.string().uuid(),

  /** Human-readable mission description */
  description: z.string().min(1),

  /** Optional target supervisor name (from --to flag) */
  targetSupervisor: z.string().optional(),

  /** Optional target repository (inferred from cwd or explicit) */
  repo: z.string().optional(),

  /** Priority level */
  priority: missionPrioritySchema.default("medium"),

  /** Optional acceptance criteria (set by user or derived by root) */
  acceptanceCriteria: z.array(z.string()).optional(),

  /** Optional metadata */
  metadata: z.record(z.string(), z.unknown()).optional(),

  /** Creation timestamp */
  createdAt: z.string().datetime(),

  /** Who created this request */
  source: z.enum(["cli", "api", "webhook", "supervisor"]),
});

export type MissionRequest = z.infer<typeof missionRequestSchema>;
export type MissionPriority = z.infer<typeof missionPrioritySchema>;
```

### MissionRun

A mission run tracks the execution of a mission request.

```typescript
// packages/core/src/mission/schemas.ts (continued)

export const missionStatusSchema = z.enum([
  "pending",      // Queued, not yet picked up
  "qualifying",   // Root is analyzing the mission
  "running",      // Actively being worked on
  "blocked",      // Waiting for decision/input
  "completing",   // Finishing up (verification in progress)
  "completed",    // Successfully done
  "failed",       // Permanently failed
  "cancelled",    // User cancelled
]);

export const missionRunSchema = z.object({
  /** Unique identifier for this run */
  id: z.string().uuid(),

  /** Reference to the original request */
  requestId: z.string().uuid(),

  /** Current status */
  status: missionStatusSchema,

  /** Which supervisor is handling this (root name or dedicated name) */
  supervisorId: z.string(),

  /** Is this being handled by the root or a dedicated supervisor? */
  delegated: z.boolean(),

  /** If delegated, the dedicated supervisor's session ID (for resume) */
  sessionId: z.string().optional(),

  /** Repository being worked on (1 writable repo per mission) */
  repo: z.string().optional(),

  /** Branch created for this mission */
  branch: z.string().optional(),

  /** PR number if created */
  prNumber: z.number().optional(),

  /** PR URL if created */
  prUrl: z.string().optional(),

  /** Cost accumulated so far (USD) */
  costUsd: z.number().default(0),

  /** Budget cap for this mission (USD) */
  maxCostUsd: z.number().optional(),

  /** Parent mission ID (if this is a sub-mission) */
  parentMissionId: z.string().uuid().optional(),

  /** Depth in the mission tree (0 = root-handled, 1 = delegated, 2 = sub-mission) */
  depth: z.number().int().min(0).max(3).default(0),

  /** Acceptance criteria (copied from request or derived) */
  acceptanceCriteria: z.array(z.string()).optional(),

  /** Evidence collected when completing */
  completionEvidence: z.array(z.string()).optional(),

  /** Summary of what was done */
  summary: z.string().optional(),

  /** Error message if failed */
  error: z.string().optional(),

  /** Reason if blocked */
  blockedReason: z.string().optional(),

  /** Question if blocked and waiting for input */
  blockedQuestion: z.string().optional(),

  /** Timestamps */
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
});

export type MissionRun = z.infer<typeof missionRunSchema>;
export type MissionStatus = z.infer<typeof missionStatusSchema>;
```

### SupervisorProfile

A supervisor profile defines a named supervisor instance. Stored in `~/.neo/supervisors/`.

```typescript
// packages/core/src/mission/schemas.ts (continued)

export const supervisorModeSchema = z.enum(["root", "dedicated"]);

export const supervisorProfileSchema = z.object({
  /** Unique name (used in --to flag) */
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),

  /** Display name for UI */
  displayName: z.string().optional(),

  /** Description of this supervisor's purpose */
  description: z.string().optional(),

  /** Mode: root (heartbeat) or dedicated (finite mission) */
  mode: supervisorModeSchema,

  /** Model to use (opus, sonnet, haiku) */
  model: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),

  /** Path to custom instructions markdown file */
  instructionsPath: z.string().optional(),

  /** Maximum cost per mission (USD) — dedicated supervisors only */
  maxCostUsd: z.number().optional(),

  /** Maximum turns per SDK session */
  maxTurns: z.number().optional(),

  /** Tick interval for focused loop (ms) — dedicated supervisors only */
  tickIntervalMs: z.number().default(30_000),

  /** Repos this supervisor is allowed to write to (empty = all) */
  allowedRepos: z.array(z.string()).optional(),

  /** Tools this supervisor can use */
  tools: z.array(z.string()).optional(),

  /** MCP servers this supervisor has access to */
  mcpServers: z.array(z.string()).optional(),

  /** When true, this supervisor is the default root */
  isDefault: z.boolean().default(false),

  /** Creation timestamp */
  createdAt: z.string().datetime(),
});

export type SupervisorProfile = z.infer<typeof supervisorProfileSchema>;
export type SupervisorMode = z.infer<typeof supervisorModeSchema>;
```

### MissionStore

Interface for mission persistence (follows existing SupervisorStore pattern).

```typescript
// packages/core/src/mission/store.ts

import type { MissionRequest, MissionRun, MissionStatus } from "./schemas.js";

export interface MissionQuery {
  status?: MissionStatus | MissionStatus[];
  supervisorId?: string;
  repo?: string;
  since?: Date;
  limit?: number;
}

export interface MissionStore {
  // Requests
  createRequest(request: MissionRequest): Promise<void>;
  getRequest(id: string): Promise<MissionRequest | null>;

  // Runs
  createRun(run: MissionRun): Promise<void>;
  getRun(id: string): Promise<MissionRun | null>;
  updateRun(id: string, updates: Partial<MissionRun>): Promise<void>;
  queryRuns(query: MissionQuery): Promise<MissionRun[]>;

  // Tree queries
  getChildren(parentMissionId: string): Promise<MissionRun[]>;
  getAncestors(missionId: string): Promise<MissionRun[]>;

  // Lifecycle
  close(): Promise<void>;
}
```

### JsonlMissionStore

Default JSONL implementation (zero-infra).

```typescript
// packages/core/src/mission/stores/jsonl.ts

import { appendFile, readFile } from "node:fs/promises";
import { withWriteLock } from "@/shared/fs.js";
import type { MissionQuery, MissionStore } from "../store.js";
import type { MissionRequest, MissionRun } from "../schemas.js";

export class JsonlMissionStore implements MissionStore {
  private readonly requestsPath: string;
  private readonly runsPath: string;

  constructor(dataDir: string) {
    this.requestsPath = `${dataDir}/missions/requests.jsonl`;
    this.runsPath = `${dataDir}/missions/runs.jsonl`;
  }

  async createRequest(request: MissionRequest): Promise<void> {
    await withWriteLock(this.requestsPath, async () => {
      await appendFile(this.requestsPath, JSON.stringify(request) + "\n");
    });
  }

  async getRequest(id: string): Promise<MissionRequest | null> {
    // Read all, filter by ID (for JSONL simplicity)
    const lines = await this.readLines(this.requestsPath);
    for (const line of lines.reverse()) {
      const req = JSON.parse(line) as MissionRequest;
      if (req.id === id) return req;
    }
    return null;
  }

  async createRun(run: MissionRun): Promise<void> {
    await withWriteLock(this.runsPath, async () => {
      await appendFile(this.runsPath, JSON.stringify(run) + "\n");
    });
  }

  async getRun(id: string): Promise<MissionRun | null> {
    const lines = await this.readLines(this.runsPath);
    // Last write wins (JSONL append-only)
    for (const line of lines.reverse()) {
      const run = JSON.parse(line) as MissionRun;
      if (run.id === id) return run;
    }
    return null;
  }

  async updateRun(id: string, updates: Partial<MissionRun>): Promise<void> {
    const existing = await this.getRun(id);
    if (!existing) throw new Error(`Mission run not found: ${id}`);
    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    await withWriteLock(this.runsPath, async () => {
      await appendFile(this.runsPath, JSON.stringify(updated) + "\n");
    });
  }

  async queryRuns(query: MissionQuery): Promise<MissionRun[]> {
    const lines = await this.readLines(this.runsPath);
    const byId = new Map<string, MissionRun>();

    // Last write wins
    for (const line of lines) {
      const run = JSON.parse(line) as MissionRun;
      byId.set(run.id, run);
    }

    let results = Array.from(byId.values());

    // Apply filters
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      results = results.filter((r) => statuses.includes(r.status));
    }
    if (query.supervisorId) {
      results = results.filter((r) => r.supervisorId === query.supervisorId);
    }
    if (query.repo) {
      results = results.filter((r) => r.repo === query.repo);
    }
    if (query.since) {
      results = results.filter((r) => new Date(r.createdAt) >= query.since!);
    }

    // Sort by createdAt desc
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async getChildren(parentMissionId: string): Promise<MissionRun[]> {
    return this.queryRuns({}).then((runs) =>
      runs.filter((r) => r.parentMissionId === parentMissionId)
    );
  }

  async getAncestors(missionId: string): Promise<MissionRun[]> {
    const ancestors: MissionRun[] = [];
    let current = await this.getRun(missionId);

    while (current?.parentMissionId) {
      const parent = await this.getRun(current.parentMissionId);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }

    return ancestors;
  }

  async close(): Promise<void> {
    // No cleanup needed for JSONL
  }

  private async readLines(path: string): Promise<string[]> {
    try {
      const content = await readFile(path, "utf-8");
      return content.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
```

---

## Part 2: CLI Surface

### neo do

The primary entry point for missions.

```
neo do <description>              Send a mission to the root supervisor
neo do <description> --to <name>  Send a mission to a specific named supervisor
neo do <description> --repo <path>  Explicit repo target
neo do <description> --priority high  Set mission priority
neo do <description> -d           Start supervisor in background if not running (--detach)
```

**Implementation changes:**

```typescript
// packages/cli/src/commands/do.ts

import { randomUUID } from "node:crypto";
import { getSupervisorInboxPath, getDataDir } from "@neotx/core";
import { defineCommand } from "citty";
import { isDaemonRunning, startDaemonDetached } from "../daemon-utils.js";
import { printError, printSuccess } from "../output.js";
import { JsonlMissionStore } from "@neotx/core/mission/stores/jsonl.js";
import type { MissionRequest } from "@neotx/core/mission/schemas.js";

export default defineCommand({
  meta: {
    name: "do",
    description: "Send a mission to the supervisor",
  },
  args: {
    description: {
      type: "positional",
      description: "Mission description",
      required: true,
    },
    to: {
      type: "string",
      description: "Target supervisor name",
    },
    repo: {
      type: "string",
      description: "Target repository path",
    },
    priority: {
      type: "string",
      description: "Mission priority (critical, high, medium, low)",
      default: "medium",
    },
    detach: {
      type: "boolean",
      alias: "d",
      description: "Start supervisor in background if not running",
      default: false,
    },
  },
  async run({ args }) {
    const targetSupervisor = args.to ?? "root";
    let running = await isDaemonRunning(targetSupervisor);

    if (!running) {
      if (args.detach) {
        const result = await startDaemonDetached(targetSupervisor);
        if (result.error) {
          printError(`Failed to start supervisor: ${result.error}`);
          process.exitCode = 1;
          return;
        }
        printSuccess(`Supervisor "${targetSupervisor}" started (PID ${result.pid})`);
        await new Promise((r) => setTimeout(r, 1500));
        running = await isDaemonRunning(targetSupervisor);
      } else {
        printError(`No supervisor running (name: ${targetSupervisor}).`);
        printError("Use --detach to start one, or run: neo supervise");
        process.exitCode = 1;
        return;
      }
    }

    // Create mission request
    const request: MissionRequest = {
      id: randomUUID(),
      description: args.description as string,
      targetSupervisor: args.to,
      repo: args.repo,
      priority: args.priority as "critical" | "high" | "medium" | "low",
      createdAt: new Date().toISOString(),
      source: "cli",
    };

    // Persist to mission store
    const store = new JsonlMissionStore(getDataDir());
    await store.createRequest(request);

    // Also write to inbox for supervisor pickup
    const inboxPath = getSupervisorInboxPath(targetSupervisor);
    const inboxMessage = {
      id: request.id,
      from: "cli" as const,
      type: "mission_request",
      text: request.description,
      missionRequestId: request.id,
      timestamp: request.createdAt,
    };
    await appendFile(inboxPath, JSON.stringify(inboxMessage) + "\n", "utf-8");

    printSuccess(`Mission sent to supervisor "${targetSupervisor}"`);
    console.log(`  ID: ${request.id.slice(0, 8)}`);
    console.log(`  Description: ${request.description.slice(0, 60)}${request.description.length > 60 ? "..." : ""}`);
    console.log(`  Status: neo missions show ${request.id.slice(0, 8)}`);
  },
});
```

### neo missions

Commands for mission observability.

```
neo missions list                 List all missions (recent first)
neo missions list --status running  Filter by status
neo missions show <id>            Show mission details
neo missions tree                 Show mission hierarchy tree
neo missions logs <id>            Show activity logs for a mission
neo missions debug <id>           Show SDK transcript for a mission (debug only)
neo missions cancel <id>          Cancel a running mission
```

**Implementation:**

```typescript
// packages/cli/src/commands/missions/index.ts

import { defineCommand } from "citty";
import list from "./list.js";
import show from "./show.js";
import tree from "./tree.js";
import logs from "./logs.js";
import debug from "./debug.js";
import cancel from "./cancel.js";

export default defineCommand({
  meta: {
    name: "missions",
    description: "Manage and observe missions",
  },
  subCommands: {
    list,
    show,
    tree,
    logs,
    debug,
    cancel,
  },
});
```

```typescript
// packages/cli/src/commands/missions/list.ts

import { defineCommand } from "citty";
import { getDataDir } from "@neotx/core";
import { JsonlMissionStore } from "@neotx/core/mission/stores/jsonl.js";

export default defineCommand({
  meta: {
    name: "list",
    description: "List missions",
  },
  args: {
    status: {
      type: "string",
      description: "Filter by status",
    },
    limit: {
      type: "string",
      description: "Max results",
      default: "20",
    },
  },
  async run({ args }) {
    const store = new JsonlMissionStore(getDataDir());
    const runs = await store.queryRuns({
      status: args.status as any,
      limit: parseInt(args.limit as string, 10),
    });

    if (runs.length === 0) {
      console.log("No missions found.");
      return;
    }

    console.log("\nMissions:\n");
    for (const run of runs) {
      const statusIcon = {
        pending: "○",
        qualifying: "◐",
        running: "●",
        blocked: "◑",
        completing: "◕",
        completed: "✓",
        failed: "✗",
        cancelled: "⊘",
      }[run.status];

      const request = await store.getRequest(run.requestId);
      const desc = request?.description.slice(0, 50) ?? "Unknown";
      const cost = run.costUsd.toFixed(2);

      console.log(`  ${statusIcon} ${run.id.slice(0, 8)}  ${run.status.padEnd(10)}  $${cost}  ${desc}`);
    }
  },
});
```

```typescript
// packages/cli/src/commands/missions/tree.ts

import { defineCommand } from "citty";
import { getDataDir } from "@neotx/core";
import { JsonlMissionStore } from "@neotx/core/mission/stores/jsonl.js";

export default defineCommand({
  meta: {
    name: "tree",
    description: "Show mission hierarchy tree",
  },
  async run() {
    const store = new JsonlMissionStore(getDataDir());
    const runs = await store.queryRuns({ limit: 100 });

    // Build tree
    const byId = new Map(runs.map((r) => [r.id, r]));
    const rootRuns = runs.filter((r) => !r.parentMissionId);

    function printTree(run: typeof runs[0], indent = ""): void {
      const request = byId.get(run.requestId);
      const icon = run.delegated ? "├─●" : "├─○";
      console.log(`${indent}${icon} ${run.id.slice(0, 8)} [${run.status}] ${run.supervisorId}`);

      const children = runs.filter((r) => r.parentMissionId === run.id);
      for (const child of children) {
        printTree(child, indent + "│  ");
      }
    }

    console.log("\nMission Tree:\n");
    for (const root of rootRuns) {
      printTree(root);
    }
  },
});
```

### neo supervisor

Debug commands for supervisor internals (not primary observability).

```
neo supervisor status             Show supervisor daemon status
neo supervisor activity           Show recent activity log entries
neo supervisor children           Show active child supervisors
neo supervisor stop               Stop the supervisor daemon
```

---

## Part 3: Supervisor Qualification Logic

When the root supervisor receives a mission request, it must decide how to handle it.

### Qualification Criteria

```typescript
// packages/core/src/mission/qualifier.ts

import type { MissionRequest, MissionRun } from "./schemas.js";

export interface QualificationResult {
  /** Should this mission be delegated to a dedicated supervisor? */
  delegate: boolean;

  /** If delegating, the name of the dedicated supervisor to spawn */
  supervisorName?: string;

  /** Derived acceptance criteria */
  acceptanceCriteria: string[];

  /** Estimated complexity (for logging/metrics) */
  complexity: "trivial" | "simple" | "moderate" | "complex";

  /** Reasoning (for activity log) */
  reasoning: string;
}

/**
 * The root supervisor calls this after LLM analysis to validate delegation decision.
 * This is a runtime guard — the LLM proposes, the runtime validates.
 */
export function validateDelegationDecision(
  request: MissionRequest,
  llmProposal: QualificationResult,
): QualificationResult {
  // Runtime rules that override LLM decisions:

  // 1. If user explicitly targeted a supervisor, respect that
  if (request.targetSupervisor && request.targetSupervisor !== "root") {
    return {
      ...llmProposal,
      delegate: true,
      supervisorName: request.targetSupervisor,
    };
  }

  // 2. Trivial missions never delegate (waste of resources)
  if (llmProposal.complexity === "trivial") {
    return {
      ...llmProposal,
      delegate: false,
      reasoning: `${llmProposal.reasoning} [runtime: trivial missions stay with root]`,
    };
  }

  // 3. If no acceptance criteria were derived, force root handling
  if (llmProposal.acceptanceCriteria.length === 0) {
    return {
      ...llmProposal,
      delegate: false,
      reasoning: `${llmProposal.reasoning} [runtime: no acceptance criteria, root handles]`,
    };
  }

  // 4. Complex + async missions should delegate
  if (llmProposal.complexity === "complex" && !llmProposal.delegate) {
    return {
      ...llmProposal,
      delegate: true,
      supervisorName: llmProposal.supervisorName ?? `mission-${request.id.slice(0, 8)}`,
      reasoning: `${llmProposal.reasoning} [runtime: complex mission, forcing delegation]`,
    };
  }

  return llmProposal;
}
```

### Qualification Tool for LLM

```typescript
// packages/core/src/mission/tools/qualify-mission.ts

export const QUALIFY_MISSION_TOOL = {
  name: "qualify_mission",
  description: `Analyze a mission request and determine how to handle it.

Called by the root supervisor when a new mission arrives. Returns a qualification result
that determines whether to handle the mission directly or delegate to a dedicated supervisor.

Guidelines:
- TRIVIAL: Single command, quick lookup, no code changes → root handles
- SIMPLE: Small code change, single file, clear scope → root handles
- MODERATE: Multiple files, requires planning, < 30 min → root MAY delegate
- COMPLEX: Large scope, CI/review needed, async → MUST delegate

Always provide acceptance criteria — measurable conditions that define "done".
`,
  input_schema: {
    type: "object",
    properties: {
      delegate: {
        type: "boolean",
        description: "Whether to delegate this mission to a dedicated supervisor",
      },
      supervisorName: {
        type: "string",
        description: "Name for the dedicated supervisor (if delegating). Use mission-{id} format.",
      },
      acceptanceCriteria: {
        type: "array",
        items: { type: "string" },
        description: "List of measurable criteria that define when this mission is complete",
      },
      complexity: {
        type: "string",
        enum: ["trivial", "simple", "moderate", "complex"],
        description: "Estimated complexity level",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of the qualification decision",
      },
    },
    required: ["delegate", "acceptanceCriteria", "complexity", "reasoning"],
  },
};
```

---

## Part 4: Observability Model

### Activity Types

Extend the existing activity entry schema to include mission-specific types:

```typescript
// packages/core/src/mission/activity.ts

import { z } from "zod";

export const missionActivityTypeSchema = z.enum([
  // Existing types (kept for compatibility)
  "heartbeat",
  "decision",
  "action",
  "error",
  "warning",
  "event",
  "message",
  "thinking",
  "plan",
  "dispatch",
  "tool_use",

  // New mission-specific types
  "mission_received",    // Mission request received
  "mission_qualified",   // Qualification complete
  "mission_delegated",   // Delegated to dedicated supervisor
  "mission_progress",    // Progress update from mission
  "mission_blocked",     // Mission blocked, waiting for input
  "mission_unblocked",   // Mission unblocked, resuming
  "mission_completing",  // Verification in progress
  "mission_completed",   // Mission successfully completed
  "mission_failed",      // Mission failed
  "mission_cancelled",   // Mission cancelled by user
]);

export const missionActivityEntrySchema = z.object({
  id: z.string().uuid(),
  type: missionActivityTypeSchema,
  summary: z.string(),

  // Mission context (optional, present for mission_* types)
  missionId: z.string().uuid().optional(),
  missionRequestId: z.string().uuid().optional(),

  // Additional detail
  detail: z.unknown().optional(),
  timestamp: z.string().datetime(),
});

export type MissionActivityEntry = z.infer<typeof missionActivityEntrySchema>;
```

### Activity Log Integration

```typescript
// packages/core/src/supervisor/activity-log.ts (modifications)

/**
 * Log a mission event to the activity log.
 * This is the primary observability surface — not transcripts.
 */
async logMissionEvent(
  type: MissionActivityType,
  summary: string,
  missionId: string,
  detail?: unknown,
): Promise<void> {
  const entry: MissionActivityEntry = {
    id: randomUUID(),
    type,
    summary,
    missionId,
    detail,
    timestamp: new Date().toISOString(),
  };

  await this.append(entry);
}
```

### Tree Visibility

The mission tree is always visible via `neo missions tree`. Each node shows:

- Mission ID (short)
- Status
- Supervisor handling it
- Depth indicator

```
Mission Tree:

├─○ a1b2c3d4 [running] root
│  ├─● e5f6g7h8 [running] mission-e5f6g7h8
│  │  └─● i9j0k1l2 [blocked] mission-i9j0k1l2
│  └─● m3n4o5p6 [completed] mission-m3n4o5p6
```

---

## Part 5: Agent/Supervisor Authoring

### Remove Inheritance

**Breaking change**: Remove `extends`, `$inherited`, and implicit name-based override.

```yaml
# OLD (deprecated, will error)
name: my-developer
extends: developer
promptAppend: |
  Additional instructions...
tools:
  - $inherited
  - CustomTool

# NEW (explicit, flat)
name: my-developer
description: Custom developer agent
model: sonnet
prompt: |
  Full prompt here — no inheritance.
  Include all instructions explicitly.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - CustomTool
```

### Supervisor Profile Format

```yaml
# ~/.neo/supervisors/my-backend.yml

name: my-backend
displayName: Backend Specialist
description: Handles backend tasks for the main API
mode: dedicated
model: sonnet

instructionsPath: ~/.neo/supervisors/my-backend.md

maxCostUsd: 10.0
maxTurns: 100
tickIntervalMs: 30000

allowedRepos:
  - org/api-server
  - org/shared-lib

mcpServers:
  - postgres
  - redis

createdAt: 2026-03-30T00:00:00Z
```

### Config Validation

Fail-fast validation on startup:

```typescript
// packages/core/src/config/validator.ts

export interface ConfigValidationError {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export function validateConfig(config: GlobalConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // Check for deprecated inheritance patterns
  for (const agentPath of glob.sync("~/.neo/agents/*.yml")) {
    const content = parseYaml(readFileSync(agentPath, "utf-8"));
    if (content.extends) {
      errors.push({
        path: agentPath,
        message: `"extends" is no longer supported. Inline all configuration directly.`,
        severity: "error",
      });
    }
    if (content.tools?.includes("$inherited")) {
      errors.push({
        path: agentPath,
        message: `"$inherited" in tools is no longer supported. List all tools explicitly.`,
        severity: "error",
      });
    }
    if (content.promptAppend) {
      errors.push({
        path: agentPath,
        message: `"promptAppend" is no longer supported. Use "prompt" with full content.`,
        severity: "error",
      });
    }
  }

  return errors;
}
```

---

## Part 6: Migration Plan

### Phase 1: Data Model (non-breaking)

1. Add `MissionRequest`, `MissionRun`, `SupervisorProfile` schemas
2. Add `JsonlMissionStore`
3. Add `getMissionsDir()` path helper
4. Add qualification logic and tools

**Backwards compatible**: Existing code continues to work.

### Phase 2: CLI (additive)

1. Modify `neo do` to create `MissionRequest` (in addition to current inbox message)
2. Add `neo missions` command group
3. Keep existing `neo supervise`, `neo supervisor` commands

**Backwards compatible**: New commands, existing behavior unchanged.

### Phase 3: Supervisor Integration (modification)

1. Root supervisor learns to qualify missions
2. Root supervisor learns to spawn dedicated supervisors for missions
3. Dedicated supervisors use `MissionRun` for state (instead of `ChildHandle` alone)
4. Activity log emits mission_* events

**Migration required**: Supervisor prompt changes, but external API unchanged.

### Phase 4: Deprecation (breaking)

1. Add config validator that errors on `extends`, `$inherited`, `promptAppend`
2. Provide migration script: `neo migrate agents`
3. Remove inheritance resolution code
4. Update documentation

**Breaking change**: Users must migrate agent YAML files.

### Migration Script

```typescript
// packages/cli/src/commands/migrate/agents.ts

export default defineCommand({
  meta: {
    name: "agents",
    description: "Migrate agent YAML files to flat format (no inheritance)",
  },
  async run() {
    const agentsDir = path.join(getDataDir(), "agents");
    const files = await glob("**/*.yml", { cwd: agentsDir });

    for (const file of files) {
      const fullPath = path.join(agentsDir, file);
      const content = await readFile(fullPath, "utf-8");
      const parsed = parseYaml(content);

      if (!parsed.extends && !parsed.promptAppend && !parsed.tools?.includes("$inherited")) {
        console.log(`  ✓ ${file} — already flat`);
        continue;
      }

      // Resolve inheritance and flatten
      const resolved = await resolveAgentWithInheritance(parsed);
      const flattened = {
        name: resolved.name,
        description: resolved.definition.description,
        model: resolved.definition.model,
        prompt: resolved.definition.prompt,
        tools: resolved.definition.tools,
        sandbox: resolved.sandbox,
        maxTurns: resolved.maxTurns,
        maxCost: resolved.maxCost,
        mcpServers: resolved.definition.mcpServers,
      };

      // Write backup
      await writeFile(`${fullPath}.bak`, content);

      // Write flattened
      await writeFile(fullPath, stringifyYaml(flattened));

      console.log(`  ✓ ${file} — migrated (backup: ${file}.bak)`);
    }
  },
});
```

---

## Part 7: File Map

| File | Change |
|------|--------|
| `packages/core/src/mission/schemas.ts` | **New** — MissionRequest, MissionRun, SupervisorProfile schemas |
| `packages/core/src/mission/store.ts` | **New** — MissionStore interface |
| `packages/core/src/mission/stores/jsonl.ts` | **New** — JsonlMissionStore implementation |
| `packages/core/src/mission/qualifier.ts` | **New** — Qualification logic and validation |
| `packages/core/src/mission/tools/qualify-mission.ts` | **New** — LLM tool for mission qualification |
| `packages/core/src/mission/activity.ts` | **New** — Mission activity types |
| `packages/core/src/mission/index.ts` | **New** — Public exports |
| `packages/core/src/paths.ts` | **Modify** — Add `getMissionsDir()` |
| `packages/core/src/index.ts` | **Modify** — Export mission module |
| `packages/cli/src/commands/do.ts` | **Modify** — Create MissionRequest |
| `packages/cli/src/commands/missions/index.ts` | **New** — Missions command group |
| `packages/cli/src/commands/missions/list.ts` | **New** — List missions |
| `packages/cli/src/commands/missions/show.ts` | **New** — Show mission details |
| `packages/cli/src/commands/missions/tree.ts` | **New** — Mission tree view |
| `packages/cli/src/commands/missions/logs.ts` | **New** — Mission activity logs |
| `packages/cli/src/commands/missions/debug.ts` | **New** — Debug transcript view |
| `packages/cli/src/commands/missions/cancel.ts` | **New** — Cancel mission |
| `packages/cli/src/commands/supervisor/index.ts` | **Modify** — Reorganize debug commands |
| `packages/cli/src/commands/migrate/agents.ts` | **New** — Agent migration script |
| `packages/core/src/config/validator.ts` | **New** — Config validation with deprecation errors |
| `packages/core/src/supervisor/heartbeat.ts` | **Modify** — Integrate qualification on mission_request |
| `packages/core/src/supervisor/activity-log.ts` | **Modify** — Add `logMissionEvent()` |
| `packages/core/src/supervisor/prompt-builder.ts` | **Modify** — Add qualification instructions to root prompt |
| `packages/core/src/agents/schema.ts` | **Modify** — Remove `$inherited` token (Phase 4) |
| `packages/core/src/agents/resolver.ts` | **Modify** — Remove inheritance resolution (Phase 4) |

---

## Part 8: Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| MissionRequest as entry point | Users think in tasks, not agents. The mission is the atomic unit of work. |
| Root qualifies, runtime validates | LLM proposes delegation, runtime guards enforce rules (complexity, criteria). |
| Dedicated supervisors are finite | Finite processes are easier to reason about, debug, and cost-track. |
| Session persistence for dedicated | Crash recovery without losing context. SDK conversation continues seamlessly. |
| Activity-first observability | Activity logs are structured, queryable, and designed for humans. Transcripts are debug noise. |
| No inheritance | Inheritance creates implicit coupling. Flat YAML is explicit and auditable. |
| `neo do --to` for explicit routing | User control over which supervisor handles a mission. |
| Max depth 3 | Reasonable limit for mission trees. Prevents runaway recursion. |
| 1 writable repo per mission | Clear ownership. No cross-repo race conditions. |

---

## Out of Scope

- Web UI (reads from MissionStore — can be built separately)
- Multi-repo missions (1 repo per mission is a hard constraint)
- Real-time mission streaming (polling is sufficient for MVP)
- Priority preemption (missions run to completion)
- Historical mission analytics (basic queries only)

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking change on inheritance removal | Users with custom agents need to migrate | Migration script + clear error messages + backup files |
| Qualification accuracy | LLM may mis-classify mission complexity | Runtime validation overrides LLM; conservative default (root handles if unsure) |
| Dedicated supervisor cost | Spawning processes has overhead | Only delegate complex+async missions; trivial stays with root |
| Tree depth explosion | Deep trees are hard to observe | Hard limit of depth 3; UI shows tree structure |
| Session persistence corruption | JSONL append-only can have partial writes | Use `withWriteLock()` for atomic operations (existing pattern) |
