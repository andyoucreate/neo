# Mission-First Clean Base Refactoring

**Goal:** Remove all deprecated child/focused supervisor concepts and replace with mission-first architecture. Clean internal refactor — no external API breaks.

**Architecture:** Phase-based deletion and reconstruction. Each phase produces a compilable state. Delete legacy child/focused modules first, then introduce minimal mission types, then wire CLI surface.

**Tech Stack:** TypeScript, Zod schemas, citty CLI, Claude Agent SDK

---

## File Mapping

### Files to DELETE (Phase A)

| Package | File | Reason |
|---------|------|--------|
| `packages/core/src/supervisor/` | `child-registry.ts` | Child supervisor registry |
| `packages/core/src/supervisor/` | `child-registry.test.ts` | Tests for deleted module |
| `packages/core/src/supervisor/` | `child-spawner.ts` | Child spawn logic |
| `packages/core/src/supervisor/` | `child-spawner.test.ts` | Tests for deleted module |
| `packages/core/src/supervisor/` | `child-command-parser.ts` | Child command parsing |
| `packages/core/src/supervisor/` | `child-command-parser.test.ts` | Tests for deleted module |
| `packages/core/src/supervisor/` | `spawn-child-tool.ts` | SDK tool definition |
| `packages/core/src/supervisor/` | `spawn-child-tool.test.ts` | Tests for deleted module |
| `packages/core/src/supervisor/` | `focused-loop.ts` | Focused supervisor loop |
| `packages/core/src/supervisor/` | `children-file.ts` | Children registry file I/O |
| `packages/core/src/supervisor/` | `children-file.test.ts` | Tests for deleted module |
| `packages/core/src/supervisor/__tests__/` | `child-supervisor-integration.test.ts` | Integration tests |
| `packages/core/src/__tests__/` | `focused-loop.test.ts` | Focused loop tests |
| `packages/core/src/__tests__/` | `child-registry.test.ts` | Duplicate tests |
| `packages/cli/src/commands/` | `child.ts` | CLI child command |
| `packages/cli/src/` | `child-mode.ts` | Child mode entry point |
| `packages/cli/src/daemon/` | `child-supervisor-worker.ts` | Child worker process |
| `packages/cli/src/daemon/` | `child-supervisor-worker.test.ts` | Tests for deleted module |
| `packages/cli/src/tui/components/` | `child-list.tsx` | TUI child list component |
| `packages/cli/src/tui/components/` | `child-detail.tsx` | TUI child detail component |
| `packages/cli/src/tui/components/` | `child-input.tsx` | TUI child input component |
| `packages/agents/prompts/` | `focused-supervisor.md` | Focused supervisor prompt |

### Files to MODIFY (Phases A-D)

| Package | File | Changes |
|---------|------|---------|
| `packages/core/src/supervisor/schemas.ts` | Remove `ChildHandle`, `ChildToParentMessage`, `ParentToChildMessage`, `childHandleSchema`, `childHandleStatusSchema`, `childToParentMessageSchema`, `parentToChildMessageSchema`. Remove child from `QueuedEvent` union. Add mission types. |
| `packages/core/src/supervisor/index.ts` | Remove all child/focused exports. Add mission exports. |
| `packages/core/src/index.ts` | Remove child/focused exports. Add mission exports. |
| `packages/core/src/paths.ts` | Remove `getSupervisorChildrenPath`, `getFocusedSupervisorsDir`, `getFocusedSupervisorDir`, `getFocusedSupervisorSessionPath`. Add mission paths. |
| `packages/core/src/paths.test.ts` | Update tests for new paths |
| `packages/core/src/supervisor/prompt-builder.ts` | Remove `CHILD_SUPERVISOR_RULES` block, all child/focused wording. Replace with mission vocabulary. |
| `packages/core/src/supervisor/heartbeat.ts` | Remove child IPC handling |
| `packages/core/src/supervisor/daemon.ts` | Remove child spawner initialization |
| `packages/core/src/supervisor/event-queue.ts` | Remove `child_supervisor` event kind |
| `packages/core/src/agents/schema.ts` | Remove `$inherited` from `agentToolEntrySchema`. Remove `extends` from `agentConfigSchema`. |
| `packages/core/src/agents/resolver.ts` | Remove inheritance logic. Require complete agent definitions. |
| `packages/cli/src/index.ts` | Remove `child` subcommand. Add `missions` subcommand. |
| `packages/cli/src/commands/supervise.ts` | Remove `--parent`, `--objective`, `--criteria`, `--budget` args. Add `--to` arg for `neo do`. |
| `packages/cli/src/commands/do.ts` | Add `--to <supervisor>` for mission routing. |
| `packages/cli/src/tui/supervisor-tui.tsx` | Remove all child-related imports and usage (ChildHandle, getFocusedSupervisorDir, getSupervisorChildrenPath, readChildrenFile, ChildDetail, ChildInput, ChildList). |

### Files to CREATE (Phases B-C)

| Package | File | Purpose |
|---------|------|---------|
| `packages/core/src/supervisor/mission-types.ts` | `MissionRequest`, `MissionRun`, `SupervisorProfile` Zod schemas |
| `packages/core/src/supervisor/mission-store.ts` | JSONL store for mission runs |
| `packages/cli/src/commands/missions.ts` | CLI: `neo missions list\|show\|tree\|logs\|debug` |

---

## Task 1: Delete Core Child Modules

**Files:**
- Delete: `packages/core/src/supervisor/child-registry.ts`
- Delete: `packages/core/src/supervisor/child-registry.test.ts`
- Delete: `packages/core/src/supervisor/child-spawner.ts`
- Delete: `packages/core/src/supervisor/child-spawner.test.ts`
- Delete: `packages/core/src/supervisor/child-command-parser.ts`
- Delete: `packages/core/src/supervisor/child-command-parser.test.ts`
- Delete: `packages/core/src/supervisor/spawn-child-tool.ts`
- Delete: `packages/core/src/supervisor/spawn-child-tool.test.ts`
- Delete: `packages/core/src/supervisor/focused-loop.ts`
- Delete: `packages/core/src/supervisor/children-file.ts`
- Delete: `packages/core/src/supervisor/children-file.test.ts`
- Delete: `packages/core/src/supervisor/__tests__/child-supervisor-integration.test.ts`
- Delete: `packages/core/src/__tests__/focused-loop.test.ts`
- Delete: `packages/core/src/__tests__/child-registry.test.ts`

- [ ] **Step 1: Delete child-registry module**

```bash
rm packages/core/src/supervisor/child-registry.ts
rm packages/core/src/supervisor/child-registry.test.ts
rm packages/core/src/__tests__/child-registry.test.ts
```

- [ ] **Step 2: Delete child-spawner module**

```bash
rm packages/core/src/supervisor/child-spawner.ts
rm packages/core/src/supervisor/child-spawner.test.ts
```

- [ ] **Step 3: Delete child-command-parser module**

```bash
rm packages/core/src/supervisor/child-command-parser.ts
rm packages/core/src/supervisor/child-command-parser.test.ts
```

- [ ] **Step 4: Delete spawn-child-tool module**

```bash
rm packages/core/src/supervisor/spawn-child-tool.ts
rm packages/core/src/supervisor/spawn-child-tool.test.ts
```

- [ ] **Step 5: Delete focused-loop module**

```bash
rm packages/core/src/supervisor/focused-loop.ts
rm packages/core/src/__tests__/focused-loop.test.ts
```

- [ ] **Step 6: Delete children-file module**

```bash
rm packages/core/src/supervisor/children-file.ts
rm packages/core/src/supervisor/children-file.test.ts
```

- [ ] **Step 7: Delete integration test**

```bash
rm packages/core/src/supervisor/__tests__/child-supervisor-integration.test.ts
```

- [ ] **Step 8: Commit deletion**

```bash
git add -A
git commit -m "refactor(core): delete child/focused supervisor modules

BREAKING CHANGE: Removes child-registry, child-spawner, child-command-parser,
spawn-child-tool, focused-loop, children-file modules.

Part of mission-first architecture migration."
```

---

## Task 2: Delete CLI Child Modules

**Files:**
- Delete: `packages/cli/src/commands/child.ts`
- Delete: `packages/cli/src/child-mode.ts`
- Delete: `packages/cli/src/daemon/child-supervisor-worker.ts`
- Delete: `packages/cli/src/daemon/child-supervisor-worker.test.ts`

- [ ] **Step 1: Delete child command**

```bash
rm packages/cli/src/commands/child.ts
```

- [ ] **Step 2: Delete child-mode entry point**

```bash
rm packages/cli/src/child-mode.ts
```

- [ ] **Step 3: Delete child-supervisor-worker**

```bash
rm packages/cli/src/daemon/child-supervisor-worker.ts
rm packages/cli/src/daemon/child-supervisor-worker.test.ts
```

- [ ] **Step 4: Commit deletion**

```bash
git add -A
git commit -m "refactor(cli): delete child supervisor CLI modules

Removes neo child command and child-mode infrastructure."
```

---

## Task 3: Delete TUI Child Components

**Files:**
- Delete: `packages/cli/src/tui/components/child-list.tsx`
- Delete: `packages/cli/src/tui/components/child-detail.tsx`
- Delete: `packages/cli/src/tui/components/child-input.tsx`
- Modify: `packages/cli/src/tui/supervisor-tui.tsx`

- [ ] **Step 1: Delete TUI child components**

```bash
rm packages/cli/src/tui/components/child-list.tsx
rm packages/cli/src/tui/components/child-detail.tsx
rm packages/cli/src/tui/components/child-input.tsx
```

- [ ] **Step 2: Clean supervisor-tui.tsx imports and usage**

Remove these imports from `packages/cli/src/tui/supervisor-tui.tsx`:

```typescript
// Remove these imports:
import type { ChildHandle } from "@neotx/core";
import { getFocusedSupervisorDir, getSupervisorChildrenPath, readChildrenFile } from "@neotx/core";
import { ChildDetail } from "./components/child-detail.js";
import type { ChildInputMode } from "./components/child-input.js";
import { ChildInput } from "./components/child-input.js";
import { ChildList } from "./components/child-list.js";
```

Remove all state and effects related to children:
- Remove `children` state
- Remove `selectedChild` state
- Remove `childInputMode` state
- Remove `useEffect` that calls `readChildrenFile`
- Remove `ChildList`, `ChildDetail`, `ChildInput` component usage
- Remove any `MAX_CHILD_ACTIVITY` constant

- [ ] **Step 3: Run typecheck to verify cleanup**

```bash
pnpm typecheck
```

Expected: Errors related to removed imports should be gone for TUI files.

- [ ] **Step 4: Commit TUI cleanup**

```bash
git add -A
git commit -m "refactor(cli): delete TUI child supervisor components

Removes ChildList, ChildDetail, ChildInput components and cleans
supervisor-tui.tsx of all child-related imports and usage."
```

---

## Task 4: Delete Focused Supervisor Prompt (was Task 3)

**Files:**
- Delete: `packages/agents/prompts/focused-supervisor.md`

- [ ] **Step 1: Delete focused supervisor prompt**

```bash
rm packages/agents/prompts/focused-supervisor.md
```

- [ ] **Step 2: Commit deletion**

```bash
git add -A
git commit -m "refactor(agents): delete focused-supervisor prompt

No longer needed in mission-first architecture."
```

---

## Task 5: Clean Schemas — Remove Child Types

**Files:**
- Modify: `packages/core/src/supervisor/schemas.ts`

- [ ] **Step 1: Remove child types from schemas.ts**

Open `packages/core/src/supervisor/schemas.ts` and remove these blocks (search by content, not line numbers):

1. Search for `// ─── Focused supervisor child handle` and remove everything from there to `export type ChildHandle`
2. Search for `// ─── IPC protocol (child → parent)` and remove everything from there to `export type ChildToParentMessage`
3. Search for `// ─── IPC protocol (parent → child)` and remove everything from there to `export type ParentToChildMessage`
4. In `QueuedEvent` type, remove the line: `| { kind: "child_supervisor"; message: ChildToParentMessage; timestamp: string }`

The `QueuedEvent` type should become:

```typescript
export type QueuedEvent =
  | { kind: "webhook"; data: WebhookIncomingEvent }
  | { kind: "message"; data: InboxMessage }
  | { kind: "run_complete"; runId: string; timestamp: string }
  | { kind: "internal"; eventKind: InternalEventKind; timestamp: string };
```

- [ ] **Step 2: Run typecheck to identify broken imports**

```bash
pnpm typecheck
```

Expected: Compile errors in files importing removed types (this is expected at this phase).

- [ ] **Step 3: Commit schema cleanup**

```bash
git add packages/core/src/supervisor/schemas.ts
git commit -m "refactor(core): remove child/focused types from schemas

Removes ChildHandle, ChildToParentMessage, ParentToChildMessage,
and child_supervisor event kind from QueuedEvent."
```

---

## Task 6: Clean Supervisor Index Exports

**Files:**
- Modify: `packages/core/src/supervisor/index.ts`

- [ ] **Step 1: Remove child/focused exports from supervisor/index.ts**

Remove these export lines:

```typescript
// Remove these lines:
export type { ChildSpawnCommand } from "./child-command-parser.js";
export { parseChildSpawnCommand } from "./child-command-parser.js";
export type { SpawnChildOptions, SpawnChildResult } from "./child-spawner.js";
export { spawnChildSupervisor } from "./child-spawner.js";
export { readChildrenFile, writeChildrenFile } from "./children-file.js";
export type { FocusedLoopOptions } from "./focused-loop.js";
export { FocusedLoop } from "./focused-loop.js";
export type { SpawnChildSupervisorInput } from "./spawn-child-tool.js";
export {
  SPAWN_CHILD_SUPERVISOR_TOOL,
  spawnChildSupervisorInputSchema,
} from "./spawn-child-tool.js";

// From schemas.ts exports, remove:
export type {
  ChildHandle,
  ChildToParentMessage,
  ParentToChildMessage,
} from "./schemas.js";
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: Errors in core/index.ts and other consumers.

- [ ] **Step 3: Commit index cleanup**

```bash
git add packages/core/src/supervisor/index.ts
git commit -m "refactor(core): remove child/focused exports from supervisor index"
```

---

## Task 7: Clean Core Index Exports

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Remove child/focused exports from core/index.ts**

Remove these exports:

```typescript
// From type exports, remove:
ChildHandle,
ChildSpawnCommand,
ChildToParentMessage,
FocusedLoopOptions,
ParentToChildMessage,
SpawnChildOptions,
SpawnChildResult,
SpawnChildSupervisorInput,

// From value exports, remove:
FocusedLoop,
parseChildSpawnCommand,
readChildrenFile,
SPAWN_CHILD_SUPERVISOR_TOOL,
spawnChildSupervisor,
spawnChildSupervisorInputSchema,

// From paths exports, remove:
getFocusedSupervisorDir,
getSupervisorChildrenPath,
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: Errors in CLI and tests.

- [ ] **Step 3: Commit core index cleanup**

```bash
git add packages/core/src/index.ts
git commit -m "refactor(core): remove child/focused exports from core index"
```

---

## Task 8: Clean Paths Module

**Files:**
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/paths.test.ts`

- [ ] **Step 1: Remove child/focused paths from paths.ts**

Remove these functions (lines 106-132):

```typescript
// Remove these functions:
export function getSupervisorChildrenPath(name: string): string {
  return path.join(getSupervisorDir(name), "children.json");
}

export function getFocusedSupervisorsDir(): string {
  return path.join(getSupervisorsDir(), "focused");
}

export function getFocusedSupervisorDir(supervisorId: string): string {
  return path.join(getFocusedSupervisorsDir(), supervisorId);
}

export function getFocusedSupervisorSessionPath(supervisorId: string): string {
  return path.join(getFocusedSupervisorDir(supervisorId), "session.json");
}
```

- [ ] **Step 2: Update paths.test.ts**

Remove tests for deleted functions.

- [ ] **Step 3: Run tests to verify**

```bash
pnpm test -- packages/core/src/paths.test.ts
```

Expected: PASS (after removing tests for deleted functions).

- [ ] **Step 4: Commit paths cleanup**

```bash
git add packages/core/src/paths.ts packages/core/src/paths.test.ts
git commit -m "refactor(core): remove child/focused path functions"
```

---

## Task 9: Clean CLI Index — Remove Child Command

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Remove child subcommand from CLI index**

Remove line 25:

```typescript
child: () => import("./commands/child.js").then((m) => m.default),
```

- [ ] **Step 2: Run build to verify**

```bash
pnpm build
```

Expected: Build passes.

- [ ] **Step 3: Commit CLI index cleanup**

```bash
git add packages/cli/src/index.ts
git commit -m "refactor(cli): remove child subcommand from CLI"
```

---

## Task 10: Clean Supervise Command — Remove Child Args

**Files:**
- Modify: `packages/cli/src/commands/supervise.ts`

- [ ] **Step 1: Remove child-related args from supervise.ts**

Remove these args (lines 251-266):

```typescript
// Remove these args:
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
```

- [ ] **Step 2: Remove handleChildMode function**

Remove the `handleChildMode` function (lines 148-192) and its call in the `run` function (lines 271-274):

```typescript
// Remove this block from run():
if (args.parent) {
  await handleChildMode(args.parent, args.objective, args.criteria, args.budget);
  return;
}
```

- [ ] **Step 3: Remove child-mode import**

The import `import { spawnChildFromCli } from "../child-mode.js";` should already error since we deleted the file. Remove the dynamic import in `handleChildMode` as well.

- [ ] **Step 4: Run build**

```bash
pnpm build
```

Expected: Build passes.

- [ ] **Step 5: Commit supervise cleanup**

```bash
git add packages/cli/src/commands/supervise.ts
git commit -m "refactor(cli): remove child supervisor args from supervise command"
```

---

## Task 11: Clean Prompt Builder — Remove Child Rules

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`

- [ ] **Step 1: Remove CHILD_SUPERVISOR_RULES constant**

Remove the entire `CHILD_SUPERVISOR_RULES` constant (approximately lines 77-150).

- [ ] **Step 2: Remove child references from OPERATING_PRINCIPLES**

In the `OPERATING_PRINCIPLES` constant, remove line 72:

```typescript
- **Child supervisors**: for self-contained objectives requiring 3+ agent dispatches...
```

- [ ] **Step 3: Search and remove any other child/focused references**

Search for `child`, `focused`, `spawn_child` in the file and remove all references.

- [ ] **Step 4: Run tests**

```bash
pnpm test -- packages/core/src/supervisor/prompt-builder
```

Expected: Tests may fail if they reference child content — update or remove them.

- [ ] **Step 5: Commit prompt builder cleanup**

```bash
git add packages/core/src/supervisor/prompt-builder.ts
git commit -m "refactor(core): remove child/focused vocabulary from prompt builder"
```

---

## Task 12: Clean Event Queue — Remove Child Event Kind

**Files:**
- Modify: `packages/core/src/supervisor/event-queue.ts`

- [ ] **Step 1: Remove child_supervisor handling from event-queue.ts**

Search for `child_supervisor` and remove any handling for this event kind.

- [ ] **Step 2: Run tests**

```bash
pnpm test -- packages/core/src/supervisor/event-queue
```

Expected: PASS.

- [ ] **Step 3: Commit event queue cleanup**

```bash
git add packages/core/src/supervisor/event-queue.ts
git commit -m "refactor(core): remove child_supervisor event kind from event queue"
```

---

## Task 13: Clean Heartbeat — Remove Child IPC

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Search and remove child IPC handling**

Search for `child`, `ChildToParentMessage`, `ParentToChildMessage` and remove all references.

- [ ] **Step 2: Run tests**

```bash
pnpm test -- packages/core/src/supervisor/heartbeat
```

Expected: PASS (or tests need updating).

- [ ] **Step 3: Commit heartbeat cleanup**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "refactor(core): remove child IPC handling from heartbeat"
```

---

## Task 14: Clean Daemon — Remove Child Spawner Init

**Files:**
- Modify: `packages/core/src/supervisor/daemon.ts`

- [ ] **Step 1: Remove child spawner initialization**

Search for `child`, `ChildRegistry`, `ChildSpawner` and remove initialization and usage.

- [ ] **Step 2: Run tests**

```bash
pnpm test -- packages/core/src/supervisor/daemon
```

Expected: PASS.

- [ ] **Step 3: Commit daemon cleanup**

```bash
git add packages/core/src/supervisor/daemon.ts
git commit -m "refactor(core): remove child spawner from daemon"
```

---

## Task 15: Clean Agent Schema — Remove Extends/$inherited

**Files:**
- Modify: `packages/core/src/agents/schema.ts`

- [ ] **Step 1: Remove $inherited from agentToolEntrySchema**

Change line 24:

```typescript
// Before:
export const agentToolEntrySchema = z.union([agentToolSchema, z.literal("$inherited")]);

// After:
export const agentToolEntrySchema = agentToolSchema;
```

- [ ] **Step 2: Remove extends from agentConfigSchema**

Remove line 43:

```typescript
extends: z.string().optional(),
```

- [ ] **Step 3: Keep promptAppend for now**

`promptAppend` is used for extending prompts and may be useful for future mission customization. Keep it in the schema. Only remove `extends` and `$inherited`.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: Errors in resolver.ts (expected, we'll fix in next task).

- [ ] **Step 5: Commit schema changes**

```bash
git add packages/core/src/agents/schema.ts
git commit -m "refactor(core): remove extends/\$inherited from agent schema"
```

---

## Task 16: Simplify Agent Resolver — No Inheritance

**Files:**
- Modify: `packages/core/src/agents/resolver.ts`

- [ ] **Step 1: Rewrite resolver to require complete agents**

Replace the entire file with:

```typescript
import type { AgentConfig, AgentTool } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent, SubagentDefinition } from "@/types";

/**
 * Resolve an agent config into a ResolvedAgent.
 * All fields must be defined — no inheritance.
 */
export function resolveAgent(config: AgentConfig): ResolvedAgent {
  if (!config.description) {
    throw new Error(
      `Agent "${config.name}" is missing "description". Add a 'description' field to the agent YAML.`,
    );
  }
  if (!config.model) {
    throw new Error(
      `Agent "${config.name}" is missing "model". Add a 'model' field (e.g., 'sonnet').`,
    );
  }
  if (!config.tools || config.tools.length === 0) {
    throw new Error(
      `Agent "${config.name}" is missing "tools". Add a 'tools' array to the agent YAML.`,
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

  const definition: AgentDefinition = {
    description: config.description,
    prompt: config.prompt,
    tools: config.tools as AgentTool[],
    model: config.model,
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
    ...(config.agents ? { agents: config.agents as Record<string, SubagentDefinition> } : {}),
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

- [ ] **Step 2: Update resolver calls to remove builtIns parameter**

Search for `resolveAgent(` calls and remove the second parameter. Files to check:
- `packages/core/src/agents/registry.ts`
- `packages/core/src/__tests__/agents.test.ts`

Run this command to find all calls:
```bash
grep -rn "resolveAgent(" packages/core/src --include="*.ts" | grep -v "export function"
```

- [ ] **Step 3: Run tests**

```bash
pnpm test -- packages/core/src/agents
```

Expected: Some tests may fail — update them to provide complete agent configs.

- [ ] **Step 4: Commit resolver simplification**

```bash
git add packages/core/src/agents/resolver.ts
git commit -m "refactor(core): simplify agent resolver — no inheritance

Agents must define all fields. No extends, no \$inherited."
```

---

## Task 17: Update Agent Tests

**Files:**
- Modify: `packages/core/src/__tests__/agents.test.ts`

- [ ] **Step 1: Update tests to use complete agent configs**

Remove tests for inheritance (`extends`, `$inherited`). Update remaining tests to provide all required fields.

- [ ] **Step 2: Run tests**

```bash
pnpm test -- packages/core/src/__tests__/agents.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit test updates**

```bash
git add packages/core/src/__tests__/agents.test.ts
git commit -m "test(core): update agent tests for no-inheritance resolver"
```

---

## Task 18: Full Validation — Phase A Complete

- [ ] **Step 1: Run full build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: PASS (some tests may need adjustment).

- [ ] **Step 4: Verify no legacy symbols remain**

```bash
grep -rE "child[-_]supervisor|focused[-_]supervisor|spawn_child|ChildHandle|ChildToParent|ParentToChild|getFocusedSupervisor|getSupervisorChildren|\$inherited" packages/*/src --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v ".test.ts"
```

Expected: No matches (or only in test mocks).

- [ ] **Step 5: Commit validation checkpoint**

```bash
git add -A
git commit -m "chore(core): Phase A complete — all child/focused code removed

- pnpm build passes
- pnpm typecheck passes
- pnpm test passes
- No legacy symbols remain"
```

---

## Task 19: Create Mission Types (Phase B)

**Files:**
- Create: `packages/core/src/supervisor/mission-types.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/supervisor/__tests__/mission-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  missionRequestSchema,
  missionRunSchema,
  supervisorProfileSchema,
  type MissionRequest,
  type MissionRun,
  type SupervisorProfile,
} from "../mission-types.js";

describe("mission-types", () => {
  describe("MissionRequest", () => {
    it("validates a complete mission request", () => {
      const request: MissionRequest = {
        id: "mission-123",
        objective: "Implement CSV export feature",
        acceptanceCriteria: ["PR open", "CI green", "Reviewer approved"],
        maxCostUsd: 5.0,
        priority: "high",
        createdAt: new Date().toISOString(),
      };
      expect(missionRequestSchema.safeParse(request).success).toBe(true);
    });

    it("rejects request without objective", () => {
      const request = {
        id: "mission-123",
        acceptanceCriteria: ["PR open"],
        createdAt: new Date().toISOString(),
      };
      expect(missionRequestSchema.safeParse(request).success).toBe(false);
    });
  });

  describe("MissionRun", () => {
    it("validates a mission run", () => {
      const run: MissionRun = {
        id: "run-456",
        missionId: "mission-123",
        status: "in_progress",
        supervisorProfile: "default",
        startedAt: new Date().toISOString(),
        costUsd: 1.25,
        runIds: ["run-1", "run-2"],
      };
      expect(missionRunSchema.safeParse(run).success).toBe(true);
    });

    it("validates completed run with evidence", () => {
      const run: MissionRun = {
        id: "run-456",
        missionId: "mission-123",
        status: "completed",
        supervisorProfile: "default",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        costUsd: 2.50,
        runIds: ["run-1"],
        evidence: ["PR #42 merged", "All tests passing"],
      };
      expect(missionRunSchema.safeParse(run).success).toBe(true);
    });
  });

  describe("SupervisorProfile", () => {
    it("validates a supervisor profile", () => {
      const profile: SupervisorProfile = {
        name: "strict",
        description: "High-validation mode with mandatory reviews",
        autoDecide: false,
        maxConcurrentRuns: 2,
      };
      expect(supervisorProfileSchema.safeParse(profile).success).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- packages/core/src/supervisor/__tests__/mission-types.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write mission-types.ts**

Create `packages/core/src/supervisor/mission-types.ts`:

```typescript
import { z } from "zod";

// ─── Mission priority ───────────────────────────────────

export const missionPrioritySchema = z.enum(["low", "normal", "high", "critical"]);

export type MissionPriority = z.infer<typeof missionPrioritySchema>;

// ─── Mission status ─────────────────────────────────────

export const missionStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export type MissionStatus = z.infer<typeof missionStatusSchema>;

// ─── Mission request (input from user or API) ──────────

export const missionRequestSchema = z.object({
  id: z.string(),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  maxCostUsd: z.number().min(0).optional(),
  priority: missionPrioritySchema.default("normal"),
  createdAt: z.string(),
  /** Optional target supervisor profile (default: "default") */
  targetProfile: z.string().optional(),
  /** Optional context from parent mission */
  parentMissionId: z.string().optional(),
});

export type MissionRequest = z.infer<typeof missionRequestSchema>;

// ─── Mission run (execution state) ─────────────────────

export const missionRunSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  status: missionStatusSchema,
  supervisorProfile: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  costUsd: z.number().default(0),
  /** IDs of agent runs dispatched by this mission */
  runIds: z.array(z.string()).default([]),
  /** Evidence of completion (for verification) */
  evidence: z.array(z.string()).optional(),
  /** Reason for failure or block */
  failureReason: z.string().optional(),
  /** Last activity timestamp */
  lastActivityAt: z.string().optional(),
});

export type MissionRun = z.infer<typeof missionRunSchema>;

// ─── Supervisor profile (runtime personality) ──────────

export const supervisorProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** When true, supervisor answers decisions autonomously */
  autoDecide: z.boolean().default(false),
  /** Max concurrent agent runs */
  maxConcurrentRuns: z.number().int().min(1).default(3),
  /** Budget cap per mission (overrides mission.maxCostUsd if lower) */
  budgetCapUsd: z.number().min(0).optional(),
  /** Custom instructions appended to supervisor prompt */
  customInstructions: z.string().optional(),
});

export type SupervisorProfile = z.infer<typeof supervisorProfileSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test -- packages/core/src/supervisor/__tests__/mission-types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/mission-types.ts packages/core/src/supervisor/__tests__/mission-types.test.ts
git commit -m "feat(core): add mission types — MissionRequest, MissionRun, SupervisorProfile"
```

---

## Task 20: Create Mission Store (Phase B)

**Files:**
- Create: `packages/core/src/supervisor/mission-store.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/supervisor/__tests__/mission-store.test.ts`:

```typescript
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionStore } from "../mission-store.js";
import type { MissionRequest, MissionRun } from "../mission-types.js";

describe("MissionStore", () => {
  let testDir: string;
  let store: MissionStore;

  beforeEach(() => {
    testDir = join(tmpdir(), `mission-store-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    store = new MissionStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("createMission", () => {
    it("creates a mission and returns a run", async () => {
      const request: MissionRequest = {
        id: "mission-1",
        objective: "Test objective",
        acceptanceCriteria: ["Criterion 1"],
        priority: "normal",
        createdAt: new Date().toISOString(),
      };

      const run = await store.createMission(request, "default");

      expect(run.missionId).toBe("mission-1");
      expect(run.status).toBe("pending");
      expect(run.supervisorProfile).toBe("default");
    });
  });

  describe("getMission", () => {
    it("returns null for non-existent mission", async () => {
      const run = await store.getMission("non-existent");
      expect(run).toBeNull();
    });

    it("returns the mission after creation", async () => {
      const request: MissionRequest = {
        id: "mission-2",
        objective: "Another objective",
        acceptanceCriteria: ["Criterion"],
        priority: "high",
        createdAt: new Date().toISOString(),
      };

      await store.createMission(request, "default");
      const run = await store.getMission("mission-2");

      expect(run).not.toBeNull();
      expect(run?.missionId).toBe("mission-2");
    });
  });

  describe("updateMission", () => {
    it("updates mission status", async () => {
      const request: MissionRequest = {
        id: "mission-3",
        objective: "Update test",
        acceptanceCriteria: ["Done"],
        priority: "normal",
        createdAt: new Date().toISOString(),
      };

      const run = await store.createMission(request, "default");
      await store.updateMission(run.id, { status: "in_progress" });

      const updated = await store.getMission("mission-3");
      expect(updated?.status).toBe("in_progress");
    });
  });

  describe("listMissions", () => {
    it("lists all missions", async () => {
      await store.createMission({
        id: "m1",
        objective: "First",
        acceptanceCriteria: ["A"],
        priority: "normal",
        createdAt: new Date().toISOString(),
      }, "default");

      await store.createMission({
        id: "m2",
        objective: "Second",
        acceptanceCriteria: ["B"],
        priority: "high",
        createdAt: new Date().toISOString(),
      }, "default");

      const missions = await store.listMissions();
      expect(missions).toHaveLength(2);
    });

    it("filters by status", async () => {
      const run1 = await store.createMission({
        id: "m1",
        objective: "First",
        acceptanceCriteria: ["A"],
        priority: "normal",
        createdAt: new Date().toISOString(),
      }, "default");

      await store.createMission({
        id: "m2",
        objective: "Second",
        acceptanceCriteria: ["B"],
        priority: "high",
        createdAt: new Date().toISOString(),
      }, "default");

      await store.updateMission(run1.id, { status: "completed" });

      const pending = await store.listMissions({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].missionId).toBe("m2");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- packages/core/src/supervisor/__tests__/mission-store.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write mission-store.ts**

Create `packages/core/src/supervisor/mission-store.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withWriteLock } from "@/shared/write-lock";
import {
  missionRunSchema,
  type MissionRequest,
  type MissionRun,
  type MissionStatus,
} from "./mission-types.js";

export interface MissionQuery {
  status?: MissionStatus;
  limit?: number;
}

/**
 * JSONL-based store for mission runs.
 * Follows the same pattern as JsonlSupervisorStore.
 */
export class MissionStore {
  private readonly filePath: string;

  constructor(supervisorDir: string) {
    this.filePath = join(supervisorDir, "missions.jsonl");
  }

  /**
   * Create a new mission run from a request.
   */
  async createMission(request: MissionRequest, profile: string): Promise<MissionRun> {
    await this.ensureDir();

    const run: MissionRun = {
      id: `mrun-${randomUUID().slice(0, 8)}`,
      missionId: request.id,
      status: "pending",
      supervisorProfile: profile,
      startedAt: new Date().toISOString(),
      costUsd: 0,
      runIds: [],
    };

    await this.appendRun(run);
    return run;
  }

  /**
   * Get the latest state of a mission by missionId.
   */
  async getMission(missionId: string): Promise<MissionRun | null> {
    const runs = await this.readAllRuns();
    // Return the latest run for this mission
    const matching = runs.filter((r) => r.missionId === missionId);
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }

  /**
   * Get a mission run by its run ID.
   */
  async getMissionRun(runId: string): Promise<MissionRun | null> {
    const runs = await this.readAllRuns();
    return runs.find((r) => r.id === runId) ?? null;
  }

  /**
   * Update a mission run.
   */
  async updateMission(runId: string, updates: Partial<MissionRun>): Promise<void> {
    const run = await this.getMissionRun(runId);
    if (!run) {
      throw new Error(`Mission run not found: ${runId}`);
    }

    const updated: MissionRun = {
      ...run,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };

    await this.appendRun(updated);
  }

  /**
   * List mission runs with optional filtering.
   */
  async listMissions(query?: MissionQuery): Promise<MissionRun[]> {
    const runs = await this.readAllRuns();

    // Group by missionId and get latest for each
    const latestByMission = new Map<string, MissionRun>();
    for (const run of runs) {
      latestByMission.set(run.missionId, run);
    }

    let result = Array.from(latestByMission.values());

    if (query?.status) {
      result = result.filter((r) => r.status === query.status);
    }

    // Sort by startedAt descending
    result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (query?.limit) {
      result = result.slice(0, query.limit);
    }

    return result;
  }

  // ─── Private ─────────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    const dir = join(this.filePath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async appendRun(run: MissionRun): Promise<void> {
    await withWriteLock(this.filePath, async () => {
      const line = JSON.stringify(run) + "\n";
      writeFileSync(this.filePath, line, { flag: "a" });
    });
  }

  private async readAllRuns(): Promise<MissionRun[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const content = readFileSync(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    const runs: MissionRun[] = [];
    for (const line of lines) {
      try {
        const parsed = missionRunSchema.parse(JSON.parse(line));
        runs.push(parsed);
      } catch {
        // Skip invalid lines
      }
    }

    return runs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test -- packages/core/src/supervisor/__tests__/mission-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/mission-store.ts packages/core/src/supervisor/__tests__/mission-store.test.ts
git commit -m "feat(core): add MissionStore — JSONL persistence for missions"
```

---

## Task 21: Export Mission Types from Index

**Files:**
- Modify: `packages/core/src/supervisor/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add mission exports to supervisor/index.ts**

Add at the end of the file:

```typescript
// ─── Mission types ─────────────────────────────────────
export type {
  MissionPriority,
  MissionRequest,
  MissionRun,
  MissionStatus,
  SupervisorProfile,
} from "./mission-types.js";
export {
  missionPrioritySchema,
  missionRequestSchema,
  missionRunSchema,
  missionStatusSchema,
  supervisorProfileSchema,
} from "./mission-types.js";

// ─── Mission store ─────────────────────────────────────
export type { MissionQuery } from "./mission-store.js";
export { MissionStore } from "./mission-store.js";
```

- [ ] **Step 2: Add mission exports to core/index.ts**

Add to the supervisor imports section:

```typescript
// In type exports from @/supervisor/index, add:
MissionPriority,
MissionQuery,
MissionRequest,
MissionRun,
MissionStatus,
SupervisorProfile,

// In value exports from @/supervisor/index, add:
missionPrioritySchema,
missionRequestSchema,
missionRunSchema,
missionStatusSchema,
MissionStore,
supervisorProfileSchema,
```

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Commit exports**

```bash
git add packages/core/src/supervisor/index.ts packages/core/src/index.ts
git commit -m "feat(core): export mission types from core index"
```

---

## Task 22: Add neo missions CLI Command (Phase C)

**Files:**
- Create: `packages/cli/src/commands/missions.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write missions.ts**

Create `packages/cli/src/commands/missions.ts`:

```typescript
import { getSupervisorDir, MissionStore } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const DEFAULT_SUPERVISOR = "supervisor";

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all missions",
  },
  args: {
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
    status: {
      type: "string",
      description: "Filter by status (pending, in_progress, completed, failed)",
    },
    limit: {
      type: "string",
      description: "Max number of missions to show",
      default: "20",
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const status = args.status as Parameters<typeof store.listMissions>[0]["status"];
    const limit = Number.parseInt(args.limit, 10);

    const missions = await store.listMissions({ status, limit });

    if (missions.length === 0) {
      console.log("No missions found.");
      return;
    }

    console.log(`\nMissions (${missions.length}):\n`);
    for (const mission of missions) {
      const statusIcon = {
        pending: "⏳",
        in_progress: "🔄",
        blocked: "🚫",
        completed: "✅",
        failed: "❌",
        cancelled: "⛔",
      }[mission.status];

      console.log(`  ${statusIcon} ${mission.missionId}`);
      console.log(`     Status: ${mission.status}`);
      console.log(`     Cost: $${mission.costUsd.toFixed(2)}`);
      console.log(`     Started: ${mission.startedAt}`);
      if (mission.runIds.length > 0) {
        console.log(`     Runs: ${mission.runIds.length}`);
      }
      console.log("");
    }
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show details of a specific mission",
  },
  args: {
    missionId: {
      type: "positional",
      description: "Mission ID to show",
      required: true,
    },
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const mission = await store.getMission(args.missionId);

    if (!mission) {
      printError(`Mission not found: ${args.missionId}`);
      process.exitCode = 1;
      return;
    }

    console.log(`\nMission: ${mission.missionId}\n`);
    console.log(`  Run ID:    ${mission.id}`);
    console.log(`  Status:    ${mission.status}`);
    console.log(`  Profile:   ${mission.supervisorProfile}`);
    console.log(`  Cost:      $${mission.costUsd.toFixed(2)}`);
    console.log(`  Started:   ${mission.startedAt}`);
    if (mission.completedAt) {
      console.log(`  Completed: ${mission.completedAt}`);
    }
    if (mission.runIds.length > 0) {
      console.log(`  Agent Runs:`);
      for (const runId of mission.runIds) {
        console.log(`    - ${runId}`);
      }
    }
    if (mission.evidence?.length) {
      console.log(`  Evidence:`);
      for (const e of mission.evidence) {
        console.log(`    ✓ ${e}`);
      }
    }
    if (mission.failureReason) {
      console.log(`  Failure: ${mission.failureReason}`);
    }
    console.log("");
  },
});

const treeCommand = defineCommand({
  meta: {
    name: "tree",
    description: "Show mission hierarchy as a tree",
  },
  args: {
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const missions = await store.listMissions();

    if (missions.length === 0) {
      console.log("No missions found.");
      return;
    }

    console.log("\nMission Tree:\n");

    // Group by status for tree view
    const byStatus = new Map<string, typeof missions>();
    for (const m of missions) {
      const list = byStatus.get(m.status) ?? [];
      list.push(m);
      byStatus.set(m.status, list);
    }

    for (const [status, list] of byStatus) {
      console.log(`  ${status.toUpperCase()} (${list.length})`);
      for (const m of list) {
        console.log(`    └─ ${m.missionId} ($${m.costUsd.toFixed(2)})`);
        for (const runId of m.runIds) {
          console.log(`       └─ ${runId}`);
        }
      }
      console.log("");
    }
  },
});

const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: "Show logs for a mission",
  },
  args: {
    missionId: {
      type: "positional",
      description: "Mission ID",
      required: true,
    },
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    // For now, redirect to activity log filtered by mission
    console.log(`Logs for mission ${args.missionId}:`);
    console.log("  (Activity log integration pending)");
    console.log(`  View full logs: neo supervisor activity --filter ${args.missionId}`);
  },
});

const debugCommand = defineCommand({
  meta: {
    name: "debug",
    description: "Debug information for a mission",
  },
  args: {
    missionId: {
      type: "positional",
      description: "Mission ID",
      required: true,
    },
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const mission = await store.getMission(args.missionId);

    if (!mission) {
      printError(`Mission not found: ${args.missionId}`);
      process.exitCode = 1;
      return;
    }

    console.log("\nMission Debug Info:\n");
    console.log(JSON.stringify(mission, null, 2));
  },
});

export default defineCommand({
  meta: {
    name: "missions",
    description: "Manage missions",
  },
  subCommands: {
    list: () => Promise.resolve(listCommand),
    show: () => Promise.resolve(showCommand),
    tree: () => Promise.resolve(treeCommand),
    logs: () => Promise.resolve(logsCommand),
    debug: () => Promise.resolve(debugCommand),
  },
});
```

- [ ] **Step 2: Add missions to CLI index**

In `packages/cli/src/index.ts`, add after line 17:

```typescript
missions: () => import("./commands/missions.js").then((m) => m.default),
```

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Test CLI command**

```bash
cd packages/cli && pnpm exec neo missions list
```

Expected: "No missions found." (or list if any exist).

- [ ] **Step 5: Commit CLI command**

```bash
git add packages/cli/src/commands/missions.ts packages/cli/src/index.ts
git commit -m "feat(cli): add neo missions command — list, show, tree, logs, debug"
```

---

## Task 23: Add --to Flag to neo do (Phase C)

**Files:**
- Modify: `packages/cli/src/commands/do.ts`

- [ ] **Step 1: Read current do.ts to understand structure**

```bash
cat packages/cli/src/commands/do.ts
```

- [ ] **Step 2: Add --to argument**

Add to the args object:

```typescript
to: {
  type: "string",
  description: "Target supervisor to route mission to (default: supervisor)",
  default: "supervisor",
},
```

- [ ] **Step 3: Update run function to use --to**

The `--to` flag routes to a specific supervisor instance. Update the message sending logic to use `getSupervisorInboxPath(args.to)` instead of hardcoded supervisor name:

```typescript
// In the run function, when writing to inbox:
const inboxPath = getSupervisorInboxPath(args.to);
await appendFile(inboxPath, `${JSON.stringify(message)}\n`, "utf-8");
```

Note: This is a minimal implementation. Full MissionStore integration will be added in Phase D (observability pass).

- [ ] **Step 4: Run build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Commit do.ts update**

```bash
git add packages/cli/src/commands/do.ts
git commit -m "feat(cli): add --to flag to neo do for supervisor routing"
```

---

## Task 24: Final Validation

- [ ] **Step 1: Run full build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Verify no legacy symbols**

```bash
grep -rE "child[-_]supervisor|focused[-_]supervisor|spawn_child|ChildHandle|ChildToParent|ParentToChild|\\\$inherited|extends:" packages/*/src --include="*.ts" | grep -v ".test.ts" | grep -v "node_modules"
```

Expected: No matches.

- [ ] **Step 5: Test neo do still works**

```bash
cd packages/cli && pnpm exec neo do --help
```

Expected: Shows help with --to flag.

- [ ] **Step 6: Test neo missions works**

```bash
cd packages/cli && pnpm exec neo missions --help
```

Expected: Shows subcommands list, show, tree, logs, debug.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: mission-first architecture complete

- All child/focused supervisor code removed
- Mission types: MissionRequest, MissionRun, SupervisorProfile
- MissionStore with JSONL persistence
- neo missions CLI: list, show, tree, logs, debug
- neo do --to <supervisor> for mission routing
- Agent resolver simplified (no inheritance)

BREAKING CHANGE: Removes child supervisor spawning.
Child orchestration replaced by mission-first pattern."
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| A | 1-18 | Delete all child/focused modules (including TUI components) and clean exports |
| B | 19-21 | Create mission types and store |
| C | 22-23 | Add neo missions CLI and --to flag |
| D | 24 | Final validation |

**Total Tasks:** 24

**Key Risks:**
1. Breaking imports in consumer code — mitigated by TypeScript compile checks
2. Missing edge cases in deletion — mitigated by grep validation
3. Test failures — expected and handled per task

**Validation Gates:**
- `pnpm build` passes after each phase
- `pnpm typecheck` passes after each phase
- `pnpm test` passes after Phase A complete
- No legacy symbols remain (grep validation)
