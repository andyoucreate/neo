# Codex CLI Provider Support

**Date:** 2026-04-16
**Status:** Draft
**Scope:** Phase 1 (supervisor + runner adapter), Phase 2 (worker YAML config) deferred

## Summary

Add OpenAI Codex CLI as an alternative AI provider in neo. The existing `AIAdapter` interface is already designed for multi-provider support but dormant — `HeartbeatLoop` and `runSession()` both call the Claude Agent SDK directly. This spec activates the adapter pattern and introduces a `CodexAdapter` backed by `@openai/codex-sdk`.

## Motivation

- **Cost flexibility**: GPT-5.4 via Codex may be cheaper for high-frequency supervisor heartbeats
- **Provider independence**: neo should not be locked to a single AI provider
- **Codex strengths**: native OS sandboxing (Seatbelt/Landlock), native `AGENTS.md` support, `codex exec` for non-interactive use

## Architecture Overview

```
neo config (provider: "claude" | "codex")
        │
        ├── Supervisor (HeartbeatLoop)
        │     ├── ClaudeAdapter   → sdk.query() via @anthropic-ai/claude-agent-sdk
        │     └── CodexAdapter    → thread.runStreamed() via @openai/codex-sdk
        │           └── CodexMcpBridge (exposes supervisor tools as MCP server)
        │
        └── Runner (session.ts)
              ├── ClaudeSessionAdapter  → sdk.query() (extracted from current code)
              └── CodexSessionAdapter   → codex exec --json (process spawn)
```

## 1. SessionHandle Extension

```typescript
// ai-adapter.ts
export type SessionHandle =
  | { provider: "claude"; sessionId: string }
  | { provider: "codex"; threadId: string };
```

## 2. AIAdapter (Supervisor) — No Interface Change

The existing `AIAdapter` interface remains unchanged:

```typescript
export interface AIAdapter {
  query(options: AIQueryOptions): AsyncIterable<SupervisorMessage>;
  getSessionHandle(): SessionHandle | undefined;
  restoreSession(handle: SessionHandle): void;
}
```

### 2.1 CodexAdapter

New file: `packages/core/src/supervisor/adapters/codex.ts`

- Wraps `@openai/codex-sdk` (`Codex` class)
- `query()` calls `thread.runStreamed()` and maps Codex events to `SupervisorMessage`
- Session continuity via `codex.resumeThread(threadId)`
- Working directory passed from HeartbeatLoop config

**Event mapping (Codex → SupervisorMessage):**

| Codex SDK event | SupervisorMessage |
|---|---|
| `item.completed` (text) | `{ kind: "text", text }` |
| `item.completed` (tool call) | `{ kind: "tool_use", toolName, toolInput }` |
| `turn.completed` | `{ kind: "end", metadata: { costUsd, turnCount } }` |

### 2.2 SupervisorMessage Metadata

Add optional metadata to the `end` message for cost tracking:

```typescript
export interface SupervisorMessage {
  kind: SupervisorMessageKind;
  toolName?: string;
  toolInput?: unknown;
  text?: string;
  metadata?: { costUsd?: number; turnCount?: number };
}
```

## 3. Supervisor Tools via MCP Bridge

Codex does not support custom tool injection like Claude's SDK. Neo's supervisor tools (`dispatch_agent`, `list_runs`, `approve_pr`, `send_message`, etc.) are exposed to Codex via an MCP server bridge.

New file: `packages/core/src/supervisor/adapters/codex-mcp-bridge.ts`

**Flow:**
1. HeartbeatLoop builds `ToolDefinition[]` + handlers as today
2. `CodexMcpBridge` wraps them as a stdio MCP server (JSON-RPC 2.0)
3. MCP server config is passed to `Codex.startThread({ mcpServers })`
4. Codex calls tools via MCP → bridge executes handlers → returns result

**Implementation:** Lightweight in-process stdio MCP server. No external dependencies — uses the MCP protocol directly (JSON-RPC over stdin/stdout of a child process that the bridge script implements).

**Reusability:** This bridge is provider-agnostic. Any future provider that supports MCP can reuse it.

## 4. SessionAdapter (Runner)

New interface for the runner layer, separate from `AIAdapter`:

```typescript
// ai-adapter.ts
export interface SessionAdapter {
  runSession(options: SessionRunOptions): AsyncIterable<SDKStreamMessage>;
}

export interface SessionRunOptions {
  prompt: string;
  cwd: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  maxTurns?: number;
  resumeSessionId?: string;
  model?: string;
  // Provider-specific options (hooks, agents, etc.) are handled
  // internally by each adapter, not in the shared interface.
  adapterOptions?: Record<string, unknown>;
}
```

### 4.1 ClaudeSessionAdapter

New file: `packages/core/src/runner/adapters/claude-session.ts`

Extract of the current `buildQueryOptions()` + `sdk.query()` logic from `session.ts`. No behavior change — pure refactor.

### 4.2 CodexSessionAdapter

New file: `packages/core/src/runner/adapters/codex-session.ts`

- Spawns `codex exec --json --full-auto <prompt>` as child process via `execFile()`
- Parses JSONL stdout line by line
- Maps Codex JSONL events to `SDKStreamMessage` format

**Event mapping (Codex JSONL → SDKStreamMessage):**

| Codex JSONL event | SDKStreamMessage |
|---|---|
| `session.start` | `{ type: "system", subtype: "init", session_id }` |
| `message.completed` | `{ type: "assistant", message: { content } }` |
| `session.completed` | `{ type: "result", total_cost_usd, num_turns }` |

**Abort:** `child.kill("SIGTERM")` — same pattern as current worker process management.

**Sandbox mapping:**

| neo SandboxConfig | Codex --sandbox flag |
|---|---|
| `readOnly: true` | `--sandbox read-only` |
| `readOnly: false` | `--sandbox workspace-write` |

Codex reads `AGENTS.md` natively from the cwd, so agent instructions work without additional configuration.

## 5. Configuration

### 5.1 Supervisor Config

```typescript
// config/schema.ts — supervisorConfigSchema
provider: z.enum(["claude", "codex"]).default("claude"),
```

When `provider: "codex"` and no explicit `model` is set, default model changes to `"gpt-5.4"`.

### 5.2 Agent YAML (Phase 2 — deferred)

```yaml
name: code-reviewer
provider: codex          # optional override
model: gpt-5.4
```

If absent, inherits from global config. This is Phase 2 scope and not implemented in this spec.

### 5.3 Global Config Example

```yaml
# ~/.neo/config.yml
supervisor:
  provider: codex
  model: gpt-5.4
  dailyCapUsd: 50
```

## 6. Factory Functions

```typescript
// packages/core/src/supervisor/adapters/index.ts
export function createSupervisorAdapter(provider: "claude" | "codex"): AIAdapter {
  switch (provider) {
    case "claude": return new ClaudeAdapter();
    case "codex":  return new CodexAdapter();
  }
}

// packages/core/src/runner/adapters/index.ts
export function createSessionAdapter(provider: "claude" | "codex"): SessionAdapter {
  switch (provider) {
    case "claude": return new ClaudeSessionAdapter();
    case "codex":  return new CodexSessionAdapter();
  }
}
```

## 7. Refactoring Existing Code

### 7.1 HeartbeatLoop (heartbeat.ts)

- Constructor accepts `AIAdapter` instance (injected by daemon.ts via factory)
- `callSdk()` renamed to `callAdapter()`
- Replaces direct `sdk.query()` with `adapter.query()`
- Raw SDK message parsing (`isInitMessage`, etc.) replaced by structured `SupervisorMessage` iteration
- Cost/turnCount extracted from `end` message metadata

### 7.2 session.ts

- `runSession()` accepts optional `SessionAdapter` parameter
- Default: `new ClaudeSessionAdapter()` (backward compatible)
- Current `buildQueryOptions()` + SDK call logic extracted into `ClaudeSessionAdapter`
- Timeout/abort logic stays in `runSession()` (adapter-agnostic)

### 7.3 Test Impact

- Existing `vi.mock("@anthropic-ai/claude-agent-sdk")` calls become adapter mocks
- Simpler: mock `AIAdapter.query()` instead of SDK internals
- All existing tests continue to work via `ClaudeAdapter`/`ClaudeSessionAdapter`

## 8. Dependencies

**New npm dependency:**
- `@openai/codex-sdk` — added as **optional peer dependency** in `packages/core/package.json`
- Dynamic import: `await import("@openai/codex-sdk")` — fails gracefully with clear error if not installed
- Zero impact for Claude-only users

**Runtime requirement:**
- `codex` CLI must be installed globally for `CodexSessionAdapter` (runner)
- `@openai/codex-sdk` must be installed for `CodexAdapter` (supervisor)

## 9. Files Created

| File | Purpose |
|---|---|
| `supervisor/adapters/codex.ts` | `CodexAdapter implements AIAdapter` |
| `supervisor/adapters/codex-mcp-bridge.ts` | MCP bridge for supervisor tools |
| `supervisor/adapters/index.ts` | Factory `createSupervisorAdapter()` |
| `runner/adapters/claude-session.ts` | Extracted Claude session logic |
| `runner/adapters/codex-session.ts` | `CodexSessionAdapter` via `codex exec` |
| `runner/adapters/index.ts` | Factory `createSessionAdapter()` |

## 10. Files Modified

| File | Change |
|---|---|
| `supervisor/ai-adapter.ts` | Extend `SessionHandle`, add `SessionAdapter` interface, add `metadata` to `SupervisorMessage` |
| `config/schema.ts` | Add `provider` field to supervisor config |
| `supervisor/heartbeat.ts` | Inject `AIAdapter`, replace `callSdk()` with `callAdapter()` |
| `runner/session.ts` | Accept `SessionAdapter` param, extract Claude logic |
| `packages/core/package.json` | Add `@openai/codex-sdk` as optional peer dep |

## 11. Not In Scope

- **Phase 2 (agent YAML provider field)**: per-agent provider override — deferred
- **Gemini/Ollama adapters**: future work, but the pattern supports them
- **Middleware/hooks for Codex**: `buildSDKHooks()` is Claude-specific; Codex hooks are limited. Deferred.
- **Codex GitHub Action integration**: out of scope
