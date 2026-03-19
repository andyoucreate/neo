# neo

**Neoscaling** - stop hiring, start dispatching.

An autonomous daemon that orchestrates Claude agents to build software. It spawns isolated git clones, manages concurrency, handles 3-level recovery, and tracks every dollar spent. Then we let it build itself - 342 runs, $256, 3 days across 6 repositories. Zero infrastructure.

Think of neo as a **CTO for your codebase**. An external agent (OpenClaw, a Claude Code loop, Notion, or you) acts as the CEO - it decides what needs to happen. neo's **supervisor daemon** is the CTO that takes those decisions and autonomously organizes an entire engineering team: dispatching developers, architects, reviewers, and fixers in parallel, monitoring their work, handling failures, and reporting back.

```
┌─────────────────────────────────────────────────────┐
│                     CEO                             │
│  Notion pipeline, OpenClaw agent, Claude Code,      │
│  custom script, or human - decides WHAT to build    │
└──────────────────────┬──────────────────────────────┘
                       │ talks to the supervisor via CLI, API, webhooks
                       v
┌─────────────────────────────────────────────────────┐
│           SUPERVISOR (neo's built-in CTO)           │
│  autonomous daemon · event-driven heartbeat loop    │
│  dispatches → monitors → reviews → fixes → retries  │
│  isolation · concurrency · budget · memory · TUI    │
└──────────────────────┬──────────────────────────────┘
                       │ spawns in isolated git clones
                       v
          ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
          │ dev  │ │ arch │ │ fix  │ │review│ │refine│
          │agent │ │agent │ │agent │ │agent │ │agent │
          └──────┘ └──────┘ └──────┘ └──────┘ └──────┘
                    the engineering team
```

The CEO decides *what* needs to happen. The supervisor handles *how* - organizing the team, managing the develop→review→fix cycle, and reporting results back up.

---

## Quick Start

```bash
# Install
npm install -g @neotx/cli

# Initialize in your repo
cd your-project && neo init

# Start the supervisor - your autonomous CTO with a live TUI dashboard
neo supervise
```

That's it. The supervisor opens a live TUI dashboard and starts its autonomous heartbeat loop. **It's not a chatbot** - it's an event-driven daemon that reacts to what happens in your codebase. Send it work via `neo run`, integrate it with Notion, or trigger it via webhooks, and it autonomously handles the full develop → review → fix cycle.

```bash
# Send work to the supervisor (it will orchestrate)
neo supervise --message "Implement the auth system from ticket PROJ-42"

# Or dispatch a single agent yourself
neo run developer --prompt "Add input validation to the user registration endpoint"

# Check on progress
neo runs --last 1        # Status, cost, duration
neo cost                 # Today's spend by agent
```

---

## Built-in Agents

neo comes with 5 built-in agents ready to use out of the box:

| Agent | Role | Model | Sandbox |
|-------|------|-------|---------|
| `architect` | Strategic planner. Designs architecture, decomposes work into atomic tasks. Never writes code. | opus | readonly |
| `developer` | Implementation worker. Executes tasks in isolated clones with strict scope discipline. | opus | writable |
| `fixer` | Auto-correction. Fixes issues found by reviewers. Targets root causes, not symptoms. | opus | writable |
| `refiner` | Ticket evaluator. Assesses clarity and splits vague tickets into precise specs. | opus | readonly |
| `reviewer` | Single-pass reviewer. Covers quality, security, performance, and test coverage in one sweep. | sonnet | readonly |

### Customize per repo

Each repository can configure how agents behave through two files in `.neo/`:

- **`.neo/INSTRUCTIONS.md`** - injected into every agent's prompt for this repo. Use it to describe your stack, conventions, and rules (e.g. "We use Biome, not ESLint", "All API endpoints must have integration tests").
- **`SUPERVISOR.md`** (in `@neotx/agents`) - domain knowledge for the supervisor: agent output contracts, routing rules, dispatch patterns, and the full pipeline state machine.

```
your-project/
|-- .neo/
|   |-- agents/              # Custom agent definitions (YAML)
|   |   +-- my-developer.yml
|   +-- INSTRUCTIONS.md      # Repo-specific rules injected into all agents
+-- ...
```

### Add custom agents

Drop a YAML file in `.neo/agents/` to extend built-in agents or create new ones:

```yaml
# .neo/agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger instead of console.log.
  Follow the patterns in src/shared/conventions.ts.
```

Agents support inheritance (`extends`), tool customization (`$inherited`), and per-agent settings (`maxTurns`, `mcpServers`).

---

## How It Works

### The Supervisor - Your Autonomous CTO

When you run `neo supervise`, neo starts its **built-in supervisor daemon** - a long-lived process with a live TUI dashboard. The supervisor is **not conversational** - it's an event-driven heartbeat loop that autonomously orchestrates your engineering team:

**What the supervisor does at each heartbeat:**

1. **Monitors** - checks for completed runs, failed runs, and pending work
2. **Decides** - determines what to do next (dispatch reviewer, fixer, escalate, retry)
3. **Dispatches** - automatically launches the right agents based on events:
   - Developer completes → dispatches reviewer
   - Reviewer finds issues → dispatches fixer
   - Fixer completes → re-dispatches reviewer
   - Loops until approved or escalates
4. **Integrates** - pulls tickets from Notion pipeline, updates statuses, posts results
5. **Remembers** - writes to persistent memory so future agents learn from past runs
6. **Reports** - live TUI shows status, budget sparklines, and full activity feed

**The supervisor handles the full develop → review → fix cycle autonomously.**

```bash
# Start the supervisor with live TUI
neo supervise

# Send work - picked up at next heartbeat
neo supervise --message "Implement the auth system from ticket PROJ-42"

# The supervisor autonomously orchestrates:
#   1. Dispatches developer to implement
#   2. On completion, dispatches reviewer
#   3. On issues found, dispatches fixer
#   4. Re-reviews until approved or escalates
#   5. Updates Notion ticket status
#   6. Writes learnings to memory
```

### Notion Integration

The supervisor has **first-class Notion integration**. Configure your Notion database, and the supervisor:

- Pulls tickets from "Ready for dev" column at each heartbeat
- Routes tickets (developer, architect, refiner, or scout)
- Updates ticket status as work progresses (CI pending → In review → Done)
- Posts PR links and agent output back to tickets
- Escalates blockers for human review

### Single Dispatch (Direct Mode)

You can also bypass the supervisor and dispatch agents directly:

```bash
neo run developer --prompt "Fix the N+1 query in UserService.findAll"
```

When you run `neo run`, neo:

1. **Loads** the agent definition (model, tools, sandbox, system prompt)
2. **Isolates** by creating a `git clone --local` on a new branch
3. **Starts** a Claude session with the agent's configuration
4. **Monitors** via typed events (start, cost updates, completion)
5. **Recovers** automatically if the session fails (3-level escalation)
6. **Tracks** costs in append-only JSONL journals with daily budget enforcement
7. **Persists** the run result for inspection and follow-up

Each agent works in its own clone. Your main branch is never touched.

---

## Why neo?

| Approach | Problem |
|----------|---------|
| Hire more engineers | Expensive, slow, coordination overhead |
| Single AI coding assistant | One task at a time, manual babysitting |
| Custom agent infrastructure | Months of setup, maintenance burden |

neo gives you:

- **Autonomous supervisor daemon** - event-driven CTO that handles develop→review→fix cycles without human intervention
- **Live TUI dashboard** - real-time status, budget sparklines, activity feed, and heartbeat monitoring
- **Notion integration** - first-class pipeline support; pull tickets, update statuses, post results
- **Parallel execution** - run 8+ agents simultaneously across repos
- **Safe isolation** - each agent gets its own git clone; main is never touched
- **Budget control** - hard daily caps with real-time cost tracking and alerts
- **3-level recovery** - normal, resume session, fresh session with exponential backoff
- **Persistent memory** - agents learn from past runs via SQLite + FTS5 + local vector embeddings
- **Framework, not product** - integrate with Linear, Notion, Slack, anything via CLI, API, or webhooks

---

## Advanced Usage

### Running the Supervisor as a Daemon

The supervisor can run in the background without the TUI:

```bash
# Start headless in the background
neo supervise --detach

# Check what the supervisor is doing
neo supervise --status

# Attach to the TUI later
neo supervise --attach

# Send work - picked up at the next heartbeat
neo supervise --message "Focus on the auth module - ship by Friday"

# Stop the daemon
neo supervise --kill
```

### Integrating with External Systems

The supervisor exposes multiple integration points for external CEOs (OpenClaw, Claude Code, custom scripts):

**1. Message Queue** - `neo supervise --message` drops into the supervisor's inbox
**2. Direct Dispatch** - `neo run` dispatches agents that the supervisor monitors
**3. Programmatic API** - `@neotx/core` Orchestrator with typed events
**4. Webhooks** - supervisor pushes `session:complete`, `session:fail`, `budget:alert` events to any URL

### Programmatic API

External agents can drive neo programmatically:

```typescript
import { Orchestrator, loadGlobalConfig, AgentRegistry } from "@neotx/core";

const config = await loadGlobalConfig();
const orchestrator = new Orchestrator(config);

// Dispatch work
const result = await orchestrator.dispatch({
  agent: "developer",
  repo: "/path/to/repo",
  prompt: ticketDescription,
  metadata: { ticket: "PROJ-42", stage: "develop" },
});

// React to completion
if (result.status === "success") {
  await notionClient.updatePage(ticketId, { status: "In review" });
  await slackClient.postMessage(channel, `Completed PROJ-42: ${result.branch}`);
}

// Subscribe to events for real-time monitoring
orchestrator.on("session:complete", (e) => log(`Done: $${e.costUsd}`));
orchestrator.on("budget:alert", (e) => slack.alert(`Budget at ${e.utilizationPct}%`));
```

---

## CLI Reference

```
neo supervise   Start the supervisor daemon with live TUI dashboard
neo init        Initialize a .neo/ project directory and register the repo
neo run         Dispatch an agent to execute a task in an isolated clone
neo runs        List runs or show details of a specific run
neo logs        Show event logs from journals
neo cost        Show cost breakdown (today, by agent)
neo log         Log structured progress reports to the supervisor
neo agents      List available agents (built-in and custom)
neo memory      Inspect and search supervisor memory
neo decision    Manage decision gates for supervisor input
neo doctor      Check environment prerequisites
neo repos       Manage registered repositories
neo mcp         Manage MCP server integrations (Linear, Notion, GitHub, etc.)
neo version     Display the current neo version
```

### neo supervise

```bash
neo supervise                   # Start daemon + open live TUI
neo supervise --detach          # Daemon in background (no TUI)
neo supervise --attach          # Open TUI for running daemon
neo supervise --status          # Show supervisor status
neo supervise --kill            # Stop the running supervisor
neo supervise --message "..."   # Send a message to the supervisor inbox
```

### neo run

```bash
neo run <agent> --prompt "..."

# Examples
neo run developer --prompt "Fix the N+1 query in UserService.findAll"
neo run architect --prompt "Design the notification system"
neo run reviewer --prompt "Review the changes in src/auth/"

# Options
neo run developer --prompt "..." --branch feat/my-feature
neo run developer --prompt "..." --priority critical
neo run developer --prompt "..." --meta '{"ticket": "PROJ-123"}'
neo run developer --prompt "..." --sync              # Foreground (blocking)
neo run developer --prompt "..." --git-strategy pr   # Create PR on completion
```

Runs are detached by default - the command returns immediately while the agent works in the background.

### neo runs

```bash
neo runs                        # Table of all runs for current repo
neo runs <runId>                # Detailed view (prefix match)
neo runs --all                  # All repos
neo runs --status failed        # Filter by status
neo runs --last 5               # Last N runs
neo runs --short                # Compact output for supervisors
```

### neo cost

```bash
neo cost                        # Today's total, breakdown by agent
neo cost --all                  # All repos
neo cost --short                # One-liner for supervisors
```

### neo log

```bash
neo log progress "3/5 endpoints done"
neo log action "Pushed to branch"
neo log decision "Chose JWT over sessions - simpler for MVP"
neo log blocker "Tests failing, missing dependency"
neo log milestone "All tests passing, PR opened"
neo log discovery "Repo uses Prisma + PostgreSQL"
```

---

## Configuration

Stored in `~/.neo/config.yml`, created automatically on first use:

```yaml
repos:
  - path: "/path/to/your/repo"
    defaultBranch: main
    branchPrefix: feat
    pushRemote: origin
    gitStrategy: branch       # "branch" or "pr"

concurrency:
  maxSessions: 5              # Total concurrent agent sessions
  maxPerRepo: 4               # Max sessions per repository

budget:
  dailyCapUsd: 500            # Hard daily spending limit
  alertThresholdPct: 80       # Emit budget:alert at this threshold

recovery:
  maxRetries: 3               # Retry attempts per session
  backoffBaseMs: 30000        # Base delay between retries

sessions:
  initTimeoutMs: 120000       # Timeout waiting for session init
  maxDurationMs: 3600000      # Max session duration (1 hour)

supervisor:
  port: 7777                  # Webhook server port
  dailyCapUsd: 50             # Supervisor-specific daily cap

memory:
  embeddings: true            # Enable local vector embeddings
```

---

## Programmatic API

neo is a framework, not just a CLI. Use `@neotx/core` directly:

```typescript
import { AgentRegistry, loadGlobalConfig, Orchestrator } from "@neotx/core";

const config = await loadGlobalConfig();
const orchestrator = new Orchestrator(config);

// Load and register agents
const registry = new AgentRegistry("path/to/agents");
await registry.load();
for (const agent of registry.list()) {
  orchestrator.registerAgent(agent);
}

// Listen to events
orchestrator.on("session:complete", (e) => {
  console.log(`Done: $${e.costUsd.toFixed(4)}`);
});

orchestrator.on("budget:alert", (e) => {
  console.log(`Budget at ${e.utilizationPct}%`);
});

// Dispatch
await orchestrator.start();
const result = await orchestrator.dispatch({
  agent: "developer",
  repo: "/path/to/repo",
  prompt: "Add rate limiting to the API",
  priority: "high",
});

console.log(result.status);  // "success" | "failure"
console.log(result.costUsd); // 1.24
await orchestrator.shutdown();
```

### Events

```typescript
orchestrator.on("session:start", (e) => { /* agent started */ });
orchestrator.on("session:complete", (e) => { /* e.costUsd, e.durationMs */ });
orchestrator.on("session:fail", (e) => { /* e.error, e.willRetry */ });
orchestrator.on("cost:update", (e) => { /* e.todayTotal, e.budgetRemainingPct */ });
orchestrator.on("budget:alert", (e) => { /* threshold crossed */ });
orchestrator.on("*", (e) => { /* all events */ });
```

---

## Architecture

```
CEO layer          Notion pipeline, OpenClaw, Claude Code, custom script, or human
  |                gives strategic direction
  v
@neotx/cli         CLI interface (citty)
  |
@neotx/core        The CTO - orchestration engine
  |-- supervisor/    Built-in autonomous daemon (the CTO)
  |   |-- daemon       Process lifecycle, lockfile, state management
  |   |-- heartbeat    Event-driven loop, routing, dispatch logic
  |   |-- event-queue  Webhook events, inbox messages, file watching
  |   |-- memory       SQLite store, FTS5, sqlite-vec embeddings
  |   |-- activity-log Append-only journal for supervisor actions
  |   +-- decisions    User decision gates for scout findings
  |-- orchestrator   Dispatch, lifecycle, budget, events
  |-- runner         SDK session management, 3-level recovery
  |-- isolation      Git clone isolation, sandbox config
  |-- concurrency    Priority semaphore with per-repo limits
  |-- middleware     Chain execution, SDK hooks conversion
  |-- events         Typed emitter, JSONL journals, webhooks
  +-- cost           Daily tracking, monthly rotation
  |
@neotx/agents      The team - YAML definitions and prompts
  |-- architect      Plans and decomposes
  |-- developer      Implements in isolated clones
  |-- reviewer       Reviews quality, security, perf, coverage (challenges by default)
  |-- fixer          Fixes issues from reviews, targets root causes
  |-- refiner        Evaluates and splits vague tickets
  +-- scout          Autonomous codebase explorer, surfaces bugs and tech debt
```

### Design Principles

- **CEO/CTO/Team hierarchy** - external agents (or Notion) give direction, the supervisor organizes the team, agents execute
- **Autonomous by default** - the supervisor handles develop→review→fix cycles without human intervention
- **Event-driven architecture** - heartbeat loop reacts to webhooks, not polling; everything emits typed events
- **Framework, not product** - no UI opinions, no database; integrate with anything via CLI, API, or webhooks
- **SDK-first** - wraps the Claude Agent SDK; updates flow through naturally
- **YAML for definitions, TypeScript for dispatch** - agents are data, orchestration is code
- **Zero infrastructure** - JSONL journals, git clone isolation, in-memory semaphore. No Docker, no Redis, no DB.

### Recovery

Sessions use 3-level recovery escalation:

1. **Normal** - fresh session
2. **Resume** - pass previous session ID for context continuity
3. **Fresh** - clean slate, no previous context

Each level uses exponential backoff. Non-retryable errors (budget exceeded, max turns) skip retries entirely.

---

## Installation

### Prerequisites

- **Node.js** >= 22
- **git** >= 2.20
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** installed and authenticated

```bash
npm install -g @neotx/cli
neo doctor  # Verify everything is set up
```

---

## Contributing

```bash
git clone https://github.com/andyoucreate/neo.git
cd neo
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

### Project Structure

```
neo/
|-- packages/
|   |-- cli/          # CLI interface (@neotx/cli)
|   |-- core/         # Orchestration engine (@neotx/core)
|   +-- agents/       # Agent definitions (@neotx/agents)
|-- package.json      # Root workspace config
+-- README.md
```

### Guidelines

1. Run checks before committing: `pnpm typecheck && pnpm test && pnpm lint`
2. Follow existing patterns
3. Write tests for new functionality
4. Keep commits focused: one logical change per commit

---

## License

MIT
