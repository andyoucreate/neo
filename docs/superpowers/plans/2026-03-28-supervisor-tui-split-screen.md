# Supervisor TUI Split-Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing supervisor TUI into a split-screen interface showing root supervisor on the left and focused child supervisors on the right, with full observe/message/control capabilities.

**Architecture:** A new `children.json` file (written by `ChildRegistry` on every state change, read by the TUI via polling) bridges the daemon and TUI processes. The TUI sends child commands via `inbox.jsonl` using a `child:<action>` prefix; the heartbeat loop intercepts and routes them via `ChildRegistry`. The existing `supervisor-tui.tsx` gains a right column with `ChildList`, `ChildDetail`, and `ChildInput` components.

**Tech Stack:** TypeScript, React 19, Ink 6, ink-text-input, Zod, Node.js fs/promises (zero new dependencies).

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/core/src/paths.ts` | Modify | Add `getSupervisorChildrenPath(name)` |
| `packages/core/src/supervisor/children-file.ts` | Create | `writeChildrenFile` / `readChildrenFile` helpers |
| `packages/core/src/supervisor/child-registry.ts` | Modify | Call `writeChildrenFile` after every state mutation |
| `packages/core/src/supervisor/heartbeat.ts` | Modify | Intercept `child:inject`, `child:unblock`, `child:stop` inbox messages |
| `packages/core/src/supervisor/index.ts` | Modify | Export `ChildHandle`, `ChildToParentMessage`, `ParentToChildMessage` types + `readChildrenFile` |
| `packages/core/src/index.ts` | Modify | Re-export new public types |
| `packages/cli/src/tui/components/child-list.tsx` | Create | List of child supervisors with status badges |
| `packages/cli/src/tui/components/child-detail.tsx` | Create | Activity feed + objective for the selected child |
| `packages/cli/src/tui/components/child-input.tsx` | Create | inject / unblock / kill action input |
| `packages/cli/src/tui/supervisor-tui.tsx` | Modify | Split-screen layout, child polling, keyboard routing |

---

## Task 1: Add `getSupervisorChildrenPath` to paths.ts

**Files:**
- Modify: `packages/core/src/paths.ts`
- Test: `packages/core/src/paths.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/paths.test.ts
import { describe, expect, it } from "vitest";
import { getSupervisorChildrenPath, getSupervisorDir } from "./paths.js";

describe("getSupervisorChildrenPath", () => {
  it("returns children.json inside supervisor dir", () => {
    const result = getSupervisorChildrenPath("my-supervisor");
    expect(result).toBe(`${getSupervisorDir("my-supervisor")}/children.json`);
  });

  it("ends with children.json", () => {
    expect(getSupervisorChildrenPath("foo")).toMatch(/\/children\.json$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /path/to/neo
pnpm --filter @neotx/core test -- --testPathPattern=paths.test
```

Expected: FAIL — `getSupervisorChildrenPath is not a function`

- [ ] **Step 3: Add the function to paths.ts**

Add after `getSupervisorDecisionsPath`:

```typescript
/**
 * Path to the children registry file: ~/.neo/supervisors/<name>/children.json
 * Written by ChildRegistry, read by the TUI to display focused child supervisors.
 */
export function getSupervisorChildrenPath(name: string): string {
  return path.join(getSupervisorDir(name), "children.json");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=paths.test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/paths.ts packages/core/src/paths.test.ts
git commit -m "feat(paths): add getSupervisorChildrenPath"
```

---

## Task 2: Create `children-file.ts` — read/write children.json

**Files:**
- Create: `packages/core/src/supervisor/children-file.ts`
- Test: `packages/core/src/supervisor/children-file.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/supervisor/children-file.test.ts
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildHandle } from "./schemas.js";
import { readChildrenFile, writeChildrenFile } from "./children-file.js";

const TMP = path.join(import.meta.dirname, "__tmp_children_test__");

const makeHandle = (id: string): ChildHandle => ({
  supervisorId: id,
  objective: `Objective for ${id}`,
  depth: 0,
  startedAt: new Date().toISOString(),
  lastProgressAt: new Date().toISOString(),
  costUsd: 0,
  status: "running",
});

describe("writeChildrenFile / readChildrenFile", () => {
  beforeEach(() => mkdir(TMP, { recursive: true }));
  afterEach(() => rm(TMP, { recursive: true, force: true }));

  it("returns empty array when file does not exist", async () => {
    const result = await readChildrenFile(path.join(TMP, "children.json"));
    expect(result).toEqual([]);
  });

  it("round-trips an array of handles", async () => {
    const filePath = path.join(TMP, "children.json");
    const handles = [makeHandle("abc"), makeHandle("def")];
    await writeChildrenFile(filePath, handles);
    const result = await readChildrenFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]?.supervisorId).toBe("abc");
    expect(result[1]?.supervisorId).toBe("def");
  });

  it("overwrites on second write", async () => {
    const filePath = path.join(TMP, "children.json");
    await writeChildrenFile(filePath, [makeHandle("a")]);
    await writeChildrenFile(filePath, [makeHandle("b"), makeHandle("c")]);
    const result = await readChildrenFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]?.supervisorId).toBe("b");
  });

  it("returns empty array on malformed JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const filePath = path.join(TMP, "children.json");
    await writeFile(filePath, "not json", "utf-8");
    const result = await readChildrenFile(filePath);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=children-file.test
```

Expected: FAIL — `Cannot find module './children-file.js'`

- [ ] **Step 3: Implement children-file.ts**

```typescript
// packages/core/src/supervisor/children-file.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildHandle } from "./schemas.js";

/**
 * Write the current list of child handles to children.json.
 * Called by ChildRegistry after every state mutation so the TUI can poll it.
 */
export async function writeChildrenFile(filePath: string, handles: ChildHandle[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(handles, null, 2), "utf-8");
}

/**
 * Read child handles from children.json.
 * Returns empty array if file does not exist or is malformed.
 */
export async function readChildrenFile(filePath: string): Promise<ChildHandle[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ChildHandle[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=children-file.test
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/children-file.ts \
        packages/core/src/supervisor/children-file.test.ts
git commit -m "feat(supervisor): add children-file read/write helpers"
```

---

## Task 3: Wire children-file into ChildRegistry

**Files:**
- Modify: `packages/core/src/supervisor/child-registry.ts`
- Test: `packages/core/src/supervisor/child-registry.test.ts` (extend existing)

The `ChildRegistry` needs to know the `children.json` path and call `writeChildrenFile` after every mutation that changes the list or a handle's status/cost.

- [ ] **Step 1: Read existing child-registry.test.ts to understand test patterns**

File: `packages/core/src/supervisor/child-registry.test.ts`

- [ ] **Step 2: Add a failing test for children-file integration**

Add to the existing test file (after the existing tests):

```typescript
// At the top of the file, add:
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

// Add a new describe block at the bottom:
describe("ChildRegistry — children.json persistence", () => {
  const TMP = path.join(import.meta.dirname, "__tmp_registry_children__");
  const childrenPath = path.join(TMP, "children.json");

  beforeEach(() => mkdir(TMP, { recursive: true }));
  afterEach(() => rm(TMP, { recursive: true, force: true }));

  it("writes children.json on register", async () => {
    const registry = new ChildRegistry({ onMessage: () => {}, childrenFilePath: childrenPath });
    registry.register({
      supervisorId: "s1",
      objective: "do something",
      depth: 0,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    // allow async write
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(childrenPath, "utf-8");
    const parsed = JSON.parse(raw) as { supervisorId: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.supervisorId).toBe("s1");
  });

  it("writes children.json on remove", async () => {
    const registry = new ChildRegistry({ onMessage: () => {}, childrenFilePath: childrenPath });
    registry.register({
      supervisorId: "s2",
      objective: "do something",
      depth: 0,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    await new Promise((r) => setTimeout(r, 50));
    registry.remove("s2");
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(childrenPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(parsed).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=child-registry.test
```

Expected: FAIL — `ChildRegistryOptions` has no `childrenFilePath`

- [ ] **Step 4: Modify child-registry.ts to accept childrenFilePath and write on mutation**

```typescript
// packages/core/src/supervisor/child-registry.ts
import type { ChildProcess } from "node:child_process";
import { writeChildrenFile } from "./children-file.js";
import type { ChildHandle, ChildToParentMessage, ParentToChildMessage } from "./schemas.js";

export interface ChildRegistryOptions {
  onMessage: (message: ChildToParentMessage) => void;
  stallTimeoutMs?: number;
  /** If provided, children.json is written here after every mutation. */
  childrenFilePath?: string;
}

export class ChildRegistry {
  private readonly handles = new Map<string, ChildHandle>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly stopCallbacks = new Map<string, () => void>();
  private readonly stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onMessage: (message: ChildToParentMessage) => void;
  private readonly stallTimeoutMs: number;
  private readonly childrenFilePath: string | undefined;

  constructor(options: ChildRegistryOptions) {
    this.onMessage = options.onMessage;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 10 * 60 * 1000;
    this.childrenFilePath = options.childrenFilePath;
  }

  register(handle: ChildHandle, stopCallback?: () => void, childProcess?: ChildProcess): void {
    this.handles.set(handle.supervisorId, { ...handle });
    if (stopCallback) this.stopCallbacks.set(handle.supervisorId, stopCallback);
    if (childProcess) this.processes.set(handle.supervisorId, childProcess);
    this.resetStallTimer(handle.supervisorId);
    this.persistChildren();
  }

  get(supervisorId: string): ChildHandle | undefined {
    return this.handles.get(supervisorId);
  }

  list(): ChildHandle[] {
    return Array.from(this.handles.values());
  }

  send(supervisorId: string, message: ParentToChildMessage): void {
    const proc = this.processes.get(supervisorId);
    if (proc?.connected) {
      proc.send(message);
    }
  }

  handleMessage(message: ChildToParentMessage): void {
    const handle = this.handles.get(message.supervisorId);
    if (!handle) return;

    switch (message.type) {
      case "progress": {
        handle.costUsd += message.costDelta;
        handle.lastProgressAt = new Date().toISOString();
        this.resetStallTimer(message.supervisorId);
        if (handle.maxCostUsd !== undefined && handle.costUsd >= handle.maxCostUsd) {
          this.stopChild(message.supervisorId);
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

    this.persistChildren();
    this.onMessage(message);
  }

  remove(supervisorId: string): void {
    this.handles.delete(supervisorId);
    this.processes.delete(supervisorId);
    this.stopCallbacks.delete(supervisorId);
    this.clearStallTimer(supervisorId);
    this.persistChildren();
  }

  stopAll(): void {
    for (const supervisorId of this.handles.keys()) {
      this.send(supervisorId, { type: "stop" });
      this.clearStallTimer(supervisorId);
    }
  }

  private stopChild(supervisorId: string): void {
    const handle = this.handles.get(supervisorId);
    if (handle) {
      handle.status = "failed";
    }
    this.send(supervisorId, { type: "stop" });
    this.clearStallTimer(supervisorId);
    const stopCb = this.stopCallbacks.get(supervisorId);
    if (stopCb) stopCb();
    this.persistChildren();
    this.onMessage({
      type: "failed",
      supervisorId,
      error: "Budget exceeded",
    });
  }

  private persistChildren(): void {
    if (!this.childrenFilePath) return;
    const handles = this.list();
    // fire-and-forget — TUI polling is tolerant of brief inconsistency
    writeChildrenFile(this.childrenFilePath, handles).catch(() => {});
  }

  private resetStallTimer(supervisorId: string): void {
    this.clearStallTimer(supervisorId);
    const timer = setTimeout(() => {
      const handle = this.handles.get(supervisorId);
      if (handle?.status === "running") {
        handle.status = "stalled";
        this.persistChildren();
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

- [ ] **Step 5: Run all child-registry tests**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=child-registry.test
```

Expected: PASS (all tests including new persistence tests)

- [ ] **Step 6: Wire childrenFilePath in daemon.ts**

In `packages/core/src/supervisor/daemon.ts`, find where `ChildRegistry` is instantiated and add `childrenFilePath`:

```typescript
// Find this pattern in daemon.ts:
const childRegistry = new ChildRegistry({
  onMessage: (message) => {
    eventQueue.push({ kind: "child_supervisor", message, timestamp: new Date().toISOString() });
  },
});

// Replace with:
const childRegistry = new ChildRegistry({
  onMessage: (message) => {
    eventQueue.push({ kind: "child_supervisor", message, timestamp: new Date().toISOString() });
  },
  childrenFilePath: getSupervisorChildrenPath(name),
});
```

Also add the import at the top of daemon.ts:
```typescript
import { getSupervisorChildrenPath } from "../paths.js";
```

- [ ] **Step 7: Run full test suite**

```bash
pnpm --filter @neotx/core test
```

Expected: PASS (all existing tests + new tests)

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/supervisor/child-registry.ts \
        packages/core/src/supervisor/child-registry.test.ts \
        packages/core/src/supervisor/daemon.ts
git commit -m "feat(supervisor): write children.json on every ChildRegistry mutation"
```

---

## Task 4: Intercept child:* commands in heartbeat inbox processing

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Test: `packages/core/src/supervisor/heartbeat.test.ts` (extend existing or create)

The heartbeat loop reads `inbox.jsonl`. We add interception for three message formats:
- `child:inject <supervisorId> <context>` → `childRegistry.send(id, { type: "inject", context })`
- `child:unblock <supervisorId> <answer>` → `childRegistry.send(id, { type: "unblock", answer })`
- `child:stop <supervisorId>` → `childRegistry.send(id, { type: "stop" })`

These are intercepted **before** passing events to the AI prompt, so the AI never sees them.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/supervisor/child-command-parser.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseChildCommand } from "./child-command-parser.js";

describe("parseChildCommand", () => {
  it("parses child:inject", () => {
    const result = parseChildCommand("child:inject sup-123 please add auth context");
    expect(result).toEqual({
      type: "inject",
      supervisorId: "sup-123",
      context: "please add auth context",
    });
  });

  it("parses child:unblock", () => {
    const result = parseChildCommand("child:unblock sup-456 use option B");
    expect(result).toEqual({
      type: "unblock",
      supervisorId: "sup-456",
      answer: "use option B",
    });
  });

  it("parses child:stop", () => {
    const result = parseChildCommand("child:stop sup-789");
    expect(result).toEqual({ type: "stop", supervisorId: "sup-789" });
  });

  it("returns null for non-child messages", () => {
    expect(parseChildCommand("decision:answer abc yes")).toBeNull();
    expect(parseChildCommand("hello world")).toBeNull();
    expect(parseChildCommand("child:unknown foo bar")).toBeNull();
  });

  it("returns null for child:inject without context", () => {
    expect(parseChildCommand("child:inject sup-123")).toBeNull();
  });

  it("returns null for child:unblock without answer", () => {
    expect(parseChildCommand("child:unblock sup-123")).toBeNull();
  });

  it("returns null for child:stop without supervisorId", () => {
    expect(parseChildCommand("child:stop")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=child-command-parser.test
```

Expected: FAIL — `Cannot find module './child-command-parser.js'`

- [ ] **Step 3: Create child-command-parser.ts**

```typescript
// packages/core/src/supervisor/child-command-parser.ts

export type ChildCommand =
  | { type: "inject"; supervisorId: string; context: string }
  | { type: "unblock"; supervisorId: string; answer: string }
  | { type: "stop"; supervisorId: string };

/**
 * Parse a TUI inbox message text into a child supervisor command.
 * Returns null if the text is not a child command.
 *
 * Formats:
 *   child:inject <supervisorId> <context...>
 *   child:unblock <supervisorId> <answer...>
 *   child:stop <supervisorId>
 */
export function parseChildCommand(text: string): ChildCommand | null {
  const trimmed = text.trim();

  const injectMatch = /^child:inject\s+(\S+)\s+(.+)$/i.exec(trimmed);
  if (injectMatch) {
    const supervisorId = injectMatch[1];
    const context = injectMatch[2];
    if (!supervisorId || !context) return null;
    return { type: "inject", supervisorId, context };
  }

  const unblockMatch = /^child:unblock\s+(\S+)\s+(.+)$/i.exec(trimmed);
  if (unblockMatch) {
    const supervisorId = unblockMatch[1];
    const answer = unblockMatch[2];
    if (!supervisorId || !answer) return null;
    return { type: "unblock", supervisorId, answer };
  }

  const stopMatch = /^child:stop\s+(\S+)$/i.exec(trimmed);
  if (stopMatch) {
    const supervisorId = stopMatch[1];
    if (!supervisorId) return null;
    return { type: "stop", supervisorId };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @neotx/core test -- --testPathPattern=child-command-parser.test
```

Expected: PASS (7 tests)

- [ ] **Step 5: Integrate into heartbeat.ts**

In `packages/core/src/supervisor/heartbeat.ts`, find the `processDecisionAnswers` private method (around line 1180). Right before or after that call in `processDecisions`, add child command interception.

Find the `processDecisions` method and add a call to `processChildCommands`:

```typescript
// Add import at top of heartbeat.ts:
import { parseChildCommand } from "./child-command-parser.js";

// Inside processDecisions method, after processDecisionAnswers call:
await this.processChildCommands(rawEvents);
```

Add the new private method at the bottom of the `HeartbeatLoop` class (before the closing brace):

```typescript
/**
 * Process child:* commands from inbox messages.
 * Routes inject/unblock/stop to the ChildRegistry via IPC.
 * These messages are consumed here and not forwarded to the AI prompt.
 */
private async processChildCommands(rawEvents: QueuedEvent[]): Promise<void> {
  if (!this.childRegistry) return;
  for (const event of rawEvents) {
    if (event.kind !== "message") continue;
    const command = parseChildCommand(event.data.text ?? "");
    if (!command) continue;
    switch (command.type) {
      case "inject":
        this.childRegistry.send(command.supervisorId, {
          type: "inject",
          context: command.context,
        });
        break;
      case "unblock":
        this.childRegistry.send(command.supervisorId, {
          type: "unblock",
          answer: command.answer,
        });
        break;
      case "stop":
        this.childRegistry.send(command.supervisorId, { type: "stop" });
        break;
    }
  }
}
```

- [ ] **Step 6: Run full test suite**

```bash
pnpm --filter @neotx/core test
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/supervisor/child-command-parser.ts \
        packages/core/src/supervisor/child-command-parser.test.ts \
        packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(supervisor): intercept child:inject/unblock/stop inbox commands"
```

---

## Task 5: Export new types from @neotx/core

**Files:**
- Modify: `packages/core/src/supervisor/index.ts`
- Modify: `packages/core/src/index.ts`

The TUI package imports from `@neotx/core`. It needs `ChildHandle`, `readChildrenFile`, and `getSupervisorChildrenPath`.

- [ ] **Step 1: Check current supervisor/index.ts exports**

```bash
grep -n "export" packages/core/src/supervisor/index.ts | head -40
```

- [ ] **Step 2: Add exports to supervisor/index.ts**

Find `packages/core/src/supervisor/index.ts` and add:

```typescript
// ─── Children file ─────────────────────────────────────
export { readChildrenFile, writeChildrenFile } from "./children-file.js";

// ─── Schemas (child handle) ────────────────────────────
export type {
  ChildHandle,
  ChildToParentMessage,
  ParentToChildMessage,
} from "./schemas.js";
```

- [ ] **Step 3: Add exports to core/index.ts**

In `packages/core/src/index.ts`, after the existing supervisor exports (around line 158), add:

```typescript
// ─── Supervisor children ───────────────────────────────
export type { ChildHandle } from "@/supervisor/index";
export { readChildrenFile } from "@/supervisor/index";
export { getSupervisorChildrenPath } from "@/paths";
```

- [ ] **Step 4: Build and verify no TypeScript errors**

```bash
pnpm --filter @neotx/core build
```

Expected: BUILD SUCCESS, no errors

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/index.ts packages/core/src/index.ts
git commit -m "feat(core): export ChildHandle, readChildrenFile, getSupervisorChildrenPath"
```

---

## Task 6: Create `ChildList` component

**Files:**
- Create: `packages/cli/src/tui/components/child-list.tsx`

This component renders a compact list of child supervisors. Each row shows: status badge (colored), supervisorId (truncated), cost, and a truncated objective. The selected child is highlighted.

- [ ] **Step 1: Create the file**

```typescript
// packages/cli/src/tui/components/child-list.tsx
import type { ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";

const STATUS_COLORS: Record<string, string> = {
  running: "#4ade80",
  blocked: "#fbbf24",
  stalled: "#f97316",
  complete: "#818cf8",
  failed: "#f87171",
};

const STATUS_ICONS: Record<string, string> = {
  running: "●",
  blocked: "◆",
  stalled: "◌",
  complete: "✓",
  failed: "✖",
};

const STATUS_LABELS: Record<string, string> = {
  running: "RUN",
  blocked: "BLK",
  stalled: "STL",
  complete: "DONE",
  failed: "FAIL",
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function ChildRow({
  handle,
  isSelected,
}: {
  handle: ChildHandle;
  isSelected: boolean;
}) {
  const color = STATUS_COLORS[handle.status] ?? "#9ca3af";
  const icon = STATUS_ICONS[handle.status] ?? "·";
  const label = (STATUS_LABELS[handle.status] ?? handle.status).padEnd(4);
  const cost = `$${handle.costUsd.toFixed(2)}`;
  const id = truncate(handle.supervisorId, 12);
  const objective = truncate(handle.objective, 28);

  return (
    <Box gap={1} paddingX={1}>
      <Text color={isSelected ? "#c084fc" : "#4b5563"}>{isSelected ? "▶" : " "}</Text>
      <Text color={color} bold>
        {icon}
      </Text>
      <Text color={color} bold>
        {label}
      </Text>
      <Text bold={isSelected} dimColor={!isSelected}>
        {id}
      </Text>
      <Text dimColor>·</Text>
      <Text dimColor>{cost}</Text>
      <Text dimColor>·</Text>
      <Text dimColor={!isSelected} wrap="truncate">
        {objective}
      </Text>
    </Box>
  );
}

export function ChildList({
  children,
  selectedIndex,
}: {
  children: ChildHandle[];
  selectedIndex: number;
}) {
  if (children.length === 0) {
    return (
      <Box paddingX={2}>
        <Text dimColor>No focused supervisors running</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          CHILDREN
        </Text>
        <Text dimColor>({children.length})</Text>
        <Text dimColor>{"─".repeat(20)}</Text>
      </Box>
      {children.map((handle, idx) => (
        <ChildRow key={handle.supervisorId} handle={handle} isSelected={idx === selectedIndex} />
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @neotx/cli build
```

Expected: BUILD SUCCESS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/components/child-list.tsx
git commit -m "feat(tui): add ChildList component"
```

---

## Task 7: Create `ChildDetail` component

**Files:**
- Create: `packages/cli/src/tui/components/child-detail.tsx`

Shows full objective, status, cost, last progress time, and a scrolling activity feed for the selected child.

- [ ] **Step 1: Create the file**

```typescript
// packages/cli/src/tui/components/child-detail.tsx
import type { ActivityEntry, ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";

const TYPE_ICONS: Record<string, string> = {
  heartbeat: "♥",
  decision: "★",
  action: "⚡",
  error: "✖",
  event: "◆",
  message: "✉",
  thinking: "◇",
  plan: "▸",
  dispatch: "↗",
  tool_use: "⊘",
};

const TYPE_COLORS: Record<string, string> = {
  heartbeat: "#6ee7b7",
  decision: "#fbbf24",
  action: "#60a5fa",
  error: "#f87171",
  event: "#c084fc",
  message: "#67e8f9",
  thinking: "#a78bfa",
  plan: "#34d399",
  dispatch: "#f472b6",
  tool_use: "#38bdf8",
};

function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
}

function formatTimeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#4ade80",
  blocked: "#fbbf24",
  stalled: "#f97316",
  complete: "#818cf8",
  failed: "#f87171",
};

export function ChildDetail({
  handle,
  activity,
  maxActivityLines,
}: {
  handle: ChildHandle;
  activity: ActivityEntry[];
  maxActivityLines: number;
}) {
  const statusColor = STATUS_COLORS[handle.status] ?? "#9ca3af";
  const visible = activity.slice(-maxActivityLines);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#c084fc" bold>
          {handle.supervisorId}
        </Text>
        <Text dimColor>·</Text>
        <Text color={statusColor} bold>
          {handle.status.toUpperCase()}
        </Text>
        <Text dimColor>·</Text>
        <Text dimColor>${handle.costUsd.toFixed(2)}</Text>
        {handle.lastProgressAt && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{formatTimeAgo(handle.lastProgressAt)}</Text>
          </>
        )}
      </Box>

      {/* Objective */}
      <Box paddingX={1} gap={1}>
        <Text dimColor>│</Text>
        <Text dimColor>obj:</Text>
        <Text wrap="truncate">{handle.objective}</Text>
      </Box>

      {/* Activity divider */}
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          ACTIVITY
        </Text>
        <Text dimColor>{"─".repeat(15)}</Text>
      </Box>

      {/* Activity entries */}
      {visible.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>│ No activity yet...</Text>
        </Box>
      ) : (
        visible.map((entry, idx) => {
          const icon = TYPE_ICONS[entry.type] ?? "·";
          const color = TYPE_COLORS[entry.type] ?? "#9ca3af";
          const isLatest = idx === visible.length - 1;
          const isOld = idx < visible.length - 4;
          return (
            <Box key={entry.id} gap={1} paddingX={1}>
              <Text dimColor={isOld}>{formatTime(entry.timestamp)}</Text>
              <Text color={color} dimColor={isOld} bold={isLatest}>
                {icon}
              </Text>
              <Text dimColor={isOld} bold={isLatest} wrap="truncate">
                {entry.summary}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @neotx/cli build
```

Expected: BUILD SUCCESS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/components/child-detail.tsx
git commit -m "feat(tui): add ChildDetail component"
```

---

## Task 8: Create `ChildInput` component

**Files:**
- Create: `packages/cli/src/tui/components/child-input.tsx`

Three modes activated by keyboard shortcuts:
- `i` → inject context (sends `child:inject <id> <text>` to root inbox)
- `u` → unblock (sends `child:unblock <id> <text>`, only when status=blocked)
- `k` → kill with typed confirmation `"stop"` (sends `child:stop <id>`)

The parent controls which mode is active and passes callbacks.

```typescript
// packages/cli/src/tui/components/child-input.tsx
import type { ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export type ChildInputMode = "idle" | "inject" | "unblock" | "kill";

export function ChildInput({
  handle,
  mode,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  handle: ChildHandle;
  mode: ChildInputMode;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const isBlocked = handle.status === "blocked";

  if (mode === "idle") {
    return (
      <Box paddingX={1} gap={2} flexDirection="column">
        <Box paddingX={1} gap={1}>
          <Text dimColor>└</Text>
          <Text dimColor>
            <Text bold>i</Text> inject context
          </Text>
          <Text dimColor>·</Text>
          <Text dimColor={!isBlocked}>
            <Text bold={isBlocked}>u</Text> unblock{!isBlocked ? " (not blocked)" : ""}
          </Text>
          <Text dimColor>·</Text>
          <Text dimColor>
            <Text bold color="#f87171">
              k
            </Text>{" "}
            kill
          </Text>
          <Text dimColor>·</Text>
          <Text dimColor>
            <Text bold>esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode === "inject") {
    return (
      <Box flexDirection="column">
        <Box paddingX={1} gap={1}>
          <Text dimColor>└</Text>
          <Text color="#60a5fa" bold>
            INJECT
          </Text>
          <Text dimColor>→ {handle.supervisorId}</Text>
        </Box>
        <Box paddingX={1} gap={1}>
          <Text dimColor> </Text>
          <Text color="#60a5fa" bold>
            ❯
          </Text>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            focus
            placeholder="context to inject..."
          />
        </Box>
        <Box paddingX={1}>
          <Text dimColor>  enter send · esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "unblock") {
    return (
      <Box flexDirection="column">
        <Box paddingX={1} gap={1}>
          <Text dimColor>└</Text>
          <Text color="#fbbf24" bold>
            UNBLOCK
          </Text>
          <Text dimColor>→ {handle.supervisorId}</Text>
        </Box>
        <Box paddingX={1} gap={1}>
          <Text dimColor> </Text>
          <Text color="#fbbf24" bold>
            ❯
          </Text>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            focus
            placeholder="your answer..."
          />
        </Box>
        <Box paddingX={1}>
          <Text dimColor>  enter send · esc cancel</Text>
        </Box>
      </Box>
    );
  }

  // kill mode — requires typing "stop" to confirm
  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>└</Text>
        <Text color="#f87171" bold>
          KILL
        </Text>
        <Text dimColor>→ {handle.supervisorId}</Text>
        <Text dimColor>— type</Text>
        <Text bold color="#f87171">
          stop
        </Text>
        <Text dimColor>to confirm</Text>
      </Box>
      <Box paddingX={1} gap={1}>
        <Text dimColor> </Text>
        <Text color="#f87171" bold>
          ❯
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          placeholder='type "stop" to kill...'
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>  esc cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @neotx/cli build
```

Expected: BUILD SUCCESS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/components/child-input.tsx
git commit -m "feat(tui): add ChildInput component with inject/unblock/kill modes"
```

---

## Task 9: Rewrite supervisor-tui.tsx with split-screen layout

**Files:**
- Modify: `packages/cli/src/tui/supervisor-tui.tsx`

This is the main integration task. The existing single-column layout becomes a two-column split. Left column = existing root content (unchanged except height budget). Right column = ChildList + ChildDetail + ChildInput.

New state added:
- `children: ChildHandle[]` — polled from `children.json`
- `selectedChildIndex: number` — which child is focused in right column
- `childActivity: ActivityEntry[]` — activity of selected child
- `columnFocus: "left" | "right"` — which column has keyboard focus
- `childInputMode: ChildInputMode` — idle/inject/unblock/kill
- `childInputValue: string`

New polling: every 1.5s, also read `getSupervisorChildrenPath(name)` and activity of the selected child from `getFocusedSupervisorDir(child.supervisorId)/activity.jsonl`.

- [ ] **Step 1: Read the existing file to understand structure**

The file is at `packages/cli/src/tui/supervisor-tui.tsx` (already read above — 1019 lines).

- [ ] **Step 2: Write the new supervisor-tui.tsx**

Replace the file completely with the split-screen version:

```typescript
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActivityEntry,
  ChildHandle,
  Decision,
  InboxMessage,
  SupervisorDaemonState,
} from "@neotx/core";
import {
  DecisionStore,
  getFocusedSupervisorDir,
  getSupervisorActivityPath,
  getSupervisorChildrenPath,
  getSupervisorDecisionsPath,
  getSupervisorDir,
  getSupervisorInboxPath,
  getSupervisorStatePath,
  loadGlobalConfig,
  readChildrenFile,
  TaskStore,
} from "@neotx/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState } from "react";
import { ChildDetail } from "./components/child-detail.js";
import type { ChildInputMode } from "./components/child-input.js";
import { ChildInput } from "./components/child-input.js";
import { ChildList } from "./components/child-list.js";

// ─── Constants ───────────────────────────────────────────

const MAX_VISIBLE_ENTRIES = 20;
const MAX_CHILD_ACTIVITY = 12;
const POLL_INTERVAL_MS = 1_500;
const ANIMATION_TICK_MS = 400;

// ─── Unicode Visual Elements ─────────────────────────────

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BLOCK_FULL = "█";
const BLOCK_EMPTY = "░";
const PULSE_FRAMES = ["◉", "◎", "○", "◎"];
const IDLE_FRAMES = ["◌", "◌", "◌", "◌"];

const TYPE_ICONS: Record<string, string> = {
  heartbeat: "♥",
  decision: "★",
  action: "⚡",
  error: "✖",
  event: "◆",
  message: "✉",
  thinking: "◇",
  plan: "▸",
  dispatch: "↗",
  tool_use: "⊘",
};

const TYPE_COLORS: Record<string, string> = {
  heartbeat: "#6ee7b7",
  decision: "#fbbf24",
  action: "#60a5fa",
  error: "#f87171",
  event: "#c084fc",
  message: "#67e8f9",
  thinking: "#a78bfa",
  plan: "#34d399",
  dispatch: "#f472b6",
  tool_use: "#38bdf8",
};

const TYPE_LABELS: Record<string, string> = {
  heartbeat: "BEAT",
  decision: "DECIDE",
  action: "ACTION",
  error: "ERROR",
  event: "EVENT",
  message: "MSG",
  thinking: "THINK",
  plan: "PLAN",
  dispatch: "SEND",
  tool_use: "TOOL",
};

const TASK_STATUS_COLORS: Record<string, string> = {
  in_progress: "#60a5fa",
  blocked: "#f87171",
  pending: "#6b7280",
  done: "#4ade80",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  in_progress: "ACTIVE",
  blocked: "BLOCK",
  pending: "·",
};

// ─── Helpers ─────────────────────────────────────────────

function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTimeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function buildProgressBar(ratio: number, width: number): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filledCount = Math.round(clamped * width);
  return {
    filled: BLOCK_FULL.repeat(filledCount),
    empty: BLOCK_EMPTY.repeat(width - filledCount),
  };
}

function buildSparkline(values: number[], width: number): string {
  if (values.length === 0) return "▁".repeat(width);
  const recent = values.slice(-width);
  const max = Math.max(...recent, 0.001);
  return recent
    .map((v) => {
      const idx = Math.min(
        Math.floor((v / max) * (SPARK_CHARS.length - 1)),
        SPARK_CHARS.length - 1,
      );
      return SPARK_CHARS[idx];
    })
    .join("");
}

function extractCostHistory(entries: ActivityEntry[]): number[] {
  return entries
    .filter((e) => e.type === "heartbeat" && e.summary.includes("complete"))
    .map((e) => {
      const detail = e.detail as Record<string, unknown> | undefined;
      return typeof detail?.costUsd === "number" ? detail.costUsd : 0;
    });
}

// ─── Animated Hooks ──────────────────────────────────────

function useAnimationFrame(): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setFrame((f) => f + 1), ANIMATION_TICK_MS);
    return () => clearInterval(interval);
  }, []);
  return frame;
}

function useClock(): string {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(interval);
  }, []);
  return time;
}

// ─── Components ──────────────────────────────────────────

function Logo() {
  return (
    <Box paddingX={1} gap={1}>
      <Text color="#c084fc" bold>
        ◆
      </Text>
      <Text bold>
        <Text color="#c084fc">N</Text>
        <Text color="#a78bfa">E</Text>
        <Text color="#818cf8">O</Text>
      </Text>
      <Text dimColor>SUPERVISOR</Text>
    </Box>
  );
}

function LiveIndicator({ frame, isRunning }: { frame: number; isRunning: boolean }) {
  const frames = isRunning ? PULSE_FRAMES : IDLE_FRAMES;
  const dot = frames[frame % frames.length];
  return (
    <Box paddingX={1}>
      <Text color={isRunning ? "#4ade80" : "#6b7280"} bold>
        {dot}
      </Text>
      <Text color={isRunning ? "#4ade80" : "#6b7280"} bold>
        {" "}
        {isRunning ? "LIVE" : "IDLE"}
      </Text>
    </Box>
  );
}

function HeaderBar({
  state,
  name,
  frame,
  clock,
  columnFocus,
  childCount,
}: {
  state: SupervisorDaemonState | null;
  name: string;
  frame: number;
  clock: string;
  columnFocus: "left" | "right";
  childCount: number;
}) {
  if (!state) {
    return (
      <Box borderStyle="round" borderColor="#6b7280" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Logo />
          <Box paddingX={1}>
            <Text dimColor>{clock}</Text>
          </Box>
        </Box>
        <Box paddingX={1}>
          <Text color="#fbbf24">⟳ Connecting to "{name}"...</Text>
        </Box>
      </Box>
    );
  }

  const isRunning = state.status === "running";

  return (
    <Box
      borderStyle="round"
      borderColor={isRunning ? "#6ee7b7" : "#f87171"}
      paddingX={0}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Logo />
        <Box gap={2}>
          {childCount > 0 && (
            <Box paddingX={1} gap={1}>
              <Text dimColor>focus:</Text>
              <Text color="#c084fc" bold>
                {columnFocus === "left" ? "ROOT" : "CHILDREN"}
              </Text>
              <Text dimColor>(tab to switch)</Text>
            </Box>
          )}
          <LiveIndicator frame={frame} isRunning={isRunning} />
          <Box paddingX={1}>
            <Text dimColor>{clock}</Text>
          </Box>
        </Box>
      </Box>

      <Box paddingX={1} gap={1}>
        <Text dimColor>│</Text>
        <Text>
          <Text dimColor>pid</Text> <Text bold>{state.pid}</Text>
        </Text>
        <Text dimColor>·</Text>
        <Text>
          <Text dimColor>port</Text> <Text bold>:{state.port}</Text>
        </Text>
        <Text dimColor>·</Text>
        <Text>
          <Text dimColor>beats</Text>{" "}
          <Text bold color="#6ee7b7">
            ▲{state.heartbeatCount}
          </Text>
        </Text>
        {state.lastHeartbeat && (
          <>
            <Text dimColor>·</Text>
            <Text>
              <Text dimColor>last</Text> <Text>{formatTimeAgo(state.lastHeartbeat)}</Text>
            </Text>
          </>
        )}
        <Text dimColor>·</Text>
        <Text>
          <Text dimColor>up</Text> <Text>{formatUptime(state.startedAt)}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function BudgetPanel({
  state,
  dailyCap,
  costHistory,
}: {
  state: SupervisorDaemonState | null;
  dailyCap: number;
  costHistory: number[];
}) {
  if (!state) return null;

  const todayCost = state.todayCostUsd ?? 0;
  const totalCost = state.totalCostUsd ?? 0;
  const ratio = dailyCap > 0 ? todayCost / dailyCap : 0;
  const barWidth = 20;
  const bar = buildProgressBar(ratio, barWidth);
  const pct = Math.round(ratio * 100);
  const barColor = pct < 50 ? "#4ade80" : pct < 80 ? "#fbbf24" : "#f87171";
  const sparkline = buildSparkline(costHistory, 12);

  return (
    <Box paddingX={2} gap={2}>
      <Box gap={1}>
        <Text dimColor>budget</Text>
        <Text color={barColor}>{bar.filled}</Text>
        <Text dimColor>{bar.empty}</Text>
        <Text bold color={barColor}>
          {pct}%
        </Text>
        <Text dimColor>
          (${todayCost.toFixed(2)}/${dailyCap})
        </Text>
      </Box>
      <Text dimColor>│</Text>
      <Box gap={1}>
        <Text dimColor>total</Text>
        <Text bold>${totalCost.toFixed(2)}</Text>
      </Box>
      <Text dimColor>│</Text>
      <Box gap={1}>
        <Text dimColor>cost/beat</Text>
        <Text color="#818cf8">{sparkline}</Text>
      </Box>
    </Box>
  );
}

function ActivityRow({
  entry,
  isLatest,
  isOld,
}: {
  entry: ActivityEntry;
  isLatest: boolean;
  isOld: boolean;
}) {
  const icon = TYPE_ICONS[entry.type] ?? "·";
  const color = TYPE_COLORS[entry.type] ?? "#9ca3af";
  const label = (TYPE_LABELS[entry.type] ?? (entry.type as string).toUpperCase()).padEnd(7);

  return (
    <Box gap={1} paddingX={2}>
      <Text dimColor={isOld}>│</Text>
      <Text dimColor={isOld}>{formatTime(entry.timestamp)}</Text>
      <Text color={color} dimColor={isOld} bold={isLatest}>
        {icon}
      </Text>
      <Text color={color} dimColor={isOld} bold>
        {label}
      </Text>
      <Text dimColor={isOld} bold={isLatest}>
        {entry.summary}
      </Text>
    </Box>
  );
}

function DecisionBanner({ decisions, frame }: { decisions: Decision[]; frame: number }) {
  if (decisions.length === 0) return null;
  const pulseChars = ["★", "☆"];
  const pulse = pulseChars[frame % pulseChars.length];
  return (
    <Box paddingX={2} gap={1}>
      <Text dimColor>├</Text>
      <Text color="#fbbf24" bold>
        {pulse} {decisions.length} decision{decisions.length > 1 ? "s" : ""} pending
      </Text>
      <Text dimColor>
        — press <Text bold>tab</Text> to review
      </Text>
    </Box>
  );
}

function DecisionInputPanel({
  decision,
  optionIndex,
  isTextMode,
  textInput,
  onTextChange,
  onSubmit,
  decisionCount,
  decisionIdx,
  frame,
}: {
  decision: Decision;
  optionIndex: number;
  isTextMode: boolean;
  textInput: string;
  onTextChange: (v: string) => void;
  onSubmit: (v: string) => void;
  decisionCount: number;
  decisionIdx: number;
  frame: number;
}) {
  const hasOptions = decision.options && decision.options.length > 0;
  const pulseChars = ["★", "☆"];
  const pulse = pulseChars[frame % pulseChars.length];

  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#fbbf24" bold>
          {pulse} DECISION
        </Text>
        {decisionCount > 1 && (
          <Text color="#fbbf24">
            ({decisionIdx + 1}/{decisionCount})
          </Text>
        )}
        <Text dimColor>{"─".repeat(30)}</Text>
      </Box>
      <Box paddingX={2} gap={1}>
        <Text dimColor>│</Text>
        <Text bold wrap="truncate-end">
          {decision.question}
        </Text>
      </Box>
      {decision.context && (
        <Box paddingX={2} gap={1}>
          <Text dimColor>│</Text>
          <Text dimColor wrap="truncate-end">
            {decision.context}
          </Text>
        </Box>
      )}
      {hasOptions ? (
        <Box flexDirection="column">
          {(decision.options ?? []).map((opt, idx) => {
            const isSelected = idx === optionIndex;
            return (
              <Box key={opt.key} paddingX={2} gap={1}>
                <Text dimColor>│</Text>
                {isSelected ? (
                  <Text color="#fbbf24" bold>
                    ▸ {opt.label}
                  </Text>
                ) : (
                  <Text dimColor>
                    {"  "}
                    {opt.label}
                  </Text>
                )}
                {opt.description && isSelected && <Text dimColor>— {opt.description}</Text>}
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box paddingX={2} gap={1}>
          <Text dimColor>│</Text>
          <Text color="#fbbf24" bold>
            ❯
          </Text>
          <TextInput
            value={textInput}
            onChange={onTextChange}
            onSubmit={onSubmit}
            focus={isTextMode}
            placeholder="type your answer..."
          />
        </Box>
      )}
      <Box paddingX={2} gap={1}>
        <Text dimColor>└</Text>
        <Text dimColor>
          {hasOptions ? (
            <>
              <Text bold>↑↓</Text> choose · <Text bold>enter</Text> confirm
            </>
          ) : (
            <>
              <Text bold>enter</Text> send
            </>
          )}
          {decisionCount > 1 && (
            <>
              {" · "}
              <Text bold>←→</Text> prev/next
            </>
          )}
          {" · "}
          <Text bold>tab</Text> back
        </Text>
      </Box>
    </Box>
  );
}

const ACTIVITY_TYPES = new Set([
  "heartbeat",
  "decision",
  "action",
  "dispatch",
  "error",
  "event",
  "message",
]);

function ActivityPanel({ entries, maxVisible }: { entries: ActivityEntry[]; maxVisible: number }) {
  const filtered = entries.filter((e) => ACTIVITY_TYPES.has(e.type));
  const visible = filtered.slice(-maxVisible);

  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          ACTIVITY
        </Text>
        <Text dimColor>{"─".repeat(30)}</Text>
      </Box>
      {visible.length === 0 ? (
        <Box paddingX={2}>
          <Text dimColor>│ Waiting for heartbeats...</Text>
        </Box>
      ) : (
        visible.map((entry, idx) => (
          <ActivityRow
            key={entry.id}
            entry={entry}
            isLatest={idx === visible.length - 1}
            isOld={idx < visible.length - 5}
          />
        ))
      )}
      <Box paddingX={2}>
        <Text dimColor>│</Text>
      </Box>
    </Box>
  );
}

function TaskPanel({
  tasks,
}: {
  tasks: Array<{
    id: string;
    title: string;
    status?: string;
    priority?: string;
    scope: string;
    runId?: string;
  }>;
}) {
  const active = tasks.filter((t) => t.status !== "done" && t.status !== "abandoned");
  const doneCount = tasks.filter((t) => t.status === "done").length;

  if (tasks.length === 0) return null;

  const MAX_VISIBLE = 4;
  const visible = active.slice(0, MAX_VISIBLE);
  const overflow = active.length - visible.length;

  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          TASKS
        </Text>
        <Text dimColor>
          ({active.length} active, {doneCount} done)
        </Text>
        <Text dimColor>{"─".repeat(20)}</Text>
      </Box>
      {visible.map((t) => {
        const status = t.status ?? "pending";
        const color = TASK_STATUS_COLORS[status] ?? "#6b7280";
        const label = (TASK_STATUS_LABELS[status] ?? "·").padEnd(6);
        const prio = t.priority ? `[${t.priority.slice(0, 3)}] ` : "";
        const repo = t.scope !== "global" ? path.basename(t.scope) : "";
        const run = t.runId ? `run:${t.runId.slice(0, 4)}` : "";
        const meta = [repo, run].filter(Boolean).join(" ");
        return (
          <Box key={t.id} gap={1} paddingX={2}>
            <Text dimColor>│</Text>
            <Text color={color} bold>
              {label}
            </Text>
            {prio && <Text dimColor>{prio.padEnd(5)}</Text>}
            <Text wrap="truncate">{t.title}</Text>
            {meta && <Text dimColor>({meta})</Text>}
          </Box>
        );
      })}
      {overflow > 0 && (
        <Box paddingX={2}>
          <Text dimColor>│ ... +{overflow} more pending</Text>
        </Box>
      )}
    </Box>
  );
}

function InputPanel({
  value,
  onChange,
  onSubmit,
  lastSent,
  focus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  lastSent: string;
  focus: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>└</Text>
        <Text bold color="#60a5fa">
          ❯
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
          placeholder="message the supervisor..."
        />
      </Box>
      <Box paddingX={2} gap={1}>
        <Text dimColor> </Text>
        {lastSent ? <Text color="#6b7280">✓ "{lastSent}"</Text> : null}
      </Box>
    </Box>
  );
}

// ─── Data Fetching ───────────────────────────────────────

async function readState(name: string): Promise<SupervisorDaemonState | null> {
  try {
    const raw = await readFile(getSupervisorStatePath(name), "utf-8");
    return JSON.parse(raw) as SupervisorDaemonState;
  } catch {
    return null;
  }
}

async function readActivity(name: string, maxEntries: number): Promise<ActivityEntry[]> {
  try {
    const content = await readFile(getSupervisorActivityPath(name), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const lastLines = lines.slice(-maxEntries);
    const entries: ActivityEntry[] = [];
    for (const line of lastLines) {
      try {
        entries.push(JSON.parse(line) as ActivityEntry);
      } catch {
        // skip malformed line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function readChildActivity(supervisorId: string, maxEntries: number): Promise<ActivityEntry[]> {
  const activityPath = path.join(getFocusedSupervisorDir(supervisorId), "activity.jsonl");
  try {
    const content = await readFile(activityPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const lastLines = lines.slice(-maxEntries);
    const entries: ActivityEntry[] = [];
    for (const line of lastLines) {
      try {
        entries.push(JSON.parse(line) as ActivityEntry);
      } catch {
        // skip malformed line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function readTasks(name: string): ReturnType<typeof TaskStore.prototype.getTasks> {
  try {
    const dir = getSupervisorDir(name);
    const store = new TaskStore(path.join(dir, "tasks.sqlite"));
    const tasks = store.getTasks();
    store.close();
    return tasks.slice(0, 20);
  } catch {
    return [];
  }
}

async function readDecisions(name: string): Promise<Decision[]> {
  try {
    const store = new DecisionStore(getSupervisorDecisionsPath(name));
    return await store.pending();
  } catch {
    return [];
  }
}

async function appendToJsonl(filePath: string, data: unknown): Promise<boolean> {
  const dir = path.dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(data)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function writeToInbox(name: string, message: InboxMessage): Promise<boolean> {
  return appendToJsonl(getSupervisorInboxPath(name), message);
}

async function answerDecision(name: string, id: string, answer: string): Promise<void> {
  const store = new DecisionStore(getSupervisorDecisionsPath(name));
  await store.answer(id, answer);
  const inboxMessage: InboxMessage = {
    id: randomUUID(),
    from: "tui",
    text: `decision:answer ${id} ${answer}`,
    timestamp: new Date().toISOString(),
  };
  await writeToInbox(name, inboxMessage);
}

async function sendMessage(name: string, text: string): Promise<void> {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const message: InboxMessage = { id, from: "tui", text, timestamp };
  await writeToInbox(name, message);
  const activityEntry: ActivityEntry = { id, type: "message", summary: text, timestamp };
  await appendToJsonl(getSupervisorActivityPath(name), activityEntry);
}

// ─── Main Component ──────────────────────────────────────

export function SupervisorTui({ name }: { name: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const frame = useAnimationFrame();
  const clock = useClock();

  // Root supervisor state
  const [state, setState] = useState<SupervisorDaemonState | null>(null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [tasks, setTasks] = useState<ReturnType<typeof readTasks>>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [dailyCap, setDailyCap] = useState(50);
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [termHeight, setTermHeight] = useState(stdout?.rows ?? 30);

  // Decision interaction state
  const [decisionIndex, setDecisionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [decisionAnswer, setDecisionAnswer] = useState("");
  const [focusMode, setFocusMode] = useState<"input" | "decisions">("input");

  // Child supervisor state
  const [children, setChildren] = useState<ChildHandle[]>([]);
  const [selectedChildIndex, setSelectedChildIndex] = useState(0);
  const [childActivity, setChildActivity] = useState<ActivityEntry[]>([]);
  const [columnFocus, setColumnFocus] = useState<"left" | "right">("left");
  const [childInputMode, setChildInputMode] = useState<ChildInputMode>("idle");
  const [childInputValue, setChildInputValue] = useState("");

  // Track terminal resize
  useEffect(() => {
    function onResize() {
      if (stdout) setTermHeight(stdout.rows);
    }
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  // Load daily cap
  useEffect(() => {
    loadGlobalConfig()
      .then((cfg) => setDailyCap(cfg.supervisor.dailyCapUsd))
      .catch(() => {});
  }, []);

  // Poll root supervisor data
  useEffect(() => {
    let active = true;
    async function poll() {
      if (!active) return;
      const [newState, newEntries, newDecisions, newChildren] = await Promise.all([
        readState(name),
        readActivity(name, MAX_VISIBLE_ENTRIES),
        readDecisions(name),
        readChildrenFile(getSupervisorChildrenPath(name)),
      ]);
      if (!active) return;
      setState(newState);
      setEntries(newEntries);
      setDecisions(newDecisions);
      setTasks(readTasks(name));
      setChildren(newChildren);
      if (newDecisions.length > 0 && decisionIndex >= newDecisions.length) {
        setDecisionIndex(0);
      }
      if (newDecisions.length > 0 && decisions.length === 0) {
        setFocusMode("decisions");
      }
      if (newDecisions.length === 0 && decisions.length > 0) {
        setFocusMode("input");
      }
    }
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(interval); };
  }, [name, decisionIndex, decisions.length]);

  // Poll selected child activity
  const selectedChild = children[selectedChildIndex] as ChildHandle | undefined;

  useEffect(() => {
    if (!selectedChild) {
      setChildActivity([]);
      return;
    }
    let active = true;
    async function pollChildActivity() {
      if (!active || !selectedChild) return;
      const activity = await readChildActivity(selectedChild.supervisorId, MAX_CHILD_ACTIVITY);
      if (active) setChildActivity(activity);
    }
    pollChildActivity();
    const interval = setInterval(pollChildActivity, POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(interval); };
  }, [selectedChild?.supervisorId]);

  // Keyboard handler
  const currentDecision = decisions[decisionIndex] as Decision | undefined;
  const currentHasOptions = (currentDecision?.options?.length ?? 0) > 0;

  const submitDecisionAnswer = useCallback(
    async (answer: string) => {
      if (!answer.trim() || !currentDecision) return;
      try {
        await answerDecision(name, currentDecision.id, answer.trim());
        setLastSent(`Decision ${currentDecision.id.slice(4, 12)}: "${answer.trim()}"`);
        setDecisionAnswer("");
        setOptionIndex(0);
      } catch {
        // ignore
      }
    },
    [name, currentDecision],
  );

  const handleOptionNav = useCallback(
    (key: { upArrow: boolean; downArrow: boolean; return: boolean }): boolean => {
      const options = currentDecision?.options;
      if (!options || options.length === 0) return false;
      if (key.upArrow) { setOptionIndex((i) => Math.max(0, i - 1)); return true; }
      if (key.downArrow) { setOptionIndex((i) => Math.min(options.length - 1, i + 1)); return true; }
      if (key.return) { const opt = options[optionIndex]; if (opt) submitDecisionAnswer(opt.key); return true; }
      return false;
    },
    [currentDecision, optionIndex, submitDecisionAnswer],
  );

  const handleChildInputSubmit = useCallback(
    async (value: string) => {
      if (!selectedChild) return;
      const id = selectedChild.supervisorId;
      let text: string | null = null;

      if (childInputMode === "inject" && value.trim()) {
        text = `child:inject ${id} ${value.trim()}`;
      } else if (childInputMode === "unblock" && value.trim()) {
        text = `child:unblock ${id} ${value.trim()}`;
      } else if (childInputMode === "kill" && value.trim().toLowerCase() === "stop") {
        text = `child:stop ${id}`;
      }

      if (text) {
        const message: InboxMessage = {
          id: randomUUID(),
          from: "tui",
          text,
          timestamp: new Date().toISOString(),
        };
        await writeToInbox(name, message);
        setLastSent(text.slice(0, 40));
      }

      setChildInputMode("idle");
      setChildInputValue("");
    },
    [name, selectedChild, childInputMode],
  );

  useInput((_char, key) => {
    // ── Global: Tab switches column if children exist, or toggles decisions ──
    if (key.tab) {
      if (children.length > 0 && focusMode !== "decisions") {
        if (columnFocus === "left") {
          setColumnFocus("right");
          setChildInputMode("idle");
        } else {
          setColumnFocus("left");
          setChildInputMode("idle");
        }
        return;
      }
      if (decisions.length > 0) {
        setFocusMode((m) => (m === "input" ? "decisions" : "input"));
        setOptionIndex(0);
        return;
      }
    }

    // ── Global: Escape ──
    if (key.escape) {
      if (childInputMode !== "idle") { setChildInputMode("idle"); setChildInputValue(""); return; }
      if (columnFocus === "right") { setColumnFocus("left"); return; }
      if (focusMode === "decisions") { setFocusMode("input"); return; }
      exit();
      return;
    }

    // ── Right column (children) ──
    if (columnFocus === "right" && children.length > 0) {
      if (childInputMode !== "idle") return; // TextInput handles input

      if (key.upArrow) {
        setSelectedChildIndex((i) => Math.max(0, i - 1));
        setChildActivity([]);
        return;
      }
      if (key.downArrow) {
        setSelectedChildIndex((i) => Math.min(children.length - 1, i + 1));
        setChildActivity([]);
        return;
      }

      const char = _char.toLowerCase();
      if (char === "i") { setChildInputMode("inject"); setChildInputValue(""); return; }
      if (char === "u" && selectedChild?.status === "blocked") {
        setChildInputMode("unblock"); setChildInputValue(""); return;
      }
      if (char === "k") { setChildInputMode("kill"); setChildInputValue(""); return; }
      return;
    }

    // ── Left column (root decisions) ──
    if (focusMode === "decisions" && decisions.length > 0) {
      if (currentHasOptions && handleOptionNav(key)) return;
      if (decisions.length > 1) {
        if (key.leftArrow) { setDecisionIndex((i) => Math.max(0, i - 1)); setOptionIndex(0); }
        else if (key.rightArrow) { setDecisionIndex((i) => Math.min(decisions.length - 1, i + 1)); setOptionIndex(0); }
      }
    }
  });

  const handleRootSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      sendMessage(name, text.trim());
      setLastSent(text.trim());
      setInput("");
    },
    [name],
  );

  const costHistory = extractCostHistory(entries);

  // Height budgeting
  const headerLines = 4;
  const budgetLines = 1;
  const inputLines = focusMode === "decisions" && currentDecision
    ? (currentHasOptions ? (currentDecision.options?.length ?? 0) : 1) + 4
    : 3;
  const taskLines = tasks.length > 0 ? Math.min(tasks.filter((t) => t.status !== "done" && t.status !== "abandoned").length, 4) + 2 : 0;
  const activityLines = Math.max(5, termHeight - headerLines - budgetLines - inputLines - taskLines - 2);

  // Root column bottom panel
  const rootBottomPanel =
    focusMode === "decisions" && currentDecision ? (
      <DecisionInputPanel
        decision={currentDecision}
        optionIndex={optionIndex}
        isTextMode={!currentHasOptions}
        textInput={decisionAnswer}
        onTextChange={setDecisionAnswer}
        onSubmit={submitDecisionAnswer}
        decisionCount={decisions.length}
        decisionIdx={decisionIndex}
        frame={frame}
      />
    ) : (
      <InputPanel
        value={input}
        onChange={setInput}
        onSubmit={handleRootSubmit}
        lastSent={lastSent}
        focus={columnFocus === "left" && focusMode === "input"}
      />
    );

  const hasChildren = children.length > 0;

  return (
    <Box flexDirection="column">
      <HeaderBar
        state={state}
        name={name}
        frame={frame}
        clock={clock}
        columnFocus={columnFocus}
        childCount={children.length}
      />
      <BudgetPanel state={state} dailyCap={dailyCap} costHistory={costHistory} />

      {/* Main split-screen body */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left column: root supervisor */}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexBasis={hasChildren ? "50%" : "100%"}
          borderStyle={hasChildren && columnFocus === "left" ? "single" : undefined}
          borderColor="#c084fc"
        >
          {focusMode !== "decisions" && <DecisionBanner decisions={decisions} frame={frame} />}
          <TaskPanel tasks={tasks} />
          <ActivityPanel entries={entries} maxVisible={activityLines} />
          {rootBottomPanel}
        </Box>

        {/* Right column: children (only when children exist) */}
        {hasChildren && (
          <Box
            flexDirection="column"
            flexGrow={1}
            flexBasis="50%"
            borderStyle={columnFocus === "right" ? "single" : undefined}
            borderColor="#c084fc"
          >
            <ChildList children={children} selectedIndex={selectedChildIndex} />
            {selectedChild && (
              <>
                <ChildDetail
                  handle={selectedChild}
                  activity={childActivity}
                  maxActivityLines={MAX_CHILD_ACTIVITY}
                />
                <ChildInput
                  handle={selectedChild}
                  mode={childInputMode}
                  value={childInputValue}
                  onChange={setChildInputValue}
                  onSubmit={handleChildInputSubmit}
                  onCancel={() => { setChildInputMode("idle"); setChildInputValue(""); }}
                />
              </>
            )}
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={2} gap={1} justifyContent="center">
        <Text dimColor>
          <Text bold>esc</Text> quit
        </Text>
        {hasChildren && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>
              <Text bold>tab</Text> switch panel
            </Text>
          </>
        )}
        {decisions.length > 0 && columnFocus === "left" && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>
              <Text bold>tab</Text> decisions
            </Text>
          </>
        )}
        <Text dimColor>·</Text>
        <Text dimColor>daemon keeps running</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Build CLI package**

```bash
pnpm --filter @neotx/cli build
```

Expected: BUILD SUCCESS, no TypeScript errors

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tui/supervisor-tui.tsx
git commit -m "feat(tui): split-screen layout with child supervisor monitoring and control"
```

---

## Task 10: Final build verification and spec review

**Files:** none (verification only)

- [ ] **Step 1: Full build**

```bash
pnpm build && pnpm typecheck
```

Expected: BUILD SUCCESS, TYPECHECK PASS

- [ ] **Step 2: Full test suite**

```bash
pnpm test
```

Expected: PASS (all tests)

- [ ] **Step 3: Verify new exports are available from @neotx/core**

```bash
node --input-type=module <<'EOF'
import { readChildrenFile, getSupervisorChildrenPath } from "@neotx/core";
console.log("readChildrenFile:", typeof readChildrenFile);
console.log("getSupervisorChildrenPath:", getSupervisorChildrenPath("test"));
EOF
```

Expected:
```
readChildrenFile: function
getSupervisorChildrenPath: /Users/<you>/.neo/supervisors/test/children.json
```

- [ ] **Step 4: Commit if any cleanup needed, otherwise tag**

```bash
git add -A
git commit -m "chore: final build verification for supervisor TUI split-screen"
```

---

## Self-Review

**Spec coverage:**
- ✅ Split-screen root/children layout → Task 9
- ✅ children.json bridge between daemon and TUI → Tasks 1-3
- ✅ ChildList with status badges → Task 6
- ✅ ChildDetail with activity feed → Task 7
- ✅ ChildInput with inject/unblock/kill → Task 8
- ✅ child:* inbox message routing via heartbeat → Task 4
- ✅ Exports from @neotx/core → Task 5
- ✅ Tab to switch columns → Task 9 (keyboard handler)
- ✅ ↑↓ to navigate child list → Task 9
- ✅ Kill with "stop" confirmation → Task 8 + Task 9
- ✅ Unblock only active when status=blocked → Task 8

**Placeholder scan:** none found.

**Type consistency:**
- `ChildHandle` defined in `schemas.ts`, used in Tasks 2, 3, 5, 6, 7, 8, 9 — consistent
- `readChildrenFile(filePath: string): Promise<ChildHandle[]>` defined in Task 2, exported in Task 5, called in Task 9
- `getSupervisorChildrenPath(name: string): string` defined in Task 1, exported in Task 5, called in Task 9
- `ChildInputMode` exported from `child-input.tsx`, imported in `supervisor-tui.tsx`
- `getFocusedSupervisorDir` already exported from `@neotx/core` (confirmed in index.ts) — used in Task 9 `readChildActivity`
