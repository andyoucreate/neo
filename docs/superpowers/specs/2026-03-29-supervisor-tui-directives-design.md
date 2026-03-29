# Supervisor TUI — Directives Panel & Full UX Overhaul

**Date:** 2026-03-29
**Scope:** `packages/cli/src/tui/`

---

## Context

The supervisor TUI (`supervisor-tui.tsx`) has several compounding issues:

1. **No directives visibility** — `DirectiveStore` is fully implemented in `@neotx/core` but invisible at runtime
2. **Broken keyboard routing** — `tab` has two incompatible roles; auto-switch to decisions interrupts typing
3. **Fragile height calculation** — manual `termHeight - N` math breaks when panels resize
4. **Inconsistent footer** — `esc quit` shown even when `esc` does something else
5. **Duplicated constants** — `TYPE_ICONS`, `TYPE_COLORS`, `STATUS_COLORS`, helpers duplicated across files
6. **Decision text truncated** — `wrap="truncate-end"` cuts long questions/context
7. **Monolithic `useInput`** — all key routing in one 35-line block with nested conditions

---

## Goals

1. Add full directives management (view, create, toggle, delete) via a dedicated mode
2. Fix keyboard routing — introduce a clean mode system, remove ambiguous `tab` behavior
3. Fix decision panel — no auto-switch, no text truncation
4. Replace fragile height math with flex layout
5. Centralize shared constants
6. Add contextual status bar (hints reflect current mode)
7. Add children total cost in ChildList header

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `tui/constants.ts` | Shared `TYPE_ICONS`, `TYPE_COLORS`, `TYPE_LABELS`, `STATUS_COLORS`, `formatTime`, `formatTimeAgo` |
| `tui/components/directives-panel.tsx` | Directives list: `↑↓` nav, `x` toggle, `del`/`y`/`n` delete confirm, `n` new |
| `tui/components/directive-form.tsx` | 3-step creation wizard: trigger → action → duration |
| `tui/hooks/use-keyboard-router.ts` | Dispatches key events to the active mode handler |

### Modified files

| File | Change |
|------|--------|
| `supervisor-tui.tsx` | Mode system, flex layout, contextual status bar, directive banner, decision banner upgrade, wire new components |
| `child-detail.tsx` | Import from `constants.ts`, remove local duplicates |
| `child-list.tsx` | Import from `constants.ts`, add total cost in header |

---

## Mode System

Replace `focusMode: "input" | "decisions"` + `columnFocus: "left" | "right"` with a single unified mode:

```ts
type TuiMode =
  | "normal"       // default — left column focused, input active
  | "decisions"    // decision panel replaces activity
  | "directives"   // directives panel replaces activity
  | "children"     // right column focused (children nav)
```

### Mode transitions

| From | Key | To |
|------|-----|----|
| `normal` | `tab` (children exist) | `children` |
| `normal` | `d` | `directives` |
| `normal` | (decision arrives) | stays `normal` — shows urgent banner |
| `normal` | `*` (decision pending) | `decisions` |
| `decisions` | `esc` / `tab` | `normal` |
| `directives` | `esc` | `normal` |
| `children` | `tab` / `esc` | `normal` |

**No more auto-switch on decision arrival.** Instead show an urgent pulsing banner. User explicitly presses `*` (or configurable key) to enter decisions mode.

---

## Feature: Directives

### Compact banner (normal mode, always visible)

Rendered between TaskPanel and ActivityPanel:

```
├ DIRECTIVES (2) ──────────────────── d to manage ──
│ ◉ idle    Review open PRs if CI green
│ ◉ startup Check error logs
```

- Max 2 lines; if more: `… +N more`
- If 0 directives: `│ No directives — press d to add one`

### Directives mode (`d` key) — list state

Replaces ActivityPanel. Tasks and header remain visible.

```
├ DIRECTIVES (3) ─────────────────────────────────────────
▶ ◉ idle    Review open PRs if CI green               ∞
  ◉ startup Check error logs                           ∞
  ○ idle    Run daily standup report                  exp

+ add new directive
└ ↑↓ select · x toggle · del delete · n new · esc close
```

- `◉` enabled (green), `○` disabled (gray), `exp` expired (red dim)
- `∞` = no expiry, otherwise `1h 23m` remaining
- `x` → `DirectiveStore.toggle(id, !enabled)`
- `del` → inline `delete? y/n` confirmation → `DirectiveStore.delete(id)`
- `n` → form state

### Directives mode — form state (3 steps)

**Step 1 — Trigger (arrow nav):**
```
├ NEW DIRECTIVE ─────────────────────────────────────────
│ Step 1/3: When should this trigger?
▶ idle      When the supervisor has no active tasks
  startup   When the supervisor starts up
  shutdown  Before the supervisor shuts down
└ ↑↓ select · enter confirm · esc cancel
```

**Step 2 — Action (text input):**
```
├ NEW DIRECTIVE ─────────────────────────────────────────
│ trigger: idle
│ Step 2/3: What should the supervisor do?
❯ [text input]
└ enter confirm · esc back
```

**Step 3 — Duration (text input, default "indefinitely"):**
```
├ NEW DIRECTIVE ─────────────────────────────────────────
│ trigger: idle · action: Review open PRs...
│ Step 3/3: How long? (2h, 30m, 7d, indefinitely)
❯ indefinitely
└ enter confirm · esc back
```

On confirm: `DirectiveStore.create({ trigger, action, expiresAt: parseDirectiveDuration(duration) })`.

---

## Feature: Decision Panel Fix

### No more auto-switch

Remove this from the poll loop:
```ts
// REMOVE
if (newDecisions.length > 0 && decisionsLengthRef.current === 0) {
  setFocusMode("decisions");
}
```

### Upgraded decision banner

Replace the subtle single-line banner with a visually distinct urgent banner:

```
╭─ ★ 2 DECISIONS PENDING ── press * to review ──────────╮
```

- Amber border (`#fbbf24`), bold, full-width
- Pulses on the `★` character
- Disappears when decisions are resolved

### Fixed text truncation

In `DecisionInputPanel`, replace `wrap="truncate-end"` with `wrap="wrap"` on both `decision.question` and `decision.context`. Allow up to 5 lines for question, 3 for context.

---

## Feature: Layout Fix (no more manual height math)

Remove:
```ts
const leftActivityMaxVisible = Math.max(
  5,
  Math.min(MAX_VISIBLE_ENTRIES, termHeight - 10 - taskPanelLines - decisionPanelLines),
);
```

Replace with: `ActivityPanel` uses `flexGrow={1}` and a fixed `MAX_VISIBLE_ENTRIES = 24` cap. Ink handles the rest. The terminal resize listener (`stdout.on("resize")`) can be removed too — it was only feeding `termHeight`.

---

## Feature: Contextual Status Bar

Replace the static footer with a `StatusBar` component that renders hints based on current mode:

```ts
const STATUS_BAR_HINTS: Record<TuiMode, string> = {
  normal: "esc quit · tab children · d directives · * decisions",
  decisions: "↑↓ options · enter confirm · ←→ next · esc back",
  directives: "↑↓ select · x toggle · del delete · n new · esc close",
  children: "↑↓ select · i inject · u unblock · k kill · esc back",
};
```

When decisions are pending in `normal` mode, append `· * N decisions pending`.

---

## Feature: Children Total Cost

In `ChildList` header, add aggregated cost:

```
├ CHILDREN (3) · total $4.20 ──────────────────────────
```

Computed from `handles.reduce((sum, h) => sum + h.costUsd, 0)`.

---

## Data Access

```ts
async function readDirectives(name: string): Promise<Directive[]> {
  const dir = getSupervisorDir(name);
  const store = new DirectiveStore(path.join(dir, "directives.jsonl"));
  return store.list();
}
```

Directives polled at `POLL_INTERVAL_MS` alongside state/activity/decisions/children.
Mutations call `DirectiveStore` directly — file-based, daemon picks up on next heartbeat.

---

## Keyboard Map (complete)

| Key | Mode | Action |
|-----|------|--------|
| `esc` | `normal` (left focused) | Exit TUI |
| `esc` | `children` | → `normal` |
| `esc` | `decisions` | → `normal` |
| `esc` | `directives` list | → `normal` |
| `esc` | `directives` form step 1 | → `normal` |
| `esc` | `directives` form step 2-3 | → previous step |
| `tab` | `normal` (children exist) | → `children` |
| `tab` | `children` | → `normal` |
| `d` | `normal` | → `directives` |
| `*` | `normal` (decisions pending) | → `decisions` |
| `↑↓` | `decisions` (options) | Navigate options |
| `enter` | `decisions` | Confirm answer |
| `←→` | `decisions` (multiple) | Prev/next decision |
| `↑↓` | `directives` list | Navigate rows |
| `x` | `directives` list | Toggle enable/disable |
| `del` | `directives` list | Start delete confirm (Ink: `key.delete` or `char === '\x7f'`) |
| `y` / `n` | `directives` delete confirm | Confirm / cancel |
| `n` | `directives` list | Open form |
| `↑↓` | `directives` form step 1 | Select trigger |
| `enter` | `directives` form | Confirm step |
| `↑↓` | `children` | Navigate child rows |
| `i` | `children` | Inject context |
| `u` | `children` (blocked) | Unblock |
| `k` | `children` | Kill (type "stop") |

---

## Component Interface Sketches

### `DirectivesPanel`
```ts
type DirectivesPanelProps = {
  directives: Directive[];
  selectedIndex: number;
  confirmingDelete: string | null;
};
```

### `DirectiveForm`
```ts
type DirectiveFormProps = {
  step: 1 | 2 | 3;
  trigger: DirectiveTrigger | null;
  triggerOptionIndex: number;
  action: string;
  duration: string;
  onActionChange: (v: string) => void;
  onDurationChange: (v: string) => void;
  focus: boolean;
};
```

### `StatusBar`
```ts
type StatusBarProps = {
  mode: TuiMode;
  decisionCount: number;
};
```

---

## Out of Scope

- Editing an existing directive in-TUI (use CLI)
- Activity scroll (separate future feature)
- Priority field in directive form (use CLI for advanced options)
