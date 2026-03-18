# @neotx/core

Orchestration engine for autonomous developer agents. This is the programmatic API that powers the `neo` CLI.

## Installation

```bash
npm install @neotx/core
# or
pnpm add @neotx/core
```

Requires Node.js >= 22 and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

## Quick Start

```typescript
import { AgentRegistry, loadConfig, Orchestrator } from "@neotx/core";

const config = await loadConfig("~/.neo/config.yml");

const orchestrator = new Orchestrator(config, {
  journalDir: ".neo/journals",
  middleware: [
    Orchestrator.middleware.budgetGuard(),
    Orchestrator.middleware.loopDetection({ threshold: 5 }),
  ],
});

// Load agents from YAML files
const registry = new AgentRegistry("path/to/built-in-agents", "path/to/custom-agents");
await registry.load();
for (const agent of registry.list()) {
  orchestrator.registerAgent(agent);
}

// Start the orchestrator
await orchestrator.start();

// Dispatch a task
const result = await orchestrator.dispatch({
  agent: "developer",
  repo: "/path/to/repo",
  prompt: "Add rate limiting to the API",
  priority: "high",
});

console.log(result.status);   // "success" | "failure"
console.log(result.branch);   // "feat/run-<uuid>"
console.log(result.costUsd);  // 0.1842

await orchestrator.shutdown();
```

## API Reference

### `loadConfig(path: string): Promise<NeoConfig>`

Load configuration from a YAML file.

```typescript
import { loadConfig, loadGlobalConfig } from "@neotx/core";

// Load from a specific path
const config = await loadConfig(".neo/config.yml");

// Load from ~/.neo/config.yml (creates with defaults if missing)
const globalConfig = await loadGlobalConfig();
```

### `Orchestrator`

The main orchestration class. Extends `NeoEventEmitter` for typed event subscriptions.

```typescript
import { Orchestrator } from "@neotx/core";

const orchestrator = new Orchestrator(config, {
  middleware: [...],           // Optional middleware array
  journalDir: ".neo/journals", // Directory for JSONL journals
});
```

#### Lifecycle

```typescript
// Start the orchestrator (initializes journals, restores cost state)
await orchestrator.start();

// Graceful shutdown (drains active sessions, flushes middleware)
await orchestrator.shutdown();

// Pause/resume dispatch (active sessions continue, new dispatches rejected)
orchestrator.pause();
orchestrator.resume();

// Drain all active sessions
await orchestrator.drain();

// Kill a specific session
await orchestrator.kill(sessionId);
```

#### Registration

```typescript
// Register an agent
orchestrator.registerAgent({
  name: "developer",
  definition: { description: "...", prompt: "...", tools: [...], model: "opus" },
  sandbox: "writable",
  source: "built-in",
});
```

#### Dispatch

```typescript
const result = await orchestrator.dispatch({
  agent: "developer",         // Agent name (required)
  repo: "/path/to/repo",      // Repository path (required)
  prompt: "Add feature X",    // Task prompt (required)
  runId: "custom-id",         // Optional custom run ID
  priority: "high",           // "critical" | "high" | "medium" | "low"
  metadata: { ticket: "123" }, // Arbitrary metadata (passed through events)
});
```

Returns a `TaskResult`:

```typescript
interface TaskResult {
  runId: string;
  agent: string;
  repo: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  branch?: string;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

#### Status

```typescript
const status = orchestrator.status;
// {
//   paused: false,
//   activeSessions: [...],
//   queueDepth: 3,
//   costToday: 12.50,
//   budgetCapUsd: 500,
//   budgetRemainingPct: 97.5,
//   uptime: 3600000,
// }

const sessions = orchestrator.activeSessions;
// [{ sessionId, runId, agent, repo, status, startedAt }]
```

### `AgentRegistry`

Load and manage agent definitions from YAML files.

```typescript
import { AgentRegistry } from "@neotx/core";

const registry = new AgentRegistry(
  "path/to/built-in-agents",  // Built-in agent directory
  "path/to/custom-agents",    // Optional custom agent directory
);

await registry.load();

const agent = registry.get("developer");
const allAgents = registry.list();
const hasAgent = registry.has("developer");
```

Agents support inheritance via `extends`:

```yaml
# custom-agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger.
```

## Events

The orchestrator emits typed events for real-time monitoring:

```typescript
orchestrator.on("session:start", (event) => {
  // { type, sessionId, runId, agent, repo, metadata, timestamp }
});

orchestrator.on("session:complete", (event) => {
  // { type, sessionId, runId, status, costUsd, durationMs, output, metadata, timestamp }
});

orchestrator.on("session:fail", (event) => {
  // { type, sessionId, runId, error, attempt, maxRetries, willRetry, metadata, timestamp }
});

orchestrator.on("cost:update", (event) => {
  // { type, sessionId, sessionCost, todayTotal, budgetRemainingPct, timestamp }
});

orchestrator.on("budget:alert", (event) => {
  // { type, todayTotal, capUsd, utilizationPct, timestamp }
});

orchestrator.on("queue:enqueue", (event) => {
  // { type, sessionId, repo, position, timestamp }
});

orchestrator.on("queue:dequeue", (event) => {
  // { type, sessionId, repo, waitedMs, timestamp }
});

// Subscribe to all events
orchestrator.on("*", (event) => {
  console.log(event.type, event);
});
```

Events are also persisted to JSONL journals in `journalDir`.

## Middleware

Extend orchestrator behavior with middleware hooks. Middleware runs on every tool call within agent sessions.

### Built-in Middleware

```typescript
const orchestrator = new Orchestrator(config, {
  middleware: [
    // Block tool calls when over budget
    Orchestrator.middleware.budgetGuard(),

    // Detect repeated commands and force escalation
    Orchestrator.middleware.loopDetection({
      threshold: 5,      // Block after 5 identical commands
      scope: "session",  // Track per session
    }),

    // JSONL audit trail of all tool calls
    Orchestrator.middleware.auditLog({
      dir: ".neo/audit",
      includeInput: true,   // Log tool inputs
      includeOutput: false, // Skip tool outputs
      flushIntervalMs: 500, // Flush buffer interval
      flushSize: 20,        // Flush after N entries
    }),
  ],
});
```

### Custom Middleware

```typescript
import type { Middleware } from "@neotx/core";

const customMiddleware: Middleware = {
  name: "my-middleware",
  on: "PreToolUse",         // "PreToolUse" | "PostToolUse" | "Notification"
  match: "Bash",            // Optional: only match specific tools
  async handler(event, context) {
    // event: { hookEvent, sessionId, toolName, input, output, message }
    // context: { runId, agent, repo, get, set }

    const costToday = context.get("costToday");

    if (someCondition) {
      return { decision: "block", reason: "Blocked by policy" };
    }

    return { decision: "pass" };
  },
};
```

Middleware results:
- `{ decision: "pass" }` — continue execution
- `{ decision: "block", reason: string }` — block the tool call
- `{ decision: "async", asyncTimeout: number }` — non-blocking (for logging)

## Recovery System

Sessions use 3-level recovery escalation:

| Attempt | Strategy | Description |
|---------|----------|-------------|
| 1 | `normal` | Fresh session |
| 2 | `resume` | Resume previous session with context continuity |
| 3 | `fresh` | Clean slate, no previous context |

```typescript
import { runWithRecovery } from "@neotx/core";

const result = await runWithRecovery({
  agent,
  prompt: "...",
  repoPath: "/path/to/repo",
  sandboxConfig,
  hooks,
  initTimeoutMs: 120_000,
  maxDurationMs: 3_600_000,
  maxRetries: 3,
  backoffBaseMs: 30_000,
  nonRetryable: ["error_max_turns", "budget_exceeded"],
  onAttempt: (attempt, strategy) => {
    console.log(`Attempt ${attempt}: ${strategy}`);
  },
});
```

Non-retryable errors (auth failures, budget exceeded, max turns) skip retries entirely.

## Isolation & Clones

Each writable agent runs in an isolated git clone (`git clone --local`). The main branch is never touched.

```typescript
import {
  createSessionClone,
  removeSessionClone,
  listSessionClones,
} from "@neotx/core";

// Create a session clone with a new branch
const info = await createSessionClone({
  repoPath: "/path/to/repo",
  branch: "feat/run-abc123",
  baseBranch: "main",
  sessionDir: "/tmp/neo-sessions/abc123",
});
// { path, branch, repoPath }

// List all session clones
const clones = await listSessionClones("/tmp/neo-sessions");

// Remove a session clone (branch preserved for PR)
await removeSessionClone(info.path);
```

Each clone is fully independent — no shared git state, no mutex needed.

## Concurrency Control

The orchestrator uses a priority semaphore with global and per-repo limits:

```typescript
import { Semaphore } from "@neotx/core";

const semaphore = new Semaphore(
  {
    maxSessions: 5,   // Total concurrent sessions
    maxPerRepo: 4,    // Max sessions per repository
    queueMax: 50,     // Max queued dispatches
  },
  {
    onEnqueue: (sessionId, repo, position) => { ... },
    onDequeue: (sessionId, repo, waitedMs) => { ... },
  },
);

// Acquire a slot (blocks if at capacity)
await semaphore.acquire(repo, sessionId, "high", abortSignal);

// Release when done
semaphore.release(sessionId);

// Non-blocking check
if (semaphore.isAvailable(repo)) { ... }

// Status
semaphore.activeCount();
semaphore.activeCountForRepo(repo);
semaphore.queueDepth();
```

Priority levels: `"critical"` > `"high"` > `"medium"` > `"low"`

## Cost Tracking

Costs are tracked in append-only JSONL journals with monthly rotation.

```typescript
import { CostJournal } from "@neotx/core";

const journal = new CostJournal({ dir: ".neo/journals" });

// Append a cost entry
await journal.append({
  timestamp: new Date().toISOString(),
  runId: "...",
  sessionId: "...",
  agent: "developer",
  costUsd: 0.0842,
  models: { "claude-3-opus": 0.0842 },
  durationMs: 45000,
  repo: "/path/to/repo",
});

// Get today's total (cached)
const todayTotal = await journal.getDayTotal();

// Get a specific day's total
const yesterdayTotal = await journal.getDayTotal(new Date("2024-01-15"));
```

## Configuration

Configuration schema (Zod-validated):

```yaml
# ~/.neo/config.yml

repos:
  - path: /path/to/repo
    defaultBranch: main
    branchPrefix: feat
    pushRemote: origin
    autoCreatePr: false

concurrency:
  maxSessions: 5
  maxPerRepo: 4
  queueMax: 50

budget:
  dailyCapUsd: 500
  alertThresholdPct: 80

recovery:
  maxRetries: 3
  backoffBaseMs: 30000

sessions:
  initTimeoutMs: 120000
  maxDurationMs: 3600000

webhooks:
  - url: https://example.com/webhook
    events: ["session:complete", "budget:alert"]
    secret: "webhook-secret"
    timeoutMs: 5000

mcpServers:
  linear:
    type: http
    url: https://mcp.linear.app
    headers:
      Authorization: "Bearer ${LINEAR_API_KEY}"

idempotency:
  enabled: true
  key: metadata  # or "prompt"
  ttlMs: 3600000
```

### Repo Management

```typescript
import {
  addRepoToGlobalConfig,
  removeRepoFromGlobalConfig,
  listReposFromGlobalConfig,
} from "@neotx/core";

// Add a repo
await addRepoToGlobalConfig({
  path: "/path/to/repo",
  defaultBranch: "main",
  branchPrefix: "feat",
});

// Remove a repo (by path, name, or slug)
await removeRepoFromGlobalConfig("/path/to/repo");

// List all registered repos
const repos = await listReposFromGlobalConfig();
```

## Types

Key types exported from the package:

```typescript
import type {
  // Config
  NeoConfig,
  RepoConfig,
  McpServerConfig,

  // Agents
  ResolvedAgent,
  AgentConfig,
  AgentDefinition,

  // Dispatch
  DispatchInput,
  TaskResult,
  StepResult,
  Priority,

  // Sessions
  ActiveSession,
  OrchestratorStatus,
  SessionOptions,
  SessionResult,

  // Events
  NeoEvent,
  SessionStartEvent,
  SessionCompleteEvent,
  SessionFailEvent,
  CostUpdateEvent,
  BudgetAlertEvent,

  // Middleware
  Middleware,
  MiddlewareContext,
  MiddlewareEvent,
  MiddlewareResult,

  // Cost
  CostEntry,
} from "@neotx/core";
```

## License

MIT
