# Neo — Data Model

All core TypeScript types for the framework.

## Configuration

```typescript
// ─── Main config (.neo/config.yml → validated by Zod) ────

interface NeoConfig {
  repos: RepoConfig[];

  concurrency: {
    maxSessions: number;          // default: 5
    maxPerRepo: number;           // default: 2
    queueMax: number;             // default: 50
  };

  budget: {
    dailyCapUsd: number;          // default: 500
    alertThresholdPct: number;    // default: 80
  };

  recovery: {
    maxRetries: number;           // default: 3
    backoffBaseMs: number;        // default: 30_000
  };

  sessions: {
    initTimeoutMs: number;          // default: 120_000 (2 min) — abort if SDK doesn't respond
    maxDurationMs: number;          // default: 3_600_000 (60 min) — absolute session timeout
  };

  mcpServers?: Record<string, McpServerConfig>;
  claudeCodePath?: string;        // default: auto-detect
  idempotency?: {
    enabled: boolean;               // default: true
    key: "metadata" | "prompt";     // what field to deduplicate on (default: "metadata")
    ttlMs: number;                  // how long to remember (default: 3_600_000 = 1h)
  };
}

interface RepoConfig {
  path: string;
  name?: string;
  defaultBranch?: string;         // default: "main"
  branchPrefix?: string;          // default: "feat"
  pushRemote?: string;            // default: "origin"
  autoCreatePr?: boolean;         // default: false
  prBaseBranch?: string;          // default: same as defaultBranch
}

type McpServerConfig =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };
```

## Agents

```typescript
// ─── Agent definition (YAML config) ─────────────────────

interface AgentConfig {
  name: string;
  extends?: string;               // name of a built-in agent to inherit from
  description?: string;           // required if no extends, optional if extending
  model?: AgentModel;             // override model
  tools?: AgentToolEntry[];       // override or extend tools
  prompt?: string;                // inline text, path to .md, or append to inherited
  promptAppend?: string;          // append extra instructions to inherited prompt
  sandbox?: "writable" | "readonly";
  maxTurns?: number;
  mcpServers?: string[];          // references to NeoConfig.mcpServers keys
}

type AgentModel = "opus" | "sonnet" | "haiku";

// Tools can be explicit list OR use $inherited to extend
type AgentToolEntry = AgentTool | "$inherited";

type AgentTool =
  | "Read" | "Write" | "Edit" | "Bash"
  | "Glob" | "Grep" | "Agent"
  | "WebSearch" | "WebFetch"
  | "NotebookEdit";

// ─── Resolved agent (runtime, after merging) ─────────────

interface ResolvedAgent {
  name: string;
  definition: AgentDefinition;    // SDK-compatible (final, merged)
  sandbox: "writable" | "readonly";
  maxTurns?: number;
  source: "built-in" | "custom" | "extended";
}
```

### Agent Resolution Rules

1. **No `extends`** → agent must define all required fields (name, description, model, tools, prompt, sandbox)
2. **With `extends: "developer"`** → start from the built-in `developer` definition, then apply overrides:
   - `model`, `sandbox`, `maxTurns`, `mcpServers` → simple replace
   - `description` → replace if provided, else inherit
   - `prompt` → replace if provided. Use `promptAppend` to add to inherited prompt
   - `tools: [Read, Write]` → replaces entire tool list
   - `tools: [$inherited, WebSearch]` → keeps inherited tools + adds WebSearch
3. **Same name as built-in** → treated as `extends: <name>` implicitly (backward compat)

### YAML Examples

```yaml
# Extend built-in: just change model and add a tool
extends: developer
model: sonnet
tools:
  - $inherited
  - WebSearch
promptAppend: |
  Additional rules for this project:
  - Always use Playwright for e2e tests
  - Never modify the database schema directly
```

```yaml
# Extend built-in: change nothing except maxTurns
extends: architect
maxTurns: 100
```

```yaml
# Brand new agent
name: db-migrator
description: "Database migration specialist"
model: opus
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: db-migrator.md
```

## Workflows

```typescript
// ─── Workflow definition (from YAML) ─────────────────────

interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: Record<string, WorkflowStepDef | WorkflowGateDef>;
}

interface WorkflowStepDef {
  type?: "step";                  // default, can be omitted
  agent: string;                  // agent name reference
  dependsOn?: string[];           // step/gate names (default: previous step)
  prompt?: string;                // static prompt override or template
  sandbox?: "writable" | "readonly";  // override agent's sandbox
  maxTurns?: number;
  mcpServers?: string[];
  recovery?: {
    maxRetries?: number;
    nonRetryable?: string[];        // error types that should not be retried
  };
}

interface WorkflowGateDef {
  type: "gate";                   // required to distinguish from step
  dependsOn?: string[];
  description: string;
  timeout?: string;               // e.g. "30m", "2h"
  autoApprove?: boolean;          // for testing/CI
}
```

### YAML Workflow Examples

```yaml
# .neo/workflows/feature.yml — override the built-in feature workflow
name: feature
description: "Plan, implement, review, fix"

steps:
  plan:
    agent: architect
    sandbox: readonly

  approve-plan:
    type: gate
    dependsOn: [plan]
    description: "Review the architecture plan before implementation"
    timeout: 30m

  implement:
    agent: developer
    dependsOn: [approve-plan]

  review:
    agent: reviewer-quality
    dependsOn: [implement]
    sandbox: readonly

  fix:
    agent: fixer
    dependsOn: [review]
    # condition handled at runtime: skip if no critical findings
```

```yaml
# .neo/workflows/full-review.yml — 4 reviewers in parallel
name: full-review
description: "Comprehensive code review with 4 lenses"

steps:
  quality:
    agent: reviewer-quality
    sandbox: readonly
  security:
    agent: reviewer-security
    sandbox: readonly
  perf:
    agent: reviewer-perf
    sandbox: readonly
  coverage:
    agent: reviewer-coverage
    sandbox: readonly
  # No dependsOn → all run in parallel (limited by semaphore)
```

### Run Persistence

```typescript
// ─── Persisted run state (.neo/runs/<runId>.json) ────────
// Serialized after each step completes. Enables:
// - Resume from a specific step
// - Retry a failed step
// - Inspect what happened

interface PersistedRun {
  version: 1;                       // schema version for future migration
  runId: string;
  workflow: string;
  repo: string;
  prompt: string;
  branch?: string;
  worktreePath?: string;
  status: "running" | "paused" | "completed" | "failed";
  steps: Record<string, StepResult>;
  createdAt: string;
  updatedAt: string;

  // User-defined metadata — passed at dispatch, persisted, included in all events.
  // The supervisor uses this to track external references (ticket IDs, PR numbers, etc.)
  metadata?: Record<string, unknown>;
}
```

### Metadata

Metadata is an opaque key-value bag that the supervisor attaches to a run. Neo persists it and includes it in every event emitted for that run, but never interprets it.

**Use cases:**
- Link a run to a ticket: `{ notionId: "abc-123", linearId: "PROJ-42" }`
- Track who triggered it: `{ triggeredBy: "slack-bot", channel: "#dev" }`
- Pass context to callbacks: `{ prNumber: 51, repository: "org/app" }`

**CLI:**
```bash
# Pass metadata as JSON via --meta flag
neo run feature --repo ./my-app --prompt "Add OAuth2" \
  --meta '{"ticketId": "PROJ-42", "notionId": "abc-123", "priority": "high"}'

# Metadata persists across resume/retry
neo run feature --run-id run-abc123 --from implement
# → metadata from the original dispatch is preserved

# Update metadata on an existing run
neo runs run-abc123 --set-meta '{"prNumber": 51}'

# Filter runs by metadata
neo runs --filter 'ticketId=PROJ-42'
```

**TypeScript API:**
```typescript
const result = await neo.dispatch({
  workflow: "feature",
  repo: "./my-app",
  prompt: "Add OAuth2",
  metadata: {
    ticketId: "PROJ-42",
    notionId: "abc-123",
    source: "linear-webhook",
  },
});

// Metadata flows into every event
neo.on("session:complete", (event) => {
  // event.metadata.ticketId === "PROJ-42"
  linear.updateIssue(event.metadata.ticketId, { status: "done" });
});
```

**In events:**
```typescript
// Every event includes the run's metadata
interface SessionStartEvent {
  type: "session:start";
  sessionId: string;
  runId: string;
  // ...
  metadata?: Record<string, unknown>;  // from the dispatch
}
```

This is how the supervisor bridges neo with external systems (Linear, Notion, Jira, Slack) without neo needing to know about any of them.

```typescript

interface StepResult {
  status: "pending" | "running" | "success" | "failure" | "skipped";
  sessionId?: string;
  output?: unknown;               // structured output if schema was provided
  rawOutput?: string;             // raw agent text
  costUsd: number;
  durationMs: number;
  agent: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;                 // error message if failed
  attempt: number;                // retry count
}
```

### CLI Run Commands

The supervisor (user's script or manual) drives the workflow via CLI:

```bash
# ─── Launch a full workflow ───────────────────────────────
neo run feature --repo ./my-app --prompt "Add OAuth2 login"
# → run-id: run-abc123
# → executes all steps in order, respecting DAG

# ─── Launch a single step ─────────────────────────────────
neo run feature --step plan --repo ./my-app --prompt "Add OAuth2 login"
# → run-id: run-abc123
# → only executes the "plan" step, persists run state, exits

# ─── Resume from a step (uses persisted context) ──────────
neo run feature --run-id run-abc123 --from implement
# → loads run-abc123 context (plan output is available)
# → executes implement + everything after it

# ─── Retry a failed step ──────────────────────────────────
neo run feature --run-id run-abc123 --retry implement
# → re-runs only the "implement" step, keeps all other results
# → does NOT re-run downstream steps (user decides when)

# ─── Approve a gate ───────────────────────────────────────
neo gate approve run-abc123 approve-plan
neo gate reject run-abc123 approve-plan --reason "Plan is too complex"

# ─── Inspect a run ────────────────────────────────────────
neo runs                          # list all runs
neo runs run-abc123               # detailed view of a specific run
neo runs run-abc123 --step plan   # output of a specific step
```

## Workflow Execution Context

```typescript
// ─── Runtime context (in-memory during execution) ────────

interface WorkflowContext {
  runId: string;
  workflow: string;
  repo: string;
  prompt: string;                 // original dispatch prompt
  steps: Record<string, StepResult>;
  startedAt: Date;

  // Set by the runner when executing a step — the step's prompt
  // can reference prior outputs via {{steps.plan.output}} templates
}
```

## Task Dispatch

```typescript
// ─── Dispatch input ──────────────────────────────────────

interface DispatchInput {
  workflow: string;               // workflow name
  repo: string;                   // repo path
  prompt: string;                 // what to do

  // Run control (for supervisor-driven orchestration)
  runId?: string;                 // resume an existing run
  step?: string;                  // run only this step
  from?: string;                  // run from this step onward
  retry?: string;                 // retry this specific step

  priority?: Priority;
  overrides?: {
    agents?: Record<string, string>;  // step → agent name mapping
    maxTurns?: number;
    sandbox?: "writable" | "readonly";
  };
  metadata?: Record<string, unknown>; // user-defined, passed through events
}

type Priority = "critical" | "high" | "medium" | "low";

// ─── Dispatch result ─────────────────────────────────────

interface TaskResult {
  runId: string;
  workflow: string;
  repo: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  steps: Record<string, StepResult>;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  summary?: string;
  costUsd: number;                // total across all steps
  durationMs: number;             // wall clock
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

## Sessions

```typescript
// ─── Active session tracking ─────────────────────────────

interface ActiveSession {
  sessionId: string;
  runId: string;
  workflow: string;
  step: string;
  agent: string;
  repo: string;
  status: "running" | "queued" | "waiting_gate";
  startedAt: string;
  worktreePath?: string;
}

// ─── Orchestrator status ─────────────────────────────────

interface OrchestratorStatus {
  paused: boolean;
  activeSessions: ActiveSession[];
  queueDepth: number;
  costToday: number;
  budgetCapUsd: number;
  budgetRemainingPct: number;
  uptime: number;
}
```

## Events

```typescript
// ─── Event types (what neo.on() emits) ──────────────────

interface SessionStartEvent {
  type: "session:start";
  sessionId: string;
  runId: string;
  workflow: string;
  step: string;
  agent: string;
  repo: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface SessionCompleteEvent {
  type: "session:complete";
  sessionId: string;
  runId: string;
  status: "success" | "failure";
  costUsd: number;
  durationMs: number;
  output?: unknown;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface SessionFailEvent {
  type: "session:fail";
  sessionId: string;
  runId: string;
  error: string;
  attempt: number;
  maxRetries: number;
  willRetry: boolean;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface AgentToolUseEvent {
  type: "agent:tool_use";
  sessionId: string;
  agent: string;
  tool: string;
  input: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
}

interface AgentMessageEvent {
  type: "agent:message";
  sessionId: string;
  agent: string;
  text: string;
  timestamp: string;
}

interface WorkflowStepStartEvent {
  type: "workflow:step_start";
  runId: string;
  step: string;
  agent: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface WorkflowStepCompleteEvent {
  type: "workflow:step_complete";
  runId: string;
  step: string;
  status: "success" | "failure" | "skipped";
  costUsd: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface GateWaitingEvent {
  type: "gate:waiting";
  runId: string;
  gate: string;
  description: string;
  context: WorkflowContext;
  approve: () => void;
  reject: (reason: string) => void;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface CostUpdateEvent {
  type: "cost:update";
  sessionId: string;
  sessionCost: number;
  todayTotal: number;
  budgetRemainingPct: number;
  timestamp: string;
}

interface BudgetAlertEvent {
  type: "budget:alert";
  todayTotal: number;
  capUsd: number;
  utilizationPct: number;
  timestamp: string;
}

interface QueueEnqueueEvent {
  type: "queue:enqueue";
  sessionId: string;
  repo: string;
  position: number;
  timestamp: string;
}

interface QueueDequeueEvent {
  type: "queue:dequeue";
  sessionId: string;
  repo: string;
  waitedMs: number;
  timestamp: string;
}

// ─── Union type ──────────────────────────────────────────

type NeoEvent =
  | SessionStartEvent
  | SessionCompleteEvent
  | SessionFailEvent
  | AgentToolUseEvent
  | AgentMessageEvent
  | WorkflowStepStartEvent
  | WorkflowStepCompleteEvent
  | GateWaitingEvent
  | CostUpdateEvent
  | BudgetAlertEvent
  | QueueEnqueueEvent
  | QueueDequeueEvent;
```

## Middleware

```typescript
// ─── Middleware interface ─────────────────────────────────

type HookEvent = "PreToolUse" | "PostToolUse" | "Notification";

interface Middleware {
  name: string;
  on: HookEvent;
  match?: string | string[];      // tool name filter (optional)
  handler: MiddlewareHandler;
}

type MiddlewareHandler = (
  event: MiddlewareEvent,
  context: MiddlewareContext,
) => Promise<MiddlewareResult>;

interface MiddlewareEvent {
  hookEvent: HookEvent;
  sessionId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  message?: string;
}

interface MiddlewareContext {
  runId: string;
  workflow: string;
  step: string;
  agent: string;
  repo: string;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

type MiddlewareResult =
  | {}                                      // pass through
  | { decision: "block"; reason: string }   // block the tool call
  | { async: true; asyncTimeout: number }   // non-blocking
;
```

## Cost & Metrics

```typescript
// ─── Cost tracking ───────────────────────────────────────

interface CostEntry {
  timestamp: string;
  runId: string;
  workflow: string;
  step: string;
  sessionId: string;
  agent: string;
  costUsd: number;
  models: Record<string, number>; // model → token count
  durationMs: number;
}

// ─── Metrics ─────────────────────────────────────────────

interface MetricsSnapshot {
  activeSessions: number;
  queueDepth: number;
  costToday: number;
  successRate: number;            // last 24h
  avgDurationMs: number;          // last 24h
  totalRuns: number;              // last 24h
}

interface AgentMetrics {
  agent: string;
  totalRuns: number;
  successRate: number;
  avgCostUsd: number;
  avgDurationMs: number;
  retryRate: number;
}
```
