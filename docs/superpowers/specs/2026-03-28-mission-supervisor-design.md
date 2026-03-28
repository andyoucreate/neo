# Supervisor Architecture — Design Spec

**Date:** 2026-03-28
**Status:** Draft
**Scope:** Hierarchical supervisor architecture — a root Supervisor (heartbeat mode) spawns focused child Supervisors that guarantee delivery of an objective end-to-end. Designed to be adapter-extensible for production contexts beyond the CLI, with full AI provider independence via `AIAdapter`.

---

## Problem

The `Agent` tool is fire-and-forget. There is no supervision *during* execution — no trajectory correction, no stall detection, no retry with context. A task is dispatched and either succeeds or fails. Nobody is accountable for ensuring it completes.

The result: complex multi-step objectives fail silently, loop without progress, or stop mid-way with no recovery.

---

## Goal

Introduce a unified `Supervisor` abstraction with two modes:

- **`heartbeat`** — the root supervisor (what `SupervisorDaemon` is today). Infinite event loop, monitors children, dispatches objectives.
- **`focused`** — spawned by a parent supervisor. Persistent SDK conversation looping on a single objective until it declares completion. Has its own agents. Reports back to parent.

One abstraction, two modes. The difference is configuration, not class hierarchy.

---

## Architecture

```
Supervisor (mode: heartbeat) — process A
│  Root event loop — receives events, dispatches objectives
│  ChildRegistry: Map<supervisorId, ChildHandle>
│
├─[IPC]─▶ Supervisor (mode: focused) — process B
│           objective: "implement feat/auth"
│           acceptanceCriteria: ["PR open", "CI green", "tests pass"]
│           Persistent SDK session (resume: sessionId)
│           Loops every tickInterval
│           Spawns: developer, scout, reviewer agents
│           Reports: progress | blocked | complete | failed
│
└─[IPC]─▶ Supervisor (mode: focused) — process C
            objective: "fix perf regression in query builder"
            acceptanceCriteria: ["p95 < 200ms", "no regression in other queries"]
            Same structure, fully isolated context
```

**Depth limit:** root → focused → agents (max depth = 1, enforced for now). The `depth` field is in the schema for future extensibility — a focused supervisor at depth 1 cannot spawn focused children.

---

## Components

### 1. Unified `SupervisorOptions` schema

```typescript
interface SupervisorOptions {
  supervisorId: string;
  mode: "heartbeat" | "focused";

  // focused mode only
  objective?: string;              // The goal in natural language
  acceptanceCriteria?: string[];   // Explicit, verifiable criteria — set at dispatch time
  parentId?: string;               // ID of the parent supervisor
  depth?: number;                  // 0 = root, 1 = focused child (reserved for depth > 1)
  maxCostUsd?: number;             // Budget cap for this supervisor (enforced by parent)
  tickInterval?: number;           // ms between SDK turns (default: 30_000)
  sessionId?: string;              // Resume previous SDK session if provided

  repoPath: string;
  config: GlobalConfig;
  store: SupervisorStore;          // Adapter — see Storage Adapters section
}
```

The `acceptanceCriteria` array is defined **at dispatch time** by the parent — not at completion time by the child. The child knows from the start what "done" means. This is the single most important design decision for reliable completion detection.

### 2. Focused Supervisor loop

```typescript
// Pseudo-code for the focused supervisor loop
async function focusedLoop(options: SupervisorOptions): Promise<void> {
  let sessionId = options.sessionId ?? await store.getSessionId(options.supervisorId);

  while (true) {
    const prompt = buildFocusedPrompt({
      objective: options.objective,
      acceptanceCriteria: options.acceptanceCriteria,
      history: await store.getRecentActivity(options.supervisorId),
      pendingDecisions: await store.getPendingDecisions(options.supervisorId),
    });

    for await (const message of query({ prompt, resume: sessionId })) {
      if (isInitMessage(message)) {
        sessionId = message.session_id;
        await store.saveSessionId(options.supervisorId, sessionId);
      }
      if (isToolUse(message, "supervisor_complete")) {
        await verifyAndComplete(message.input, options);
        return; // exits the process
      }
      if (isToolUse(message, "supervisor_blocked")) {
        await reportBlocked(message.input, options);
        await waitForUnblock(options); // pauses loop until parent responds
      }
    }

    await checkBudget(options); // throws if maxCostUsd exceeded
    await sleep(options.tickInterval ?? 30_000);
  }
}
```

**Session persistence:** stored via `SupervisorStore` adapter. Survives process crash — on restart, `resume: sessionId` continues the conversation with full history of what was already attempted.

### 3. `supervisor_complete` tool (intercepted by framework)

```typescript
const supervisorCompleteSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()),   // PR URL, test output, CI status — at least one required
  branch: z.string().optional(),
  criteriaResults: z.array(z.object({
    criterion: z.string(),
    met: z.boolean(),
    evidence: z.string(),
  })),
});
```

**Completion is not self-declared.** Before accepting, the parent always spawns a `reviewer` agent that independently verifies each criterion. If any criterion fails, the parent sends `{ type: "unblock", answer: "verification failed: <reason>" }` — the child loop continues.

### 4. `supervisor_blocked` tool

```typescript
const supervisorBlockedSchema = z.object({
  reason: z.string(),
  question: z.string(),
  context: z.string(),
  urgency: z.enum(["low", "high"]),  // high = parent should interrupt its own loop
});
```

Creates a `Decision` in the parent's DecisionStore. The child loop pauses. When the parent answers, it sends `{ type: "unblock", answer }` via IPC.

### 5. `ChildRegistry` (replaces implicit tracking in HeartbeatLoop)

```typescript
interface ChildHandle {
  supervisorId: string;
  objective: string;
  process: ChildProcess;
  sessionId?: string;
  depth: number;
  startedAt: string;
  lastProgressAt: string;
  costUsd: number;
  maxCostUsd?: number;
  status: "running" | "blocked" | "complete" | "failed" | "stalled";
}
```

**IPC protocol (child → parent):**
```typescript
type ChildToParentMessage =
  | { type: "progress"; supervisorId: string; summary: string; costDelta: number }
  | { type: "complete"; supervisorId: string; summary: string; evidence: string[] }
  | { type: "blocked"; supervisorId: string; reason: string; question: string; urgency: "low" | "high" }
  | { type: "failed"; supervisorId: string; error: string }
  | { type: "session"; supervisorId: string; sessionId: string };  // first turn session capture
```

**IPC protocol (parent → child):**
```typescript
type ParentToChildMessage =
  | { type: "unblock"; answer: string }
  | { type: "stop" }
  | { type: "inject"; context: string };  // parent pushes cross-supervisor context when needed
```

The `inject` message is how the parent shares relevant cross-child context without polluting the child's own conversation. Example: "Mission B just modified auth.ts — be aware when you run tests."

---

## Observability

Without visibility into the tree, you're blind. `neo supervisors` must show the full live state:

```
neo supervisors

● root (heartbeat)  uptime: 2h14m  cost: $1.24
  ├─ ● feat/auth    running   turn 12/∞   cost: $0.43   last: "opened PR #42"
  ├─ ● fix/perf     blocked   turn 8/∞    cost: $0.21   waiting: "should I rewrite the index?"
  └─ ✓ docs/update  complete  turn 5      cost: $0.09   "PR #41 merged, CI green"
```

Each child line is clickable/expandable to show the last N turns of its SDK conversation. This is implemented via the `SupervisorStore` — the CLI reads from whatever backend is configured.

---

## Budget Enforcement

Budget operates at two levels:

1. **Global budget** — existing `todayCostUsd` / `capUsd` in root supervisor config
2. **Per-child budget** — `maxCostUsd` in `ChildHandle`. Enforced by the parent: on every `progress` message, parent accumulates `costDelta`. If `costUsd >= maxCostUsd`, parent sends `{ type: "stop" }` and marks child as `failed` with reason "budget exceeded".

The child also self-checks via `checkBudget()` at each tick as a secondary guard.

---

## Stall Detection

A focused supervisor is **stalled** if:
- No IPC message for `> config.stallTimeout` (default: 10 min)
- OR SDK session returns empty/no-op turns ≥ 3 consecutive times

On stall: parent marks child as `stalled`, kills process, restarts with `resume: sessionId` + injected context: "You appear to have stalled. Review what you've tried and take a different approach." The SDK session history ensures the child remembers all previous attempts.

---

## Prompt Isolation

Focused supervisors have **no visibility into sibling supervisors** by default. Their prompt contains only:
- Their own objective and acceptance criteria
- Their own agent activity history
- Their own pending decisions
- Any context explicitly injected by the parent via `inject` IPC message

This prevents cross-contamination of context between parallel objectives. The parent is the only entity with full visibility — it decides what to share and when.

---

## Failure Recovery

Follows existing neo 3-level escalation, applied per child:

1. **Normal:** child resumes session, retries with corrected context (happens automatically via loop)
2. **Resume:** parent restarts child process with `resume: sessionId` + injected diagnosis
3. **Fresh:** parent starts new child for same objective (new session, new clone) — last resort

Level escalation is triggered by consecutive failures, same as existing recovery logic.

---

## AI Adapters

This is the second adapter layer — decoupling the orchestration logic from any specific AI provider.

All AI calls in the supervisor loop go through an `AIAdapter` interface. The Claude Agent SDK is the default implementation, but any provider can be swapped in without touching orchestration code.

### Interface

```typescript
interface AIAdapter {
  /**
   * Execute one turn of the supervisor conversation.
   * Returns an async iterable of structured messages.
   */
  query(options: AIQueryOptions): AsyncIterable<SupervisorMessage>;

  /**
   * Provider-specific session management.
   * Called by the supervisor loop to persist and restore conversation context.
   */
  getSessionHandle(): SessionHandle | undefined;
  restoreSession(handle: SessionHandle): void;
}

interface AIQueryOptions {
  prompt: string;
  tools: ToolDefinition[];         // supervisor_complete, supervisor_blocked, Agent, etc.
  sessionHandle?: SessionHandle;   // provider-specific session context
  systemPrompt?: string;
  model?: string;                  // override default model for this turn
}

/**
 * Opaque session handle — each adapter stores what it needs.
 * Persisted via SupervisorStore so it survives process restart.
 */
type SessionHandle =
  | { provider: "claude"; sessionId: string }        // ~/.claude/projects/<id>.jsonl
  | { provider: "openai"; threadId: string }          // Assistants API thread
  | { provider: "gemini"; conversationId: string }    // Gemini session
  | { provider: "ollama"; messages: MessageEntry[] }; // full history, reconstructed from store
```

### Provided adapters

| Adapter | Package | Backend | Session strategy |
|---------|---------|---------|-----------------|
| `ClaudeAdapter` | `@neotx/core` (default) | Claude Agent SDK | Native `resume: sessionId` |
| `OpenAIAdapter` | `@neotx/ai-openai` | OpenAI Responses API | `thread_id` (Assistants API) |
| `GeminiAdapter` | `@neotx/ai-gemini` | Google Gemini | `conversationId` |
| `OllamaAdapter` | `@neotx/ai-ollama` | Local models via Ollama | Full message history from `SupervisorStore` |

### Session persistence strategy per provider

**Claude (default):** The SDK natively persists sessions to `~/.claude/projects/<cwd>/<sessionId>.jsonl`. The `SessionHandle` only stores the `sessionId` string — the SDK handles the rest.

**OpenAI:** Uses the Assistants API `thread_id`. The `OpenAIAdapter` creates a thread on first turn, stores the `threadId` in `SessionHandle`. On resume, it appends a new user message to the existing thread. Tool calls are mapped from OpenAI function-calling format to neo's `SupervisorMessage` format.

**Gemini:** Uses Gemini's conversation history API. `GeminiAdapter` maps the conversation to Gemini's `Content[]` format and rebuilds it from `SupervisorStore` on resume.

**Ollama (local models):** No native session support. The `OllamaAdapter` reconstructs the full message history from `SupervisorStore` on every turn. This means `SupervisorStore` is the single source of truth for conversation history — a `messages` array is stored in the `SessionHandle` and updated after each turn.

### Why `SupervisorStore` is the source of truth

For providers without native session persistence (Ollama, any future custom provider), the `SupervisorStore` holds the full conversation history. Even for Claude, the store keeps a provider-agnostic copy — enabling migration between providers without losing context.

```
Turn N (Claude)  → store: { provider: "claude", sessionId: "abc" }
Switch to Ollama → OllamaAdapter reads message history from store → rebuilds context
Turn N+1         → Ollama continues with full history
```

This makes provider migration possible mid-mission, though it's not the default flow.

### Tool mapping

Each adapter is responsible for translating neo's tool definitions to its provider's format:

- Claude → Claude tool_use format (native, no mapping needed)
- OpenAI → function calling schema (`parameters` → JSON Schema)
- Gemini → function declarations format
- Ollama → depends on model (llama3, mistral, etc.) — adapter handles capability detection

Intercepted tools (`supervisor_complete`, `supervisor_blocked`) are caught **before** being forwarded to the provider. The adapter only sees domain tools (Agent, Read, Bash, etc.).

---

## Storage Adapters

This is the key to making neo usable beyond the CLI in production contexts.

All persistence in the focused supervisor loop goes through a `SupervisorStore` interface — not directly to JSONL files. This enables swapping the backend without changing orchestration logic.

```typescript
interface SupervisorStore {
  // Session
  getSessionId(supervisorId: string): Promise<string | undefined>;
  saveSessionId(supervisorId: string, sessionId: string): Promise<void>;

  // Activity
  appendActivity(supervisorId: string, entry: ActivityEntry): Promise<void>;
  getRecentActivity(supervisorId: string, limit?: number): Promise<ActivityEntry[]>;

  // Decisions
  createDecision(supervisorId: string, input: DecisionInput): Promise<string>;
  getPendingDecisions(supervisorId: string): Promise<Decision[]>;
  answerDecision(decisionId: string, answer: string): Promise<void>;

  // State
  getState(supervisorId: string): Promise<SupervisorState | null>;
  saveState(supervisorId: string, state: SupervisorState): Promise<void>;

  // Cost tracking
  recordCost(supervisorId: string, costUsd: number): Promise<void>;
  getTotalCost(supervisorId: string): Promise<number>;
}
```

**Provided adapters:**

| Adapter | Backend | Use case |
|---------|---------|----------|
| `JsonlSupervisorStore` | JSONL files (existing) | CLI, zero-infra, default |
| `SqliteSupervisorStore` | SQLite via `better-sqlite3` | Local production, single-machine |
| `PostgresSupervisorStore` | PostgreSQL | Multi-machine, team deployment |

**Why adapters matter:**

The CLI use case (single developer, local machine) is covered by JSONL. But a team running neo as a shared service needs:
- Multiple users dispatching supervisors concurrently
- A web UI reading supervisor state from a DB
- Audit logs that survive machine restarts
- Supervisor state queryable via API

The adapter pattern means the orchestration logic is identical — only the storage backend changes. `@neotx/core` exports the `SupervisorStore` interface. `@neotx/store-sqlite` and `@neotx/store-postgres` are optional packages, zero dependencies in the core.

**Zero-infra constraint respected:** `JsonlSupervisorStore` is the default. Adapters are opt-in. Installing `@neotx/store-postgres` is an explicit choice, never forced.

---

## Depth > 1 Extensibility

The `depth` field is reserved. When the time comes:
- A supervisor at depth 1 with `allowFocusedChildren: true` can spawn depth 2 children
- Budget propagation: `maxCostUsd` at depth N is bounded by the remaining budget of depth N-1
- Decision propagation: a blocked depth 2 escalates to depth 1, which may re-escalate to depth 0
- The `ChildRegistry` already tracks depth — the only code change needed is removing the depth guard

---

## File Map

| File | Change |
|------|--------|
| `packages/core/src/supervisor/focused-loop.ts` | New — focused supervisor loop |
| `packages/core/src/supervisor/child-registry.ts` | New — ChildRegistry |
| `packages/core/src/supervisor/supervisor-tools.ts` | New — `supervisor_complete` + `supervisor_blocked` schemas |
| `packages/core/src/supervisor/store.ts` | New — `SupervisorStore` interface |
| `packages/core/src/supervisor/stores/jsonl.ts` | New — `JsonlSupervisorStore` (default) |
| `packages/core/src/supervisor/heartbeat.ts` | Modify — integrate ChildRegistry, handle IPC events |
| `packages/core/src/supervisor/prompt-builder.ts` | Modify — add focused supervisor dispatch instructions to root prompt |
| `packages/core/src/supervisor/daemon.ts` | Modify — pass `SupervisorStore` instance through |
| `packages/agents/prompts/focused-supervisor.md` | New — focused supervisor system prompt |
| `packages/core/src/supervisor/schemas.ts` | Modify — add unified SupervisorOptions schema |
| `packages/core/src/paths.ts` | Modify — add `getSupervisorsDir()` path helper |
| `packages/core/src/supervisor/ai-adapter.ts` | New — `AIAdapter` interface + `SessionHandle` type |
| `packages/core/src/supervisor/adapters/claude.ts` | New — `ClaudeAdapter` (default, wraps Agent SDK) |
| `packages/store-sqlite/` | New package — `SqliteSupervisorStore` (optional) |
| `packages/store-postgres/` | New package — `PostgresSupervisorStore` (optional) |
| `packages/ai-openai/` | New package — `OpenAIAdapter` (optional) |
| `packages/ai-gemini/` | New package — `GeminiAdapter` (optional) |
| `packages/ai-ollama/` | New package — `OllamaAdapter` (optional) |

---

## Out of Scope (for now)

- Depth > 1 (reserved, not implemented)
- Web UI (reads from store adapter — can be built separately)
- Cross-repo supervisors (single repo per focused supervisor)
- Supervisor priority / preemption
- `store-postgres` package (interface defined, implementation deferred)
- `ai-openai`, `ai-gemini`, `ai-ollama` packages (interfaces defined, implementations deferred)
- Provider migration mid-mission (possible by design, not exposed as a feature yet)

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Unified `Supervisor` + `mode` field | Avoids class hierarchy divergence. One concept, two behaviors. |
| `acceptanceCriteria` set at dispatch time | Completion must be verifiable, not self-declared. Parent defines "done". |
| `SupervisorStore` interface | Enables production use without changing orchestration logic. Zero-infra by default. |
| `AIAdapter` interface | Full AI provider independence. Claude is the default, not a hard dependency. |
| `SupervisorStore` as conversation history source of truth | Enables provider migration and powers providers without native session support (Ollama). |
| `SessionHandle` as opaque union type | Each provider stores exactly what it needs — no leaky abstractions. |
| Intercepted tools before adapter | `supervisor_complete` / `supervisor_blocked` are framework concerns, never reach the AI provider. |
| IPC over webhooks for parent-child | Synchronous, zero-latency, no port coordination needed between siblings. |
| `inject` message type | Parent can share cross-child context without polluting child conversation history. |
| Reviewer verification before accepting completion | Prevents false completion — independent check against acceptance criteria. |
| `depth` field reserved | Depth > 1 is one config change away, not an architectural rewrite. |
