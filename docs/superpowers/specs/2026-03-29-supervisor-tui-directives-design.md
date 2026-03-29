# Supervisor TUI — Directives Panel & UX Redesign

**Date:** 2026-03-29
**Scope:** `packages/cli/src/tui/`

---

## Context

The supervisor TUI (`supervisor-tui.tsx`) has no way to view or manage persistent directives, even though `DirectiveStore` is fully implemented in `@neotx/core`. Directives (idle/startup/shutdown triggers) are a core feature but invisible at runtime.

Secondary issues:
- `TYPE_ICONS` and `TYPE_COLORS` are duplicated between `supervisor-tui.tsx` and `child-detail.tsx`
- `supervisor-tui.tsx` is ~1200 lines; adding directives without extraction would make it harder to maintain

---

## Goals

1. Add a full directives management panel to the TUI (view, create, toggle, delete)
2. Extract shared constants and the new panels into dedicated component files
3. Keep existing keyboard navigation and rendering behavior intact

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `tui/constants.ts` | Shared `TYPE_ICONS`, `TYPE_COLORS`, `TYPE_LABELS`, `STATUS_COLORS`, helper functions (`formatTime`, `formatTimeAgo`) |
| `tui/components/directives-panel.tsx` | List view: shows all directives with status, handles `↑↓` / `x` / `del` keys |
| `tui/components/directive-form.tsx` | 3-step creation wizard: trigger → action → duration |

### Modified files

| File | Change |
|------|--------|
| `supervisor-tui.tsx` | Import constants from `constants.ts`; add `directivesMode` state; wire `d` key; render `DirectivesPanel` or `DirectiveForm` in place of Activity when in directives mode; add compact directive banner in normal mode |
| `child-detail.tsx` | Import constants from `constants.ts` instead of local definitions |

---

## Feature: Directives View

### Normal mode (always visible)

Between the TaskPanel and ActivityPanel, a compact **DirectivesBanner** shows:

```
├ DIRECTIVES (2) ──────────────────── d to manage ──
│ ◉ idle    Review open PRs if CI green
│ ◉ startup Check error logs
```

- Max 2 lines shown; if more exist, shows `… +N more`
- If 0 directives: shows `│ No directives — press d to add one`
- Hint `d to manage` always visible in the section header

### Directives mode (`d` key)

Replaces the ActivityPanel (Tasks and header remain). The panel has two sub-states:

**List state (default):**

```
├ DIRECTIVES (3) ─────────────────────────────────────────
▶ ◉ idle    Review open PRs if CI green               ∞
  ◉ startup Check error logs                           ∞
  ○ idle    Run daily standup report                  exp

│
+ add new directive
│
└ ↑↓ select · x toggle · del delete · n new · esc close
```

- `◉` = enabled (green), `○` = disabled (gray), `exp` = expired (red)
- `∞` = no expiry, otherwise shows remaining time (e.g. `1h 23m`)
- `▶` marks selected row
- Disabled/expired rows are dimmed
- `x`: toggles enabled/disabled on selected directive (calls `DirectiveStore.toggle`)
- `del`: prompts inline `delete? (y/n)` then calls `DirectiveStore.delete`
- `n`: enters form state
- `esc`: returns to normal mode

**Delete confirmation (inline):**

```
▶ ◉ idle    Review open PRs if CI green               ∞
  delete? y/n
```

### Directives form (`n` key)

3-step guided wizard, rendered below the list header.

**Step 1 — Trigger:**
```
├ NEW DIRECTIVE ──────────────────────────────────────────
│ Step 1/3: When should this trigger?
│
▶ idle      When the supervisor has no active tasks
  startup   When the supervisor starts up
  shutdown  Before the supervisor shuts down
│
└ ↑↓ select · enter confirm · esc cancel
```

**Step 2 — Action:**
```
├ NEW DIRECTIVE ──────────────────────────────────────────
│ trigger: idle
│
│ Step 2/3: What should the supervisor do?
❯ [text input — free form]
│
└ enter confirm · esc back
```

**Step 3 — Duration:**
```
├ NEW DIRECTIVE ──────────────────────────────────────────
│ trigger: idle · action: Review open PRs...
│
│ Step 3/3: How long? (2h, 30m, 7d, indefinitely)
❯ indefinitely
│
└ enter confirm · esc back
```

On final `enter`: calls `DirectiveStore.create({ trigger, action, expiresAt })` using existing `parseDirectiveDuration`. Returns to list state.

---

## Data Access

The TUI reads directives via polling (same `POLL_INTERVAL_MS = 1500ms` as other data).

```ts
// New read function in supervisor-tui.tsx
async function readDirectives(name: string): Promise<Directive[]> {
  const dir = getSupervisorDir(name);
  const store = new DirectiveStore(path.join(dir, "directives.jsonl"));
  return store.list();
}
```

Mutations (toggle, delete, create) call `DirectiveStore` methods directly — no inbox message needed, the store is file-based and the daemon reads it on the next heartbeat.

---

## Keyboard Map (complete, updated)

| Key | Context | Action |
|-----|---------|--------|
| `d` | normal mode, left column | Open directives view |
| `esc` | directives list | Return to normal mode |
| `↑↓` | directives list | Navigate rows |
| `x` | directives list, row selected | Toggle enabled/disabled |
| `del` | directives list, row selected | Inline delete confirmation (Ink: `key.delete` or `char === '\x7f'`) |
| `y/n` | delete confirmation | Confirm / cancel delete |
| `n` | directives list | Open creation form |
| `↑↓` | form step 1 | Select trigger |
| `enter` | form any step | Confirm and advance |
| `esc` | form any step | Go back one step (or cancel) |
| `tab` | normal mode | Switch column focus (left/right) |
| `tab` | decisions pending | Switch to decision mode |
| `esc` | decision mode | Return to input mode |
| `esc` | normal mode, left focus | Exit TUI |

---

## Component Interface Sketches

### `DirectivesPanel`

```ts
type DirectivesPanelProps = {
  directives: Directive[];
  selectedIndex: number;
  confirmingDelete: string | null; // directive id being confirmed
};
```

Renders the list. Pure display — all state lives in `supervisor-tui.tsx`.

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

Renders the current step. Input focus and submission handled by parent.

---

## Performance Notes

- No new polling interval — directives piggyback on the existing `POLL_INTERVAL_MS` poll
- `DirectiveStore` reads are async file I/O — acceptable at 1.5s interval
- Animation frame hook (`useAnimationFrame`) unchanged — directives view has no animation
- No `useMemo`/`useCallback` additions needed beyond what exists

---

## Out of Scope

- Editing an existing directive (description/action change) — use CLI
- Priority field in the form — use CLI for advanced options
- Directive history / audit log
