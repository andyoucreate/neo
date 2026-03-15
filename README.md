# neo

Orchestration framework for autonomous developer agents. Wraps the Claude Agent SDK with worktree isolation, 3-level recovery, DAG workflows, concurrency control, budget guards, and real-time cost tracking.

Instead of hiring, you give a supervisor agent the ability to dispatch, monitor, and recover developer agents across your repositories. neo is the layer between the supervisor and the agents it manages.

Zero infrastructure — no database, no Redis, no Docker.

```
┌─────────────────────────────────────┐
│           SUPERVISOR                │
│  Claude Code loop, custom script,   │
│  or human at the terminal           │
└──────────────┬──────────────────────┘
               │ dispatches via CLI or API
               v
┌─────────────────────────────────────┐
│              NEO                    │
│  isolation · recovery · budget      │
│  concurrency · events · journals    │
└──────────────┬──────────────────────┘
               │ spawns in isolated worktrees
               v
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ dev  │ │ arch │ │ fix  │ │review│
│agent │ │agent │ │agent │ │agent │
└──────┘ └──────┘ └──────┘ └──────┘
```

## Install

```bash
npm install -g neotx
```

## Quickstart

```bash
# Initialize in your repo
cd your-project
neo init --budget 100

# Dispatch an agent (runs detached, returns immediately)
neo run developer --prompt "Add input validation to the user registration endpoint"

# Monitor
neo runs                   # list all runs with status, cost, duration
neo logs -f --run <id>     # tail a running agent's output
neo cost                   # today's spend and breakdown by agent

# Start the supervisor daemon with TUI
neo supervise
```

## CLI

```
neo init        Initialize a .neo/ project directory and register the repo
neo run         Dispatch an agent (detached by default, returns run ID)
neo runs        List runs or inspect a specific run
neo logs        Show event logs from journals
neo cost        Show cost breakdown (today, by agent, by run)
neo agents      List available agents
neo repos       Manage registered repositories
neo supervise   Start supervisor daemon + TUI
neo mcp         Manage MCP server integrations
neo doctor      Check environment prerequisites
neo log         Log a structured message to supervisor activity
```

### neo run

Dispatch an agent to execute a task in an isolated worktree.

```bash
neo run <agent> --prompt "..."

# Runs detached by default — returns the run ID immediately
neo run developer --prompt "Fix the N+1 query in UserService.findAll"

# Run synchronously (blocking)
neo run developer --prompt "..." --sync

# With metadata for traceability
neo run developer --prompt "..." --meta '{"ticketId": "PROJ-123", "stage": "develop"}'

# Target another repo
neo run architect --prompt "Design the notification system" --repo ../other-repo

# Priority levels: critical, high, medium, low
neo run fixer --prompt "..." --priority critical
```

### neo runs

```bash
neo runs                         # table of all runs (current repo)
neo runs <runId>                 # detail view (prefix match)
neo runs --last 5                # last 5 runs
neo runs --status running        # filter: completed, failed, running
neo runs --all                   # all repos
neo runs --short                 # one-line per run (for supervisor agents)
neo runs --output json           # structured JSON
```

### neo logs

```bash
neo logs                         # last 20 events
neo logs --last 50               # last 50
neo logs --type session:fail     # filter by type
neo logs --run abc123            # filter by run ID prefix
neo logs -f --run <runId>        # tail a running agent's log
neo logs --short                 # compact output for supervisors
```

### neo cost

```bash
neo cost                         # today's total, all-time, breakdown by agent
neo cost --short                 # one-liner for supervisors
neo cost --all                   # all repos
neo cost --output json
```

### neo supervise

Manage the autonomous supervisor daemon.

```bash
neo supervise                    # start daemon + open TUI (default)
neo supervise -d                 # start daemon headless (no TUI)
neo supervise --status           # show daemon status
neo supervise --kill             # stop the daemon
neo supervise --message "..."    # send a message to supervisor inbox
```

The supervisor runs a heartbeat loop: it reads events (webhooks, inbox messages, run completions), builds a context prompt with memory and budget status, calls Claude to reason and act, then saves updated memory. It can dispatch agents, check results, chain pipelines, and manage tickets autonomously.

### neo mcp

```bash
neo mcp list                     # list configured MCP servers
neo mcp add linear               # add from preset (linear, notion, github, jira, slack)
neo mcp add custom --type stdio --command npx --args "-y my-server"
neo mcp remove linear
```

MCP servers configured in `~/.neo/config.yml` are propagated to agent sessions that reference them (via agent YAML `mcpServers` field or workflow step config).

### Other commands

```bash
neo init                         # initialize .neo/ and register repo
neo init --budget 50             # set daily budget cap
neo agents                       # list agents (built-in + custom)
neo repos                        # list registered repos
neo repos add ../other-project   # register a repo
neo doctor                       # check prerequisites
neo log decision "Dispatching developer for PROJ-42"  # log to supervisor activity
```

## Agents

5 built-in agents, each with a specific role, model, and sandbox:

| Agent | Role | Model | Sandbox |
|-------|------|-------|---------|
| `architect` | Plans architecture, decomposes features into tasks. Never writes code. | opus | readonly |
| `developer` | Implements features and fixes in isolated worktrees. | opus | writable |
| `fixer` | Fixes issues found by reviewer. Targets root causes. | opus | writable |
| `refiner` | Evaluates tickets and splits vague requirements into precise specs. | opus | readonly |
| `reviewer` | Single-pass review covering quality, security, perf, and test coverage. Approves by default. | sonnet | readonly |

### Custom agents

Drop a YAML file in `.neo/agents/` to define custom agents or extend built-in ones:

```yaml
# .neo/agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger instead of console.log.
  Follow the patterns in src/shared/conventions.ts.
mcpServers:
  - notion
  - github
```

Agents support inheritance with `extends`, tool customization with `$inherited`, per-agent `maxTurns`, and MCP server bindings.

## Workflows

4 built-in DAG workflows that chain agents with dependency ordering:

| Workflow | Steps | Description |
|----------|-------|-------------|
| `feature` | architect → developer → reviewer → fixer | Full feature lifecycle with conditional fix |
| `review` | reviewer | Single-pass review (quality + security + perf + coverage) |
| `hotfix` | developer | Fast-track single agent |
| `refine` | refiner | Evaluate and decompose tickets |

```yaml
# Custom workflow — .neo/workflows/my-pipeline.yml
name: my-pipeline
steps:
  plan:
    agent: architect
    sandbox: readonly
  implement:
    agent: developer
    dependsOn: [plan]
  review:
    agent: reviewer
    dependsOn: [implement]
    sandbox: readonly
```

Steps support `dependsOn` for ordering, `condition` for conditional execution, `sandbox` overrides, and approval gates.

## Configuration

`~/.neo/config.yml` — created by `neo init`:

```yaml
repos:
  - path: "."
    defaultBranch: main
    branchPrefix: feat

concurrency:
  maxSessions: 5          # total concurrent agent sessions
  maxPerRepo: 2            # max sessions per repository
  queueMax: 50             # max queued dispatches

budget:
  dailyCapUsd: 500         # hard daily spending limit
  alertThresholdPct: 80    # emit budget:alert at this threshold

recovery:
  maxRetries: 3            # retry attempts per session (3-level escalation)
  backoffBaseMs: 30000     # base delay between retries

sessions:
  initTimeoutMs: 120000    # timeout waiting for session init
  maxDurationMs: 3600000   # max session duration (1 hour)

supervisor:
  port: 7777               # webhook server port
  idleIntervalMs: 60000    # heartbeat interval
  idleSkipMax: 20          # skip idle checks before sleeping
  dailyCapUsd: 50          # supervisor's own budget

mcpServers:
  notion:
    type: stdio
    command: npx
    args: ["-y", "@anthropic/notion-mcp-server"]
    env:
      NOTION_TOKEN: "..."
  github:
    type: stdio
    command: npx
    args: ["-y", "@anthropic/github-mcp-server"]
    env:
      GITHUB_TOKEN: "..."

webhooks:
  - url: "https://example.com/neo-events"
    events: ["session:complete", "budget:*"]
    secret: "shared-secret"

idempotency:
  enabled: true
  key: metadata
  ttlMs: 3600000
```

## Programmatic API

neo is a framework, not just a CLI. Use `@neotx/core` directly:

```typescript
import { AgentRegistry, loadConfig, Orchestrator } from "@neotx/core";

const config = await loadConfig(".neo/config.yml");

const orchestrator = new Orchestrator(config, {
  journalDir: ".neo/journals",
  middleware: [
    Orchestrator.middleware.budgetGuard(),
    Orchestrator.middleware.loopDetection({ threshold: 5, scope: "session" }),
    Orchestrator.middleware.auditLog({ dir: ".neo/audit" }),
  ],
});

// Load and register agents
const registry = new AgentRegistry("path/to/agents");
await registry.load();
for (const agent of registry.list()) {
  orchestrator.registerAgent(agent);
}

// Register a workflow
orchestrator.registerWorkflow({
  name: "implement",
  steps: {
    code: { agent: "developer" },
    review: { agent: "reviewer", dependsOn: ["code"], sandbox: "readonly" },
  },
});

// Listen to events
orchestrator.on("session:complete", (e) => console.log(`$${e.costUsd.toFixed(4)}`));
orchestrator.on("budget:alert", (e) => slack.alert(`Budget at ${e.utilizationPct}%`));

// Dispatch
await orchestrator.start();
const result = await orchestrator.dispatch({
  workflow: "implement",
  repo: "/path/to/repo",
  prompt: "Add rate limiting to the API",
  priority: "high",
});

console.log(result.status);  // "success" | "failure"
console.log(result.branch);  // "feat/run-<uuid>"
console.log(result.costUsd); // 0.1842

await orchestrator.shutdown();
```

### Events

```typescript
orchestrator.on("session:start", (e) => { /* agent started */ });
orchestrator.on("session:complete", (e) => { /* e.costUsd, e.durationMs */ });
orchestrator.on("session:fail", (e) => { /* e.error, e.willRetry */ });
orchestrator.on("cost:update", (e) => { /* e.todayTotal, e.budgetRemainingPct */ });
orchestrator.on("budget:alert", (e) => { /* threshold crossed */ });
orchestrator.on("queue:enqueue", (e) => { /* waiting for slot */ });
orchestrator.on("gate:waiting", (e) => { /* approval gate */ });
```

## Architecture

```
neotx               Thin CLI wrapper (citty)
  │
@neotx/core          Orchestration engine
  ├── orchestrator     Dispatch, lifecycle, budget, events, run persistence
  ├── runner           SDK session management, 3-level recovery
  ├── isolation        Git worktrees, sandbox config, per-repo mutex
  ├── concurrency      Priority semaphore with per-repo limits
  ├── middleware        Chain execution, budget guard, loop detection, audit log
  ├── supervisor       Heartbeat loop, TUI, webhook server, memory system
  ├── events           Typed emitter, JSONL journals, webhook dispatcher
  └── cost             Daily tracking, monthly JSONL rotation
  │
@neotx/agents        YAML agent definitions, prompts, and workflows
```

### Key design decisions

- **Framework, not product** — no UI, no database, no opinions on trackers
- **SDK-first** — wraps the Claude Agent SDK; SDK updates flow through naturally
- **YAML for definitions, TypeScript for dispatch** — agents and workflows are YAML, orchestration is code
- **Zero infrastructure** — JSONL journals, git worktrees, in-memory semaphore
- **Events as integration primitive** — everything emits typed events
- **One worktree per run** — agents work in isolation, main branch is never touched

### Recovery

Sessions use 3-level recovery escalation:

1. **Normal** — new session, fresh execution
2. **Resume** — new session with previous `sessionId` for context continuity
3. **Fresh** — clean slate, no previous context

Each level uses linear backoff. Non-retryable errors (budget exceeded, max turns) skip retries entirely.

### Isolation

Every writable agent gets its own git worktree on a dedicated branch (`feat/run-<uuid>`). All git operations serialize through a per-repo in-memory mutex to prevent corruption. Readonly agents (architects, reviewers) run against the main repo with no write access.

### Data

All state lives on the filesystem:

```
~/.neo/
├── config.yml                    # global config
├── journals/
│   ├── cost-2026-03.jsonl        # monthly cost journal
│   └── events-2026-03.jsonl      # monthly event journal
├── runs/
│   └── <repo-slug>/
│       ├── <runId>.json          # persisted run state
│       └── <runId>.log           # stream log (detached runs)
└── supervisors/
    └── <name>/
        ├── state.json            # daemon state (PID, port, heartbeats)
        ├── memory.md             # supervisor memory (persists across restarts)
        ├── activity.jsonl        # audit trail
        ├── inbox.jsonl           # incoming messages
        └── daemon.log            # process output
```

## Supervisor skills for Claude Code

Install neo skills so your Claude Code supervisor knows how to dispatch, monitor, and recover agents:

```bash
npx skills add voltaire-network/neo
```

This gives your supervisor:
- `/neo-supervisor` — full dispatch-monitor-decide loop with agent selection guide
- `/neo-recover` — failure diagnosis and recovery strategies

## Requirements

- Node.js >= 22
- git >= 2.20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## License

MIT
