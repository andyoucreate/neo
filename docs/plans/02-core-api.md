# Neo — Core API Design

## Orchestrator (main entry point)

```typescript
import { Orchestrator } from "@neo-cli/core";

const neo = new Orchestrator({
  repos: ["/path/to/my-app", "/path/to/shared-lib"],
  concurrency: {
    maxSessions: 5,        // global max
    maxPerRepo: 2,         // per-repo max
    queueMax: 50,          // max queued dispatches
  },
  budget: {
    dailyCapUsd: 100,
    alertThresholdPct: 80,
  },
  recovery: {
    maxRetries: 3,
    backoffBaseMs: 30_000,
  },
  agents: {
    // Merge built-in + custom
    ...neo.agents.defaults,
    "qa-tester": neo.agents.fromFile("./.neo/agents/qa-tester.yml"),
  },
  middleware: [
    neo.middleware.loopDetection({ threshold: 3 }),
    neo.middleware.auditLog({ dir: "./logs" }),
    neo.middleware.budgetGuard(),
  ],
  mcpServers: {
    context7: { type: "http", url: "https://mcp.context7.com/mcp" },
  },
});
```

## Dispatching Tasks

```typescript
// Simple dispatch — use a built-in workflow
const result = await neo.dispatch({
  workflow: "feature",
  repo: "/path/to/my-app",
  prompt: "Add user authentication with OAuth2 and Google provider",
});

// result: TaskResult
// result.status: "success" | "failure" | "timeout" | "cancelled"
// result.prUrl: "https://github.com/..."
// result.costUsd: 4.20
// result.durationMs: 180000
// result.steps: { architect: StepResult, developer: StepResult }

// Dispatch with overrides
const result = await neo.dispatch({
  workflow: "feature",
  repo: "/path/to/my-app",
  prompt: "...",
  overrides: {
    agents: ["my-custom-developer"],  // replace default developer
    maxTurns: 50,
  },
});
```

## Event System

All events are typed. Users subscribe to build their own supervisor.

```typescript
// ─── Session lifecycle ───────────────────────────────────
neo.on("session:start", (event: SessionStartEvent) => {
  // { sessionId, workflow, repo, agent, startedAt }
});

neo.on("session:complete", (event: SessionCompleteEvent) => {
  // { sessionId, status, costUsd, durationMs, output }
});

neo.on("session:fail", (event: SessionFailEvent) => {
  // { sessionId, error, attempt, willRetry }
});

// ─── Agent activity (granular) ───────────────────────────
neo.on("agent:tool_use", (event: AgentToolUseEvent) => {
  // { sessionId, agent, tool, input, output, durationMs }
});

neo.on("agent:message", (event: AgentMessageEvent) => {
  // { sessionId, agent, text }
});

// ─── Workflow progress ───────────────────────────────────
neo.on("workflow:step_start", (event: WorkflowStepStartEvent) => {
  // { runId, step, agent, dependenciesMet }
});

neo.on("workflow:step_complete", (event: WorkflowStepCompleteEvent) => {
  // { runId, step, status, output, costUsd }
});

// ─── Approval gates ──────────────────────────────────────
neo.on("gate:waiting", (event: GateWaitingEvent) => {
  // { runId, gate, description, context, approve(), reject(reason) }
});

// ─── Cost & budget ───────────────────────────────────────
neo.on("cost:update", (event: CostUpdateEvent) => {
  // { todayTotal, sessionCost, budgetRemainingPct }
});

neo.on("budget:alert", (event: BudgetAlertEvent) => {
  // { todayTotal, capUsd, utilizationPct }
});

// ─── Queue ───────────────────────────────────────────────
neo.on("queue:enqueue", (event: QueueEvent) => {
  // { sessionId, position, repo }
});

neo.on("queue:dequeue", (event: QueueEvent) => {
  // { sessionId, waitedMs }
});

// ─── Wildcard ────────────────────────────────────────────
neo.on("*", (event) => { /* everything */ });
neo.on("session:*", (event) => { /* all session events */ });
```

## Control

```typescript
neo.pause();                          // stop accepting new dispatches
neo.resume();                         // resume accepting dispatches
neo.kill(sessionId);                  // abort a running session
neo.drain();                          // finish active, reject new, resolve when empty

// Inspect
neo.status;                           // { paused, activeSessions, queueDepth, ... }
neo.activeSessions;                   // ActiveSession[]
neo.metrics.successRate("feature");   // 0.85
neo.metrics.avgCostUsd("review");     // 2.30
neo.metrics.costToday();              // 42.50
```

## Workflows (YAML-first, CLI-driven)

Workflows are declarative YAML files. The supervisor (user's code or human) drives execution via `neo run` commands.

### Defining a workflow

```yaml
# .neo/workflows/feature.yml
name: feature
description: "Plan → approve → implement → review → fix"

steps:
  plan:
    agent: architect
    sandbox: readonly

  approve-plan:
    type: gate
    dependsOn: [plan]
    description: "Review the architecture plan"
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
```

```yaml
# .neo/workflows/full-review.yml — parallel steps (no dependsOn = parallel)
name: full-review
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
```

### Running workflows via CLI

```bash
# Full auto: run all steps
neo run feature --repo ./my-app --prompt "Add user auth"

# Step by step (supervisor decides when to proceed):
neo run feature --step plan --repo ./my-app --prompt "Add user auth"
# → run-id: run-abc123

# Review the plan output, then continue:
neo runs run-abc123 --step plan     # inspect plan output
neo run feature --run-id run-abc123 --from implement

# Retry a failed step without re-running everything:
neo run feature --run-id run-abc123 --retry implement

# Approve/reject gates:
neo gate approve run-abc123 approve-plan
```

### Running workflows via TypeScript API

```typescript
// Full auto
const result = await neo.dispatch({
  workflow: "feature",
  repo: "/path/to/my-app",
  prompt: "Add user authentication",
});

// Step by step
const run = await neo.dispatch({
  workflow: "feature",
  repo: "/path/to/my-app",
  prompt: "Add user authentication",
  step: "plan",     // only run the plan step
});

// Resume from a step
await neo.dispatch({
  workflow: "feature",
  runId: run.runId,
  from: "implement",  // run implement + everything after
});

// Retry a failed step
await neo.dispatch({
  workflow: "feature",
  runId: run.runId,
  retry: "implement",
});
```

## Agent Configuration

### Built-in agents (shipped with @neo-cli/agents)

- `architect` — plans and decomposes (read-only, Opus)
- `developer` — implements tasks in worktrees (writable, Opus)
- `refiner` — evaluates and splits vague tickets (read-only, Opus)
- `reviewer-quality` — code quality review (read-only, Sonnet)
- `reviewer-security` — security audit (read-only, Opus)
- `reviewer-perf` — performance review (read-only, Sonnet)
- `reviewer-coverage` — test coverage review (read-only, Sonnet)
- `fixer` — auto-corrects issues from reviewers (writable, Opus)

### Extending built-in agents (partial override)

Users reconfigure built-in agents by creating a YAML file with `extends`:

```yaml
# .neo/agents/developer.yml — tweak the built-in developer
extends: developer
model: sonnet                     # cheaper model
maxTurns: 50                      # higher limit
tools:
  - $inherited                    # keep all built-in tools
  - WebSearch                     # add web search capability
promptAppend: |
  Additional rules for this project:
  - Use Vitest for all tests
  - Follow the existing service pattern in src/services/
```

```yaml
# .neo/agents/architect.yml — just raise the turn limit
extends: architect
maxTurns: 100
```

The `$inherited` token in tools means "keep whatever the parent defines, then add these." Without it, the tools list is a full replacement.

### Brand new agents

```yaml
# .neo/agents/qa-tester.yml — no extends, fully custom
name: qa-tester
description: "Writes end-to-end tests for implemented features"
model: sonnet
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: qa-tester.md          # loads .neo/agents/qa-tester.md
maxTurns: 30
mcpServers: [context7]        # references from main config
```

### Listing resolved agents

```bash
neo agents
# NAME              MODEL   SANDBOX    SOURCE
# architect         opus    readonly   extended (.neo/agents/architect.yml)
# developer         sonnet  writable   extended (.neo/agents/developer.yml)
# refiner           opus    readonly   built-in
# reviewer-quality  sonnet  readonly   built-in
# reviewer-security opus    readonly   built-in
# reviewer-perf     sonnet  readonly   built-in
# reviewer-coverage sonnet  readonly   built-in
# fixer             opus    writable   built-in
# qa-tester         sonnet  writable   custom (.neo/agents/qa-tester.yml)
```

## Middleware

```typescript
import { Orchestrator } from "@neo-cli/core";

const neo = new Orchestrator({
  middleware: [
    // ─── Built-in middleware ───────────────────────────
    Orchestrator.middleware.loopDetection({ threshold: 3 }),
    Orchestrator.middleware.auditLog({ dir: "./neo-logs" }),
    Orchestrator.middleware.budgetGuard(),
    Orchestrator.middleware.rateLimitBackpressure(),

    // ─── Custom middleware ─────────────────────────────
    {
      name: "block-secrets",
      on: "PreToolUse",
      match: ["Write", "Edit"],
      handler: async (event, context) => {
        const content = event.input.content || event.input.new_string || "";
        if (/(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']+/.test(content)) {
          return { decision: "block", reason: "Potential secret detected in write operation" };
        }
        return {};
      },
    },

    {
      name: "protected-files",
      on: "PreToolUse",
      match: ["Write", "Edit"],
      handler: async (event) => {
        const protectedPaths = [".env", "package-lock.json", "pnpm-lock.yaml"];
        if (protectedPaths.some(p => event.input.file_path?.endsWith(p))) {
          return { decision: "block", reason: `Cannot modify protected file: ${event.input.file_path}` };
        }
        return {};
      },
    },
  ],
});
```

## Structured Output

Steps can declare an `outputSchema` in YAML. Neo injects format instructions into the agent prompt, extracts JSON from the output, and validates it with Zod at runtime.

```yaml
# .neo/workflows/refine.yml
name: refine
steps:
  evaluate:
    agent: refiner
    sandbox: readonly
    outputSchema:
      type: object
      properties:
        action:
          type: string
          enum: [pass_through, decompose, escalate]
        score:
          type: number
          min: 0
          max: 100
        reason:
          type: string
        subTickets:
          type: array
          optional: true
          items:
            type: object
            properties:
              title: { type: string }
              description: { type: string }
              files: { type: array, items: { type: string } }
              complexity: { type: number }
        questions:
          type: array
          optional: true
          items: { type: string }
```

Neo automatically:
1. Converts the YAML schema to a Zod validator at load time
2. Appends format instructions to the agent prompt
3. Extracts JSON from the agent's output
4. Validates against the schema
5. Makes `result.steps.evaluate.output` fully typed

## Metrics

```typescript
// Programmatic access
neo.metrics.successRate("feature");           // 0.85
neo.metrics.successRate();                    // 0.90 (all workflows)
neo.metrics.avgCostUsd("review");             // 2.30
neo.metrics.avgDurationMs("feature");         // 180_000
neo.metrics.retryRate();                      // 0.12
neo.metrics.costToday();                      // 42.50
neo.metrics.costByDay({ days: 7 });           // [{ date, total, byWorkflow }]
neo.metrics.agentPerformance("developer");    // { successRate, avgCost, avgDuration }

// Prometheus export
app.get("/metrics", (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send(neo.metrics.prometheus());
});

// Event-based
neo.on("metrics:snapshot", (snapshot) => {
  datadog.gauge("neo.sessions.active", snapshot.activeSessions);
  datadog.gauge("neo.cost.today", snapshot.costToday);
});
```
