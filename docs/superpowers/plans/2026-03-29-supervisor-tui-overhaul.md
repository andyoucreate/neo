# Supervisor TUI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the supervisor TUI with a clean mode system, full directives management, fixed decision panel, and centralized constants.

**Architecture:** Extract shared constants into `tui/constants.ts`, add `directives-panel.tsx` + `directive-form.tsx` components, introduce a unified `TuiMode` type replacing the two-variable focus system, and replace fragile height math with flex layout.

**Tech Stack:** TypeScript, React (Ink), `ink-text-input`, `@neotx/core` (`DirectiveStore`, `parseDirectiveDuration`, `getSupervisorDir`)

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `packages/cli/src/tui/constants.ts` | Shared icons, colors, labels, format helpers |
| Create | `packages/cli/src/tui/components/directives-panel.tsx` | Directives list view (nav, toggle, delete confirm) |
| Create | `packages/cli/src/tui/components/directive-form.tsx` | 3-step creation wizard |
| Modify | `packages/cli/src/tui/components/child-detail.tsx` | Import from constants.ts, remove local duplicates |
| Modify | `packages/cli/src/tui/components/child-list.tsx` | Import from constants.ts, add total cost |
| Modify | `packages/cli/src/tui/supervisor-tui.tsx` | Mode system, flex layout, status bar, directive banner, decision banner, wire directives |

---

## Task 1: Create `tui/constants.ts` — shared constants and helpers

**Files:**
- Create: `packages/cli/src/tui/constants.ts`

- [ ] **Step 1: Create the file**

```ts
// packages/cli/src/tui/constants.ts

export const TYPE_ICONS: Record<string, string> = {
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

export const TYPE_COLORS: Record<string, string> = {
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

export const TYPE_LABELS: Record<string, string> = {
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

export const STATUS_COLORS: Record<string, string> = {
  running: "#4ade80",
  blocked: "#fbbf24",
  stalled: "#f97316",
  complete: "#818cf8",
  failed: "#f87171",
};

export const STATUS_ICONS: Record<string, string> = {
  running: "●",
  blocked: "◆",
  stalled: "◌",
  complete: "✓",
  failed: "✖",
};

export const STATUS_LABELS: Record<string, string> = {
  running: "RUN",
  blocked: "BLK",
  stalled: "STL",
  complete: "DONE",
  failed: "FAIL",
};

export function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
}

export function formatTimeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -30
```

Expected: no errors related to `constants.ts`

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/constants.ts
git commit -m "feat(tui): add shared constants module"
```

---

## Task 2: Update `child-detail.tsx` and `child-list.tsx` to use shared constants

**Files:**
- Modify: `packages/cli/src/tui/components/child-detail.tsx`
- Modify: `packages/cli/src/tui/components/child-list.tsx`

- [ ] **Step 1: Update `child-detail.tsx`**

Replace the entire file content (the local `TYPE_ICONS`, `TYPE_COLORS`, `STATUS_COLORS`, `formatTime`, `formatTimeAgo` declarations are removed; imported instead):

```tsx
import type { ActivityEntry, ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";
import {
  STATUS_COLORS,
  TYPE_COLORS,
  TYPE_ICONS,
  formatTime,
  formatTimeAgo,
} from "../constants.js";

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

- [ ] **Step 2: Update `child-list.tsx`**

Replace the entire file content (remove local `STATUS_COLORS`, `STATUS_ICONS`, `STATUS_LABELS`; import from constants; add total cost in header):

```tsx
import type { ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";
import { STATUS_COLORS, STATUS_ICONS, STATUS_LABELS } from "../constants.js";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function ChildRow({ handle, isSelected }: { handle: ChildHandle; isSelected: boolean }) {
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
  handles,
  selectedIndex,
}: {
  handles: ChildHandle[];
  selectedIndex: number;
}) {
  if (handles.length === 0) {
    return (
      <Box paddingX={2}>
        <Text dimColor>No focused supervisors running</Text>
      </Box>
    );
  }

  const totalCost = handles.reduce((sum, h) => sum + h.costUsd, 0);

  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          CHILDREN
        </Text>
        <Text dimColor>({handles.length})</Text>
        <Text dimColor>·</Text>
        <Text dimColor>total</Text>
        <Text dimColor>${totalCost.toFixed(2)}</Text>
        <Text dimColor>{"─".repeat(14)}</Text>
      </Box>
      {handles.map((handle, idx) => (
        <ChildRow key={handle.supervisorId} handle={handle} isSelected={idx === selectedIndex} />
      ))}
    </Box>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/tui/components/child-detail.tsx packages/cli/src/tui/components/child-list.tsx
git commit -m "refactor(tui): use shared constants in child-detail and child-list"
```

---

## Task 3: Create `directives-panel.tsx`

**Files:**
- Create: `packages/cli/src/tui/components/directives-panel.tsx`

- [ ] **Step 1: Create the file**

```tsx
// packages/cli/src/tui/components/directives-panel.tsx
import type { Directive } from "@neotx/core";
import { Box, Text } from "ink";

function formatRemaining(expiresAt: string | undefined): string {
  if (!expiresAt) return "∞";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "exp";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function DirectiveRow({
  directive,
  isSelected,
  isConfirmingDelete,
}: {
  directive: Directive;
  isSelected: boolean;
  isConfirmingDelete: boolean;
}) {
  const isExpired = directive.expiresAt
    ? new Date(directive.expiresAt).getTime() < Date.now()
    : false;
  const isActive = directive.enabled && !isExpired;
  const dim = !isActive;

  const statusIcon = isActive ? "◉" : "○";
  const statusColor = isActive ? "#4ade80" : "#6b7280";
  const triggerStr = directive.trigger.padEnd(8);
  const remaining = formatRemaining(directive.expiresAt);
  const remainingColor = remaining === "exp" ? "#f87171" : "#6b7280";

  if (isConfirmingDelete) {
    return (
      <Box gap={1} paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text color="#c084fc">▶</Text>
          <Text color={statusColor}>{statusIcon}</Text>
          <Text dimColor>{triggerStr}</Text>
          <Text dimColor={dim} wrap="truncate">
            {directive.action}
          </Text>
        </Box>
        <Box gap={1} paddingX={2}>
          <Text dimColor>│</Text>
          <Text color="#f87171" bold>
            delete? y/n
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box gap={1} paddingX={1}>
      <Text color={isSelected ? "#c084fc" : "#4b5563"}>{isSelected ? "▶" : " "}</Text>
      <Text color={statusColor}>{statusIcon}</Text>
      <Text dimColor>{triggerStr}</Text>
      <Text dimColor={dim} wrap="truncate">
        {directive.action}
      </Text>
      <Text color={remainingColor}>{remaining}</Text>
    </Box>
  );
}

export function DirectivesPanel({
  directives,
  selectedIndex,
  confirmingDelete,
}: {
  directives: Directive[];
  selectedIndex: number;
  confirmingDelete: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#fbbf24" bold>
          DIRECTIVES
        </Text>
        <Text dimColor>({directives.length})</Text>
        <Text dimColor>{"─".repeat(40)}</Text>
      </Box>

      {directives.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>│ No directives — press n to add one</Text>
        </Box>
      ) : (
        directives.map((d, idx) => (
          <DirectiveRow
            key={d.id}
            directive={d}
            isSelected={idx === selectedIndex}
            isConfirmingDelete={confirmingDelete === d.id}
          />
        ))
      )}

      <Box paddingX={1}>
        <Text dimColor>│</Text>
      </Box>
      <Box paddingX={1} gap={1}>
        <Text color="#60a5fa" dimColor>
          + add new directive (n)
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/components/directives-panel.tsx
git commit -m "feat(tui): add DirectivesPanel component"
```

---

## Task 4: Create `directive-form.tsx`

**Files:**
- Create: `packages/cli/src/tui/components/directive-form.tsx`

- [ ] **Step 1: Create the file**

```tsx
// packages/cli/src/tui/components/directive-form.tsx
import type { DirectiveTrigger } from "@neotx/core";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

const TRIGGERS: Array<{ value: DirectiveTrigger; description: string }> = [
  { value: "idle", description: "When the supervisor has no active tasks" },
  { value: "startup", description: "When the supervisor starts up" },
  { value: "shutdown", description: "Before the supervisor shuts down" },
];

export type DirectiveFormProps = {
  step: 1 | 2 | 3;
  trigger: DirectiveTrigger | null;
  triggerOptionIndex: number;
  action: string;
  duration: string;
  onActionChange: (v: string) => void;
  onDurationChange: (v: string) => void;
  focus: boolean;
};

export function DirectiveForm({
  step,
  trigger,
  triggerOptionIndex,
  action,
  duration,
  onActionChange,
  onDurationChange,
  focus,
}: DirectiveFormProps) {
  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#fbbf24" bold>
          NEW DIRECTIVE
        </Text>
        <Text dimColor>{"─".repeat(40)}</Text>
      </Box>

      {step === 1 && (
        <>
          <Box paddingX={1} gap={1}>
            <Text dimColor>│</Text>
            <Text>Step 1/3: When should this trigger?</Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>│</Text>
          </Box>
          {TRIGGERS.map((t, idx) => {
            const isSelected = idx === triggerOptionIndex;
            return (
              <Box key={t.value} paddingX={1} gap={1}>
                <Text color={isSelected ? "#c084fc" : "#4b5563"}>{isSelected ? "▶" : " "}</Text>
                <Text color={isSelected ? "#4ade80" : "#6b7280"} bold={isSelected}>
                  {t.value.padEnd(9)}
                </Text>
                <Text dimColor={!isSelected}>{t.description}</Text>
              </Box>
            );
          })}
          <Box paddingX={1}>
            <Text dimColor>│</Text>
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor>└</Text>
            <Text dimColor>
              <Text bold>↑↓</Text> select · <Text bold>enter</Text> confirm ·{" "}
              <Text bold>esc</Text> cancel
            </Text>
          </Box>
        </>
      )}

      {step === 2 && (
        <>
          <Box paddingX={1} gap={1}>
            <Text dimColor>│</Text>
            <Text dimColor>trigger:</Text>
            <Text color="#4ade80">{trigger}</Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>│</Text>
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor>│</Text>
            <Text>Step 2/3: What should the supervisor do?</Text>
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor> </Text>
            <Text color="#60a5fa" bold>
              ❯
            </Text>
            <TextInput
              value={action}
              onChange={onActionChange}
              onSubmit={() => {}}
              focus={focus}
              placeholder="describe the action..."
            />
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor>└</Text>
            <Text dimColor>
              <Text bold>enter</Text> confirm · <Text bold>esc</Text> back
            </Text>
          </Box>
        </>
      )}

      {step === 3 && (
        <>
          <Box paddingX={1} gap={1}>
            <Text dimColor>│</Text>
            <Text dimColor>trigger:</Text>
            <Text color="#4ade80">{trigger}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>action:</Text>
            <Text wrap="truncate">{action.slice(0, 30)}{action.length > 30 ? "…" : ""}</Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>│</Text>
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor>│</Text>
            <Text>Step 3/3: How long?</Text>
            <Text dimColor>(2h, 30m, 7d, indefinitely)</Text>
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor> </Text>
            <Text color="#60a5fa" bold>
              ❯
            </Text>
            <TextInput
              value={duration}
              onChange={onDurationChange}
              onSubmit={() => {}}
              focus={focus}
              placeholder="indefinitely"
            />
          </Box>
          <Box paddingX={1} gap={1}>
            <Text dimColor>└</Text>
            <Text dimColor>
              <Text bold>enter</Text> confirm · <Text bold>esc</Text> back
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/components/directive-form.tsx
git commit -m "feat(tui): add DirectiveForm wizard component"
```

---

## Task 5: Overhaul `supervisor-tui.tsx` — mode system + layout + status bar + decision fixes

This is the largest task. Read the current file carefully before editing.

**Files:**
- Modify: `packages/cli/src/tui/supervisor-tui.tsx`

### What to change

**A) Add `TuiMode` type and replace dual focus state:**

Remove:
```ts
const [focusMode, setFocusMode] = useState<"input" | "decisions">("input");
const [columnFocus, setColumnFocus] = useState<"left" | "right">("left");
```

Add:
```ts
type TuiMode = "normal" | "decisions" | "directives" | "children";
const [mode, setMode] = useState<TuiMode>("normal");
```

**B) Add directive state:**

```ts
const [directives, setDirectives] = useState<Directive[]>([]);
const [directiveSelectedIndex, setDirectiveSelectedIndex] = useState(0);
const [directiveConfirmingDelete, setDirectiveConfirmingDelete] = useState<string | null>(null);
const [directiveFormStep, setDirectiveFormStep] = useState<1 | 2 | 3 | null>(null);
const [directiveFormTriggerIndex, setDirectiveFormTriggerIndex] = useState(0);
const [directiveFormAction, setDirectiveFormAction] = useState("");
const [directiveFormDuration, setDirectiveFormDuration] = useState("");
```

**C) Add `readDirectives` function (near other read functions):**

```ts
async function readDirectives(name: string): Promise<Directive[]> {
  try {
    const dir = getSupervisorDir(name);
    const store = new DirectiveStore(path.join(dir, "directives.jsonl"));
    return await store.list();
  } catch (err) {
    console.debug(`[tui] Failed to read directives for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
```

**D) Add directives to the poll loop** — inside the existing `poll()` function, add `readDirectives(name)` to the `Promise.all`:

```ts
const [newState, newEntries, newDecisions, newChildren, newDirectives] = await Promise.all([
  readState(name),
  readActivity(name, MAX_VISIBLE_ENTRIES),
  readDecisions(name),
  readChildrenFile(getSupervisorChildrenPath(name)).catch(() => [] as ChildHandle[]),
  readDirectives(name),
]);
// ...existing setState calls...
setDirectives(newDirectives);
```

**E) Remove auto-switch to decisions** — delete these lines from the poll:

```ts
// DELETE THESE:
if (newDecisions.length > 0 && decisionsLengthRef.current === 0) {
  setFocusMode("decisions");
}
if (newDecisions.length === 0 && decisionsLengthRef.current > 0) {
  setFocusMode("input");
}
```

**F) Remove terminal resize state** — delete:

```ts
// DELETE:
const [termHeight, setTermHeight] = useState(stdout?.rows ?? 30);
// DELETE:
useEffect(() => {
  function onResize() { if (stdout) setTermHeight(stdout.rows); }
  stdout?.on("resize", onResize);
  return () => { stdout?.off("resize", onResize); };
}, [stdout]);
```

And remove the fragile height calculation block:
```ts
// DELETE the entire block:
const activeTaskCount = ...
const taskPanelLines = ...
const decisionPanelLines = ...
const leftActivityMaxVisible = ...
```

Replace `ActivityPanel` call with fixed cap: `<ActivityPanel entries={entries} maxVisible={MAX_VISIBLE_ENTRIES} />`

**G) Replace `useStdout` import** — `stdout` is no longer needed for resize; remove it from the destructured `useStdout()` call (or remove the import entirely if unused).

**H) Rewrite `useInput`** — replace the entire `useInput` block with the new mode-aware router:

```ts
useInput((char, key) => {
  // Directives form — highest priority input capture
  if (mode === "directives" && directiveFormStep !== null) {
    if (key.escape) {
      if (directiveFormStep === 1) {
        setDirectiveFormStep(null);
      } else {
        setDirectiveFormStep((s) => (s !== null && s > 1 ? ((s - 1) as 1 | 2 | 3) : null));
      }
      return;
    }
    if (directiveFormStep === 1) {
      if (key.upArrow) { setDirectiveFormTriggerIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setDirectiveFormTriggerIndex((i) => Math.min(2, i + 1)); return; }
      if (key.return) {
        const triggers = ["idle", "startup", "shutdown"] as const;
        setDirectiveFormStep(2);
        return;
      }
    }
    if (directiveFormStep === 2 && key.return && directiveFormAction.trim()) {
      setDirectiveFormStep(3);
      return;
    }
    if (directiveFormStep === 3 && key.return) {
      const triggers = ["idle", "startup", "shutdown"] as const;
      const trigger = triggers[directiveFormTriggerIndex];
      const dir = getSupervisorDir(name);
      const store = new DirectiveStore(path.join(dir, "directives.jsonl"));
      const expiresAt = parseDirectiveDuration(directiveFormDuration || "indefinitely");
      store.create({ trigger, action: directiveFormAction.trim(), expiresAt }).catch(console.error);
      setDirectiveFormStep(null);
      setDirectiveFormAction("");
      setDirectiveFormDuration("");
      setDirectiveFormTriggerIndex(0);
      return;
    }
    return; // TextInput handles the rest
  }

  // Global escape
  if (key.escape) {
    if (directiveConfirmingDelete) { setDirectiveConfirmingDelete(null); return; }
    if (mode === "directives") { setMode("normal"); return; }
    if (mode === "decisions") { setMode("normal"); return; }
    if (mode === "children") { setMode("normal"); return; }
    if (childInputMode !== "idle") { setChildInputMode("idle"); setChildInputValue(""); return; }
    exit();
    return;
  }

  // Tab: toggle between normal and children
  if (key.tab && hasChildren && mode !== "decisions") {
    setMode((m) => (m === "children" ? "normal" : "children"));
    return;
  }

  // Mode-specific keys
  if (mode === "normal") {
    if (char === "d") { setMode("directives"); return; }
    if (char === "*" && decisions.length > 0) { setMode("decisions"); setOptionIndex(0); return; }
    return;
  }

  if (mode === "decisions") {
    handleDecisionKey(key);
    return;
  }

  if (mode === "directives") {
    if (directiveConfirmingDelete) {
      if (char === "y") {
        const dir = getSupervisorDir(name);
        const store = new DirectiveStore(path.join(dir, "directives.jsonl"));
        store.delete(directiveConfirmingDelete).catch(console.error);
        setDirectiveConfirmingDelete(null);
        setDirectiveSelectedIndex(0);
      } else if (char === "n") {
        setDirectiveConfirmingDelete(null);
      }
      return;
    }
    if (key.upArrow) { setDirectiveSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setDirectiveSelectedIndex((i) => Math.min(directives.length - 1, i + 1)); return; }
    if (char === "x" && directives[directiveSelectedIndex]) {
      const d = directives[directiveSelectedIndex];
      const dir = getSupervisorDir(name);
      const store = new DirectiveStore(path.join(dir, "directives.jsonl"));
      store.toggle(d.id, !d.enabled).catch(console.error);
      return;
    }
    if ((key.delete || char === "\x7f") && directives[directiveSelectedIndex]) {
      setDirectiveConfirmingDelete(directives[directiveSelectedIndex].id);
      return;
    }
    if (char === "n") {
      setDirectiveFormStep(1);
      setDirectiveFormTriggerIndex(0);
      setDirectiveFormAction("");
      setDirectiveFormDuration("");
      return;
    }
    return;
  }

  if (mode === "children" && childInputMode === "idle") {
    handleRightColumnKey(char, key);
    return;
  }
});
```

**I) Add `DirectivesBanner` component** (in-file, above `SupervisorTui`):

```tsx
function DirectivesBanner({ directives }: { directives: Directive[] }) {
  const active = directives.filter(
    (d) => d.enabled && (!d.expiresAt || new Date(d.expiresAt).getTime() > Date.now()),
  );
  const shown = active.slice(0, 2);
  const overflow = active.length - shown.length;

  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#fbbf24" bold>
          DIRECTIVES
        </Text>
        <Text dimColor>({active.length})</Text>
        <Text dimColor>{"─".repeat(20)}</Text>
        <Text dimColor>d to manage</Text>
      </Box>
      {active.length === 0 ? (
        <Box paddingX={1} gap={1}>
          <Text dimColor>│</Text>
          <Text dimColor>No directives — press d to add one</Text>
        </Box>
      ) : (
        <>
          {shown.map((d) => (
            <Box key={d.id} paddingX={1} gap={1}>
              <Text dimColor>│</Text>
              <Text color="#4ade80">◉</Text>
              <Text dimColor>{d.trigger.padEnd(8)}</Text>
              <Text wrap="truncate">{d.action}</Text>
            </Box>
          ))}
          {overflow > 0 && (
            <Box paddingX={1} gap={1}>
              <Text dimColor>│</Text>
              <Text dimColor>… +{overflow} more</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
```

**J) Replace `DecisionBanner` with the upgraded urgent banner:**

```tsx
function DecisionBanner({ decisions, frame }: { decisions: Decision[]; frame: number }) {
  if (decisions.length === 0) return null;
  const pulseChars = ["★", "☆"];
  const pulse = pulseChars[frame % pulseChars.length];
  return (
    <Box borderStyle="round" borderColor="#fbbf24" paddingX={1}>
      <Text color="#fbbf24" bold>
        {pulse} {decisions.length} decision{decisions.length > 1 ? "s" : ""} pending
      </Text>
      <Text dimColor> — press </Text>
      <Text bold>*</Text>
      <Text dimColor> to review</Text>
    </Box>
  );
}
```

**K) Add `StatusBar` component** (replaces the static footer):

```tsx
type TuiMode = "normal" | "decisions" | "directives" | "children";

function StatusBar({ mode, decisionCount }: { mode: TuiMode; decisionCount: number }) {
  const hints: Record<TuiMode, string> = {
    normal: "esc quit · tab children · d directives",
    decisions: "↑↓ options · enter confirm · ←→ next · esc back",
    directives: "↑↓ select · x toggle · del delete · n new · esc close",
    children: "↑↓ select · i inject · u unblock · k kill · esc back",
  };

  return (
    <Box paddingX={2} gap={1} justifyContent="center">
      <Text dimColor>{hints[mode]}</Text>
      {mode === "normal" && decisionCount > 0 && (
        <>
          <Text dimColor>·</Text>
          <Text color="#fbbf24" bold>
            * {decisionCount} decision{decisionCount > 1 ? "s" : ""}
          </Text>
        </>
      )}
      <Text dimColor>· daemon keeps running</Text>
    </Box>
  );
}
```

**L) Update the render return** — wire everything together:

```tsx
// Determine what to show in the main content area
const isDirectivesMode = mode === "directives";
const isDecisionsMode = mode === "decisions";
const isChildrenMode = mode === "children";

const mainContent = isDirectivesMode ? (
  directiveFormStep !== null ? (
    <DirectiveForm
      step={directiveFormStep}
      trigger={["idle", "startup", "shutdown"][directiveFormTriggerIndex] as DirectiveTrigger}
      triggerOptionIndex={directiveFormTriggerIndex}
      action={directiveFormAction}
      duration={directiveFormDuration}
      onActionChange={setDirectiveFormAction}
      onDurationChange={setDirectiveFormDuration}
      focus={true}
    />
  ) : (
    <DirectivesPanel
      directives={directives}
      selectedIndex={directiveSelectedIndex}
      confirmingDelete={directiveConfirmingDelete}
    />
  )
) : isDecisionsMode && currentDecision ? (
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
  <>
    <ActivityPanel entries={entries} maxVisible={MAX_VISIBLE_ENTRIES} />
    <InputPanel
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      lastSent={lastSent}
      focus={mode === "normal"}
    />
  </>
);

return (
  <Box flexDirection="column">
    <HeaderBar
      state={state}
      name={name}
      frame={frame}
      clock={clock}
      columnFocus={isChildrenMode ? "right" : "left"}
      childCount={children.length}
    />
    <BudgetPanel state={state} dailyCap={dailyCap} costHistory={costHistory} />
    {decisions.length > 0 && mode !== "decisions" && (
      <DecisionBanner decisions={decisions} frame={frame} />
    )}
    <Box flexDirection="row" flexGrow={1}>
      {/* Left column */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexBasis={hasChildren ? "50%" : "100%"}
        borderStyle={hasChildren && !isChildrenMode ? "single" : undefined}
        borderColor="#c084fc"
      >
        <TaskPanel tasks={tasks} />
        {!isDirectivesMode && !isDecisionsMode && (
          <DirectivesBanner directives={directives} />
        )}
        {mainContent}
      </Box>

      {/* Right column — only when children exist */}
      {hasChildren && (
        <Box
          flexDirection="column"
          flexGrow={1}
          flexBasis="50%"
          borderStyle={isChildrenMode ? "single" : undefined}
          borderColor="#c084fc"
        >
          <ChildList handles={children} selectedIndex={selectedChildIndex} />
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
              />
            </>
          )}
        </Box>
      )}
    </Box>
    <StatusBar mode={mode} decisionCount={decisions.length} />
  </Box>
);
```

**M) Update imports** at the top of `supervisor-tui.tsx`:

- Add: `import { Directive, DirectiveStore, DirectiveTrigger, parseDirectiveDuration } from "@neotx/core";`
- Add: `import { DirectivesPanel } from "./components/directives-panel.js";`
- Add: `import { DirectiveForm } from "./components/directive-form.js";`
- Remove local definitions of `TYPE_ICONS`, `TYPE_COLORS`, `TYPE_LABELS`, `STATUS_COLORS` (now in `constants.ts`, but only needed if still referenced — check usage after changes)

- [ ] **Step 1: Apply all changes described above to `supervisor-tui.tsx`**

Read the file from top to bottom, apply each change (A through M) in order.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -50
```

Expected: no errors. If errors appear, fix them before continuing.

- [ ] **Step 3: Run full build**

```bash
cd /Users/karl/Documents/neo && pnpm build 2>&1 | tail -20
```

Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/tui/supervisor-tui.tsx
git commit -m "feat(tui): mode system, directives panel, fixed decisions, flex layout, status bar"
```

---

## Task 6: Fix decision text truncation

**Files:**
- Modify: `packages/cli/src/tui/supervisor-tui.tsx` (the `DecisionInputPanel` component)

- [ ] **Step 1: Find and update the question and context lines in `DecisionInputPanel`**

Find the question render (around line 503 in original):
```tsx
// BEFORE
<Text bold wrap="truncate-end">
  {decision.question}
</Text>
```

Change to:
```tsx
// AFTER
<Text bold wrap="wrap">
  {decision.question}
</Text>
```

Find the context render (around line 512):
```tsx
// BEFORE
<Text dimColor wrap="truncate-end">
  {decision.context}
</Text>
```

Change to:
```tsx
// AFTER
<Text dimColor wrap="wrap">
  {decision.context}
</Text>
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/supervisor-tui.tsx
git commit -m "fix(tui): wrap decision question and context text instead of truncating"
```

---

## Task 7: Final validation

- [ ] **Step 1: Full validation pass**

```bash
cd /Users/karl/Documents/neo && pnpm build && pnpm typecheck && pnpm test 2>&1 | tail -30
```

Expected: build passes, typecheck passes, tests pass (no regressions in core tests)

- [ ] **Step 2: Manual smoke test checklist**

Run `neo supervise <name>` and verify:
- [ ] Normal mode shows compact directive banner between Tasks and Activity
- [ ] Pressing `d` opens directives view
- [ ] `n` in directives opens the 3-step form
- [ ] Form step 1: `↑↓` selects trigger, `enter` advances, `esc` cancels
- [ ] Form step 2: text input works, `enter` advances, `esc` goes back
- [ ] Form step 3: text input works, `enter` creates directive and returns to list
- [ ] Newly created directive appears in list after next poll (≤1.5s)
- [ ] `x` on a directive toggles enabled/disabled
- [ ] `del` / `y` deletes the directive
- [ ] `del` / `n` cancels the deletion
- [ ] `esc` returns to normal mode
- [ ] When decisions exist, amber banner shows with `*` hint
- [ ] Pressing `*` opens decision panel (no auto-switch)
- [ ] Decision text wraps correctly (no truncation)
- [ ] `tab` switches to children panel when children exist
- [ ] Status bar hints update with mode
- [ ] Footer shows `esc quit` only in normal mode

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -p
git commit -m "chore(tui): cleanup after TUI overhaul"
```
