# Neo — Middleware System

Middleware intercepts agent tool calls and SDK events. It's how users add guardrails, auditing, and custom logic without modifying the framework.

## Design

Middleware is inspired by Express/Koa middleware but adapted for agent orchestration:

- Each middleware targets a specific **hook event** (PreToolUse, PostToolUse, Notification)
- Middleware can optionally **match** specific tools (e.g. only Bash, only Write/Edit)
- Middleware runs in **registration order** (first registered = first executed)
- Any middleware can **block** a tool call (returns `{ decision: "block", reason }`)
- Blocking is final — subsequent middleware don't run for that call

## Interface

```typescript
interface Middleware {
  name: string;
  on: HookEvent | HookEvent[];           // which SDK events to intercept
  match?: string | string[];              // tool name filter (optional)
  handler: (
    event: MiddlewareEvent,
    context: MiddlewareContext,
  ) => Promise<MiddlewareResult>;
}

// Event data varies by hook type
interface MiddlewareEvent {
  hookEvent: "PreToolUse" | "PostToolUse" | "Notification";
  sessionId: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  message?: string;                       // for Notification events
}

// Context provides workflow info + shared key-value store
interface MiddlewareContext {
  runId: string;
  workflow: string;
  step: string;
  agent: string;
  repo: string;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

type MiddlewareResult =
  | Record<string, never>                         // pass through
  | { decision: "block"; reason: string }         // block the call
  | { async: true; asyncTimeout: number }         // non-blocking
;
```

## Built-in Middleware

### `loopDetection`

Blocks repeated Bash commands (prevents infinite retry loops).

```typescript
Orchestrator.middleware.loopDetection({
  threshold: 3,              // block after N identical commands
  scope: "session",          // per-session tracking (default)
});
```

### `auditLog`

Records every tool call to a JSONL file.

```typescript
Orchestrator.middleware.auditLog({
  dir: "./neo-logs",          // output directory
  includeInput: true,         // log tool inputs (default: true)
  includeOutput: false,       // log tool outputs (default: false, can be large)
});
```

### `budgetGuard`

Enforces daily cost cap. Doesn't block running sessions but prevents new dispatches.

```typescript
Orchestrator.middleware.budgetGuard();
// Uses budget config from NeoConfig
```

### `rateLimitBackpressure`

When the SDK reports rate limiting, automatically reduce max concurrent sessions.

```typescript
Orchestrator.middleware.rateLimitBackpressure({
  reduceBy: 1,              // reduce maxSessions by N on rate limit
  restoreAfterMs: 60_000,   // restore after 1min of no rate limits
});
```

## Custom Middleware Examples

### Block writes to protected files

```typescript
{
  name: "protected-files",
  on: "PreToolUse",
  match: ["Write", "Edit"],
  handler: async (event) => {
    const filePath = event.toolInput?.file_path as string;
    const blocked = [".env", "pnpm-lock.yaml", "package-lock.json"];
    if (blocked.some(f => filePath?.endsWith(f))) {
      return { decision: "block", reason: `Protected file: ${filePath}` };
    }
    return {};
  },
}
```

### Detect secrets in writes

```typescript
{
  name: "secret-scanner",
  on: "PreToolUse",
  match: ["Write", "Edit"],
  handler: async (event) => {
    const content = (event.toolInput?.content || event.toolInput?.new_string || "") as string;
    const patterns = [
      /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9]{16,}/i,
      /ghp_[A-Za-z0-9]{36}/,            // GitHub PAT
      /sk-[A-Za-z0-9]{48}/,             // OpenAI key
      /xoxb-[0-9]+-[A-Za-z0-9]+/,       // Slack bot token
    ];
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return { decision: "block", reason: "Potential secret detected — aborting write" };
      }
    }
    return {};
  },
}
```

### Log agent actions to Slack

```typescript
{
  name: "slack-logger",
  on: "PostToolUse",
  handler: async (event, context) => {
    if (event.toolName === "Bash" || event.toolName === "Write") {
      await slack.post(`[${context.workflow}/${context.step}] ${event.toolName}: ${
        event.toolInput?.command || event.toolInput?.file_path
      }`);
    }
    return { async: true, asyncTimeout: 5_000 };
  },
}
```

### Restrict network access

```typescript
{
  name: "network-allowlist",
  on: "PreToolUse",
  match: "Bash",
  handler: async (event) => {
    const cmd = (event.toolInput?.command || "") as string;
    if (/curl|wget|fetch|http/.test(cmd)) {
      const allowed = ["github.com", "registry.npmjs.org", "api.anthropic.com"];
      if (!allowed.some(domain => cmd.includes(domain))) {
        return { decision: "block", reason: "Network request to unauthorized domain" };
      }
    }
    return {};
  },
}
```

## Middleware Execution Chain

```
Tool call arrives from SDK
    │
    ▼
┌─ Middleware 1 (loopDetection) ─┐
│  Match? Yes → Run handler      │
│  Result: {} (pass)              │
└────────────────────────────────┘
    │
    ▼
┌─ Middleware 2 (secretScanner) ─┐
│  Match? Yes → Run handler      │
│  Result: { block } → STOP      │──→ Tool call blocked, reason sent to agent
└────────────────────────────────┘
    │ (if pass)
    ▼
┌─ Middleware 3 (auditLog) ──────┐
│  Match? Yes → Run handler      │
│  Result: { async } → continue  │──→ Log written asynchronously
└────────────────────────────────┘
    │
    ▼
Tool call executes
```
