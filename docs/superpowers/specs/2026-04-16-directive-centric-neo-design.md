# Directive-Centric Neo — Design Spec

**Date:** 2026-04-16
**Status:** Draft
**Approach:** B — Network of Peers

## Vision

Transform neo from a single-supervisor system into a **directive-driven network of peer supervisors**. Directives become the central primitive for piloting supervisor behavior — behaviour-as-configuration. Supervisors can spawn children, communicate with peers, and self-organize around scoped work.

### Core principles

- **Directive = the API** — supervisors are programmed by their active directives, not by code changes
- **Additive, not breaking** — a solo supervisor with no peers works identically to today
- **Zero infrastructure** — inter-supervisor communication is `appendFile` to inbox. No message broker, no RPC, no shared database
- **Controlled autonomy** — peers whitelist, depth counter, budget isolation prevent runaway behavior

## Section 1: Directive Profiles

### Problem

Directives are a flat list. No grouping, no batch activation, no concept of "mode".

### Solution

A `DirectiveProfile` is a named group of directives with lifecycle metadata.

```typescript
interface DirectiveProfile {
  id: string;                          // prof_<uuid_12chars>
  name: string;                        // "refactoring-mode", "api-sprint"
  description?: string;
  enabled: boolean;                    // atomic toggle for entire profile
  directives: DirectiveCreateInput[];  // the profile's directives
  createdAt: string;
  expiresAt?: string;                  // profile-level expiration
  activatedAt?: string;               // when last activated
}
```

### Behavior

- **Activate profile** — creates all its directives in the existing `DirectiveStore`, tagged with `profileId`
- **Deactivate profile** — disables all linked directives (batch toggle)
- **Profile expired** — all linked directives auto-disabled
- **`DirectiveStore` remains single source of truth** — profiles are a grouping layer above it, not a parallel store

### Storage

New file `profiles.jsonl` in the supervisor directory. Same JSONL pattern as everything else.

### Directive schema change

Add optional field to existing `Directive`:

```typescript
interface Directive {
  // ...existing fields...
  profileId?: string;  // link to parent profile (undefined = standalone)
}
```

### CLI

```bash
neo profile create refactoring-mode \
  --directive "Refactor files > 200 lines" \
  --directive "Split components with multiple responsibilities" \
  --expires "7d"

neo profile list
neo profile activate refactoring-mode
neo profile deactivate refactoring-mode
neo profile delete refactoring-mode
```

### Impact on existing code

- `Directive` schema: add optional `profileId` field
- `DirectiveStore.active()`: filter out directives whose parent profile is disabled/expired
- `prompt-builder`: unchanged — still receives `Directive[]`
- New: `ProfileStore` class (~150 lines), same JSONL pattern as `DirectiveStore`

---

## Section 2: Supervisor Identity

### Problem

Supervisors are anonymous daemons. No parentage, no peer awareness, no budget isolation.

### Solution

Each supervisor carries an identity defined at launch.

```typescript
interface SupervisorIdentity {
  name: string;              // "main", "frontend-lead"
  parent?: string;           // parent supervisor name (undefined = root)
  peers: string[];           // communication whitelist
  budgetSliceUsd?: number;   // dedicated budget (deducted from parent)
  directiveProfile?: string; // profile activated at boot
  expiresAt?: string;        // supervisor TTL
  spawnedAt?: string;        // creation timestamp
}
```

### Launch

```bash
# Root supervisor (unchanged from today)
neo supervise --name main

# Child with full identity
neo supervise --name frontend-lead \
  --parent main \
  --peers backend-lead \
  --budget 30 \
  --directives refactoring-mode \
  --expires 48h
```

Without `--parent` or `--peers`, the supervisor works exactly as today. Fully backward compatible.

### Storage

Identity is persisted in the existing `state.json`:

```
~/.neo/supervisor/
├── main/
│   ├── state.json   # { ...existing, identity: { name: "main", peers: ["*"] } }
│   └── ...
├── frontend-lead/
│   ├── state.json   # { ...existing, identity: { name: "frontend-lead", parent: "main", ... } }
│   └── ...
```

### Budget isolation

```
main: dailyCap = $500
  └── frontend-lead: budgetSlice = $30
  └── backend-lead: budgetSlice = $50
  → main effective: $500 - $30 - $50 = $420
```

- Parent's `budgetGuard` deducts active children's slices. Discovery: parent scans `~/.neo/supervisor/*/state.json` for entries where `identity.parent === self.name` and `status === "running"`. Sum of their `budgetSliceUsd` is deducted from parent's effective cap.
- Each child has its own `budgetGuard` with `budgetSliceUsd` as cap
- Cost journals are independent (each daemon already has its own directory)

### Lifecycle

- **Spawn** — parent or human runs `neo supervise --name X --parent Y`. Daemon starts, writes identity to `state.json`, activates directive profile.
- **Expiration** — heartbeat checks `expiresAt` each tick. If expired, transitions to `DRAINING` (finish active runs, no new dispatches), then `STOPPED`.
- **Kill by parent** — `neo supervise kill frontend-lead`. Only parent or human can kill. Peers cannot.
- **Orphan** — if parent dies, child continues with its directives but receives no new instructions from parent. Finishes work, then stops at expiration (or human re-attaches).

### Impact on existing code

- `SupervisorDaemon.start()`: read identity from CLI args, persist in `state.json`
- `HeartbeatLoop`: check `expiresAt` at beginning of each tick
- `budgetGuard`: accept optional `budgetSliceUsd` alongside `dailyCapUsd`
- `state.json` schema: add `identity` field
- `prompt-builder`: inject identity into prompt ("You are frontend-lead, your parent is main, your peers are [backend-lead]")

---

## Section 3: Inter-Supervisor Communication

### Problem

Each supervisor is a silo. No way to request work from another or know what others are doing.

### Solution

Two communication primitives, built on existing infrastructure.

### Primitive 1 — Direct Message

A supervisor appends to another's inbox:

```typescript
interface SupervisorMessage {
  id: string;          // msg_<uuid>
  from: string;        // "frontend-lead"
  to: string;          // "backend-lead"
  content: string;     // free text
  depth: number;       // anti-loop (0 = initial message)
  replyTo?: string;    // id of message being replied to
  createdAt: string;
}
```

**Transport:** Source supervisor does `appendFile` on `~/.neo/supervisor/<target>/inbox.jsonl`. The target's `EventQueue` already watches this file — it picks up the message at next tick.

**Validation before send:**
1. `to` is in `self.peers` — otherwise reject with log
2. Directory `~/.neo/supervisor/<to>/` exists — otherwise error "unknown supervisor"
3. `depth < MAX_DEPTH (2)` — otherwise message is blocked and a `Decision` is created for the human

### Primitive 2 — Task Delegation

A supervisor creates a task assigned to another:

```typescript
// Extension of existing TaskEntry
interface TaskEntry {
  // ...existing fields...
  assignee?: string;      // assigned supervisor name
  requestedBy?: string;   // requesting supervisor name
  depth: number;          // same anti-loop counter
}
```

**Mechanism:**
- Requester creates task in **its own** TaskStore with `assignee: "backend-lead"`
- Sends message to assignee's inbox: "New task assigned: <description>, ref: <taskId>"
- Assignee creates its own copy in its TaskStore with `requestedBy: "frontend-lead"`
- On completion, assignee sends return message: "Task <taskId> completed, PR: <url>"
- Requester updates its tracking

**No shared state.** Each supervisor has its own copy. Eventual consistency via messages, not locking.

### Anti-Loop — Depth Counter

```
frontend-lead → backend-lead : "Need an endpoint"         depth=0
backend-lead → frontend-lead : "Done, PR #42"             depth=1
frontend-lead → backend-lead : "Return type is wrong"     depth=2
                                                           → BLOCKED
```

At `depth >= MAX_DEPTH`:
- Message is NOT sent
- A `Decision` is created in the supervisor's DecisionStore
- Human sees in TUI: "frontend-lead wants to send a 3rd message to backend-lead. Allow?"
- If authorized, message goes out with `depth` reset to 0

### Supervisor tools

The supervisor prompt includes two new tools:

```bash
# Send message to a peer
neo message --to backend-lead "I need a GET /users endpoint with pagination"

# Create assigned task
neo task create --assignee backend-lead --scope repo:api "Create GET /users endpoint"
```

### Impact on existing code

- `inbox.jsonl` format: add `from`, `to`, `depth`, `replyTo` fields (optional — backward compatible, messages without `from` are human messages as before)
- `EventQueue`: no change — already watches the file
- `prompt-builder`: display messages with source ("Message from backend-lead: ...")
- `TaskStore`: add `assignee` and `requestedBy` columns (nullable)
- New: `MessageRouter` module (~50 lines) — validates peers + depth, does the `appendFile`

---

## Section 4: Spawn from Directive & Lifecycle

### Problem

Launching a sub-supervisor requires a manual `neo supervise`. The parent supervisor should be able to spawn children from a directive.

### Solution

The parent supervisor has access to `neo supervise` as a tool. A directive can instruct it to spawn a child:

```
directive: "Launch a frontend-lead supervisor on repo app-web
           with profile refactoring-mode for 48h, budget $30,
           peers: backend-lead"
```

The supervisor interprets this and executes the corresponding `neo supervise` command. No magic parsing, no DSL. Free text remains the format. The LLM does what a human would do reading this instruction.

### Lifecycle state machine

```
                    ┌─────────────┐
                    │   SPAWNING  │  neo supervise --name X
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │   RUNNING   │  heartbeat active, directives executing
                    └──┬───┬───┬──┘
                       │   │   │
            expires    │   │   │  parent kill
            reached    │   │   │
                       ▼   │   ▼
                  ┌────────┐  ┌──────────┐
                  │EXPIRING│  │  KILLED   │
                  └──┬─────┘  └────┬─────┘
                     │             │
                     ▼             ▼
                    ┌──────────────────────┐
                    │  DRAINING            │  finish active runs
                    │  (no new dispatches) │
                    └──────────┬───────────┘
                               ▼
                    ┌─────────────┐
                    │  STOPPED    │  daemon exit, state.json marked stopped
                    └─────────────┘
```

### Events to parent

When a child changes state, it sends a message to the parent's inbox:

- `"[frontend-lead] Started — profile: refactoring-mode, budget: $30, expires: 48h"`
- `"[frontend-lead] Task completed — PR #42 on app-web"`
- `"[frontend-lead] Budget at 80% — $24/$30 used"`
- `"[frontend-lead] Expiring in 1h — 2 runs still active"`
- `"[frontend-lead] Stopped — 5 tasks completed, $28.50 spent"`

The parent sees all of this in its activity feed and can decide to extend, kill, or let expire.

### Lifecycle CLI commands

```bash
# Extend a child
neo supervise extend frontend-lead --expires 24h

# Kill a child (graceful)
neo supervise kill frontend-lead

# View tree
neo supervise tree
# main ($420 effective)
#  ├── frontend-lead ($30, expires 47h, 3 directives)
#  └── backend-lead ($50, expires 6d, 2 directives)

# Status of a specific child
neo supervise status frontend-lead
```

### Guardrails

- **Budget cap** — a supervisor cannot spawn a child with more budget than its own remaining budget
- **Tree depth max: 2** — main → child → grandchild max. Beyond that, human decision required
- **Concurrent supervisor limit** — configurable, default 5. Prevents LLM fork-bomb
- **No upward spawning** — a child cannot spawn a peer to its parent

### Impact on existing code

- `supervise` command: add `extend` and `tree` subcommands
- `HeartbeatLoop`: at tick start, check `expiresAt` → if expired, transition to `DRAINING`
- `state.json`: add `status: "running" | "draining" | "stopped"`
- Lifecycle events: daemon sends messages to parent inbox at key transitions

---

## Section 5: TUI Cockpit

### Problem

The current TUI monitors a single supervisor. With multi-supervisor and directive profiles, it needs to become a **piloting cockpit**.

### Solution

Three additions to the existing TUI. No rewrite — extension only.

### 5.1 — Directives & Profiles Panel

New panel accessible via `d` key:

```
┌─ Directives ───────────────────────────────────────────┐
│                                                         │
│ Profile: refactoring-mode (active, expires 47h)         │
│  ● [p10] Refactor files > 200 lines                    │
│  ● [p5]  Split components with multiple responsibilities│
│  ○ [p1]  Update import paths after moves    (disabled)  │
│                                                         │
│ Standalone:                                             │
│  ● [p8]  Review all PRs before merge                    │
│  ● [p3]  Check CI status every hour                     │
│                                                         │
│ [n]ew  [p]rofile  [x]toggle  [del]ete  [esc]back       │
└─────────────────────────────────────────────────────────┘
```

Interactions: `↑↓` navigate, `x` toggle, `n` new directive (inline form), `p` new/activate profile, `del` delete.

### 5.2 — Supervisors Panel

Accessible via `s` key:

```
┌─ Supervisors ──────────────────────────────────────────┐
│                                                         │
│ ● main                $420/day   2 directives           │
│  ├─ ● frontend-lead   $24/$30    refactoring-mode       │
│  │    expires 47h, 1 run active                         │
│  └─ ● backend-lead    $12/$50    api-sprint             │
│       expires 6d, idle                                  │
│                                                         │
│ [a]ttach  [k]ill  [e]xtend  [n]ew  [esc]back           │
└─────────────────────────────────────────────────────────┘
```

Interactions: `↑↓` navigate tree, `a` attach (switch TUI to that supervisor's context), `k` kill, `e` extend, `n` spawn new supervisor.

### 5.3 — Enriched Chat

The existing chat understands natural commands:

```
> activate refactoring-mode for 2h
> spawn frontend-lead on app-web budget $30 for 48h
> kill frontend-lead
> message backend-lead "users endpoint ready?"
```

No parsing on TUI side — message goes to inbox as today, the LLM does the work.

### Global navigation

```
Keyboard shortcuts:
  [d] Directives panel
  [s] Supervisors panel
  [tab] Chat / Decisions (existing)
  [esc] Back to previous panel
```

Header shows active panel:

```
┌─ neo supervisor: main ─── [D]irectives [S]upervisors [Tab]Chat ──────┐
```

### Impact on existing code

- `supervisor-tui.tsx`: add state `activePanel: "activity" | "directives" | "supervisors"`
- Two new Ink components: `<DirectivesPanel>` and `<SupervisorsPanel>`
- Main component routes display based on `activePanel`
- Polling: add `DirectiveStore` and `StatusReader` (to read children's state.json) to existing poll cycle
- Chat input unchanged — text to inbox as before

---

## Implementation Phases

Ordered by dependency. Each phase is independently deliverable and testable.

### Phase 1: Directive Profiles
- `ProfileStore` (schema, JSONL store, CRUD)
- `profileId` field on `Directive`
- `DirectiveStore.active()` filters by profile state
- CLI commands: `neo profile create|list|activate|deactivate|delete`
- Tests

### Phase 2: Supervisor Identity
- `SupervisorIdentity` schema
- CLI flags: `--parent`, `--peers`, `--budget`, `--directives`, `--expires`
- Persist identity in `state.json`
- Budget slice deduction in `budgetGuard`
- Prompt builder identity injection
- Tests

### Phase 3: Inter-Supervisor Communication
- `SupervisorMessage` schema (from, to, depth, replyTo)
- `MessageRouter` module (peers validation, depth check, appendFile)
- `inbox.jsonl` extended format (backward compatible)
- CLI: `neo message --to <name> <content>`
- Task delegation: `assignee` and `requestedBy` on TaskEntry
- Anti-loop Decision creation at MAX_DEPTH
- Tests

### Phase 4: Spawn & Lifecycle
- Lifecycle states in `state.json`: running → draining → stopped
- Expiration check in HeartbeatLoop
- Lifecycle events to parent inbox
- CLI: `neo supervise extend|kill|tree`
- Guardrails (budget cap, tree depth, concurrent limit)
- Tests

### Phase 5: TUI Cockpit
- `<DirectivesPanel>` component
- `<SupervisorsPanel>` component
- Panel navigation (d/s/tab/esc)
- Polling for profiles and child supervisor states
- Header update with panel indicators
- Tests

### Phase 6: Integration & Polish
- End-to-end test: parent spawns child via directive, child executes, communicates result
- SUPERVISOR.md documentation update
- Agent prompt updates (identity context, peer tools)
- Edge cases: orphan handling, budget exhaustion, concurrent spawn

---

## Non-Goals

- **Service discovery** — supervisors don't auto-discover each other. Explicit `--peers` whitelist.
- **Shared state** — no shared task board, no shared database. Each supervisor owns its data.
- **Smart routing** — no automatic message routing. Supervisors address peers explicitly.
- **Structured directive types** — actions remain free text. The LLM interprets.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| LLM ping-pong between supervisors | Depth counter (MAX_DEPTH=2) + human Decision gate |
| Budget overrun across supervisors | Budget slicing with hard caps per supervisor |
| Supervisor fork-bomb | Concurrent supervisor limit (default 5) + tree depth limit (2) |
| Orphan supervisors lingering | Mandatory `expiresAt` on children + orphan detection at heartbeat |
| Context window saturation on long-lived sessions | Existing session management; children have short TTLs by design |
| Contradictory directives across peers | Scope isolation (each supervisor has its own repos/scope) + human escalation |
