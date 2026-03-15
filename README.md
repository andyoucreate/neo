# neo

**Neoscaling** — the new way to scale your engineering team. Instead of hiring, give a supervisor agent the ability to dispatch, monitor, and recover developer agents across your repositories. Scale development capacity instantly by running multiple autonomous agents in parallel.

neo is the orchestration layer between a supervisor and the developer agents it manages. The supervisor can be anything — a Claude Code session running in a loop, an OpenClaw agent with Linear/Notion/Slack tools, a custom script, or a human at the terminal. neo provides the primitives to dispatch work safely: git clone isolation, 3-level recovery, concurrency control, budget guards, and real-time cost tracking.

**Zero infrastructure** — no database, no Redis, no Docker.

```
┌─────────────────────────────────────┐
│           SUPERVISOR                │
│  Claude Code loop, OpenClaw agent,  │
│  custom script, or human            │
└──────────────┬──────────────────────┘
               │ dispatches via CLI or API
               v
┌─────────────────────────────────────┐
│              NEO                    │
│  isolation, recovery, budget,       │
│  concurrency, events, journals      │
└──────────────┬──────────────────────┘
               │ spawns in isolated clones
               v
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ dev  │ │ arch │ │ fix  │ │review│
│agent │ │agent │ │agent │ │agent │
└──────┘ └──────┘ └──────┘ └──────┘
```

The supervisor decides *what* needs to happen. neo handles *how* it happens safely.

---

## Table of Contents

- [Why neo?](#why-neo)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [CLI Reference](#cli-reference)
- [Agents](#agents)
- [Configuration](#configuration)
- [Programmatic API](#programmatic-api)
- [Supervisor Patterns](#supervisor-patterns)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Why neo?

Traditional approaches to scaling engineering have limits:

| Approach | Problem |
|----------|---------|
| Hire more engineers | Expensive, slow, coordination overhead |
| Single AI coding assistant | One task at a time, no orchestration |
| Custom agent infrastructure | Months of setup, maintenance burden |

neo gives you:

- **Parallel execution** — Run 5+ agents simultaneously across repos
- **Safe isolation** — Each agent works in its own git clone; main is never touched
- **Budget control** — Hard daily caps with real-time cost tracking
- **3-level recovery** — Automatic retries with context preservation
- **Framework, not product** — Integrate with your existing tools (Linear, Notion, Slack)

---

## Installation

### Prerequisites

- **Node.js** >= 22
- **git** >= 2.20
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** installed and authenticated

### Install the CLI

```bash
npm install -g neotx
```

Or with other package managers:

```bash
# pnpm
pnpm add -g neotx

# yarn
yarn global add neotx
```

### Verify Installation

```bash
neo doctor
```

This checks all prerequisites and reports any issues.

---

## Quick Start

```bash
# 1. Initialize neo in your repository (must be a git repo)
cd your-project
neo init --budget 100    # Set daily budget cap (e.g., $100/day)

# 2. Dispatch a developer agent
neo run developer --prompt "Add input validation to the user registration endpoint"

# 3. Check the result
neo runs               # List all runs with status, cost, duration
neo runs --last 1      # Show the most recent run
neo cost               # See today's spend and breakdown by agent
```

A supervisor agent (Claude Code, OpenClaw, etc.) does exactly the same thing — it calls `neo run` or uses the programmatic API to dispatch agents, read results, and decide what to do next.

### Supervisor Skills for Claude Code

Install the neo skills so your Claude Code supervisor knows how to dispatch, monitor, and recover agents:

```bash
# Install from skills.sh
npx skills add voltaire-network/neo

# Or copy manually to your project
cp -r neo/skills/neo-supervisor .claude/skills/
cp -r neo/skills/neo-recover .claude/skills/
```

This gives your supervisor two skills:

- `/neo-supervisor` — Full dispatch-monitor-decide loop with agent selection guide
- `/neo-recover` — Failure diagnosis and recovery strategies

---

## How It Works

When a supervisor dispatches `neo run developer --prompt "..."`, neo:

1. **Loads** the agent definition (model, tools, sandbox permissions, system prompt)
2. **Isolates** by creating a git clone on a new branch
3. **Starts** a Claude session with the agent's configuration
4. **Streams** events back to the supervisor (start, cost updates, completion)
5. **Tracks** costs in JSONL journals with daily budget enforcement
6. **Persists** the run result to `.neo/runs/<runId>.json`

Each agent works in its own clone. The main branch is never touched. The supervisor can inspect results, dispatch follow-up agents, or kill sessions at any point.

---

## CLI Reference

```
neo init       Initialize a .neo/ project directory
neo run        Dispatch an agent to execute a task
neo runs       List runs and inspect results
neo logs       Show event logs from journals
neo cost       Show cost breakdown (today, by agent)
neo agents     List available agents
neo doctor     Check environment prerequisites
```

### neo init

Initialize neo in your repository:

```bash
neo init                    # Defaults: $500/day budget, auto-detects branch
neo init --budget 50        # Set daily budget cap
neo init --force            # Overwrite existing config
```

Creates `.neo/config.yml`, agent and journal directories, and installs supervisor skills for Claude Code.

### neo run

Dispatch an agent to execute a task:

```bash
neo run <agent> --prompt "..."

# Examples
neo run developer --prompt "Fix the N+1 query in UserService.findAll"
neo run architect --prompt "Design the notification system"
neo run reviewer-quality --prompt "Review the changes in src/auth/"
neo run fixer --prompt "Fix all issues from the quality review"

# Options
neo run developer --prompt "..." --repo ../other-repo
neo run developer --prompt "..." --priority critical
neo run developer --prompt "..." --output json
neo run developer --prompt "..." --meta '{"ticket": "PROJ-123"}'
```

### neo runs

List and inspect runs:

```bash
neo runs                        # Table of all runs
neo runs <runId>                # Detailed view of a specific run (prefix match)
neo runs --last 5               # Last 5 runs only
neo runs --status failed        # Filter by status: completed, failed, running
neo runs --short                # One-line-per-run, minimal tokens for supervisors
neo runs --output json          # Full JSON for programmatic use
```

### neo logs

View event logs:

```bash
neo logs                        # Last 20 events
neo logs --last 50              # Last 50 events
neo logs --type session:fail    # Filter: session:start, session:complete, session:fail, cost:update, budget:alert
neo logs --run abc123           # Filter by run ID prefix
neo logs --short                # Ultra compact output for supervisors
neo logs --output json
```

### neo cost

View cost breakdown:

```bash
neo cost                        # Today's total, all-time total, breakdown by agent
neo cost --short                # One-liner: today=$0.52 sessions=3 developer=$0.32
neo cost --output json          # Structured JSON with today/allTime/byAgent
```

### neo agents

List available agents:

```bash
neo agents              # Table view
neo agents --output json  # JSON for scripting
```

### neo doctor

Check environment prerequisites:

```bash
neo doctor              # Check Node.js, git, config, Claude CLI, agents
neo doctor --output json
```

---

## Agents

8 built-in agents, each with a specific role, model, and sandbox:

| Agent | Role | Model | Sandbox |
|-------|------|-------|---------|
| `architect` | Plans architecture, decomposes features into tasks. Never writes code. | opus | readonly |
| `developer` | Implements features and fixes in isolated clones. | opus | writable |
| `fixer` | Fixes issues found by reviewers. Targets root causes. | opus | writable |
| `refiner` | Evaluates tickets and splits vague requirements into precise specs. | opus | readonly |
| `reviewer-quality` | Catches real bugs and DRY violations. Approves by default. | sonnet | readonly |
| `reviewer-security` | Flags exploitable vulnerabilities. Approves by default. | opus | readonly |
| `reviewer-perf` | Flags N+1 queries and O(n²) on unbounded data. Approves by default. | sonnet | readonly |
| `reviewer-coverage` | Recommends missing tests for critical paths. Never blocks. | sonnet | readonly |

### Custom Agents

Drop a YAML file in `.neo/agents/` to define custom agents or extend built-in ones:

```yaml
# .neo/agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger instead of console.log.
  Follow the patterns in src/shared/conventions.ts.
```

Agents support:

- **Inheritance** with `extends`
- **Tool customization** with `$inherited`
- **Per-agent settings**: `maxTurns`, `mcpServers`

---

## Configuration

Configuration is stored in `.neo/config.yml`, created by `neo init`:

```yaml
repos:
  - path: "."
    defaultBranch: main      # Auto-detected from git
    branchPrefix: feat        # Prefix for session branches
    autoCreatePr: false       # Auto PR creation (coming soon)

concurrency:
  maxSessions: 5              # Total concurrent agent sessions
  maxPerRepo: 2               # Max sessions per repository
  queueMax: 50                # Max queued dispatches

budget:
  dailyCapUsd: 500            # Hard daily spending limit
  alertThresholdPct: 80       # Emit budget:alert at this threshold

recovery:
  maxRetries: 3               # Retry attempts per session
  backoffBaseMs: 30000        # Base delay between retries

sessions:
  initTimeoutMs: 120000       # Timeout waiting for session init
  maxDurationMs: 3600000      # Max session duration (1 hour)
```

### Configuration Options

| Section | Option | Description | Default |
|---------|--------|-------------|---------|
| `concurrency` | `maxSessions` | Total concurrent agent sessions | 5 |
| `concurrency` | `maxPerRepo` | Max sessions per repository | 2 |
| `budget` | `dailyCapUsd` | Hard daily spending limit | 500 |
| `budget` | `alertThresholdPct` | Budget alert threshold | 80 |
| `recovery` | `maxRetries` | Retry attempts per session | 3 |
| `sessions` | `maxDurationMs` | Max session duration | 3600000 (1h) |

---

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
    review: { agent: "reviewer-quality", dependsOn: ["code"], sandbox: "readonly" },
  },
});

// Listen to events
orchestrator.on("session:complete", (event) => {
  console.log(`Done: $${event.costUsd.toFixed(4)}`);
});

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

The orchestrator emits typed events you can subscribe to:

```typescript
orchestrator.on("session:start", (e) => { /* agent started */ });
orchestrator.on("session:complete", (e) => { /* agent finished, e.costUsd */ });
orchestrator.on("session:fail", (e) => { /* agent failed, e.error, e.willRetry */ });
orchestrator.on("cost:update", (e) => { /* e.todayTotal, e.budgetRemainingPct */ });
orchestrator.on("budget:alert", (e) => { /* threshold crossed */ });
orchestrator.on("*", (e) => { /* all events */ });
```

### Middleware

Extend behavior with middleware hooks:

```typescript
import { Orchestrator } from "@neotx/core";

const orchestrator = new Orchestrator(config, {
  middleware: [
    Orchestrator.middleware.budgetGuard(),           // Block when over budget
    Orchestrator.middleware.loopDetection({          // Detect tool loops
      threshold: 5,
      scope: "session",
    }),
    Orchestrator.middleware.auditLog({               // JSONL audit trail
      dir: ".neo/audit",
      includeInput: true,
    }),
  ],
});
```

---

## Supervisor Patterns

neo is designed to be driven by a supervisor. Here are common patterns:

### Claude Code as Supervisor

A Claude Code session in a loop that reads tickets, dispatches agents, and reviews results:

```bash
# The supervisor reads a ticket, then dispatches
neo run architect --prompt "Design the auth system from ticket PROJ-42"

# Monitor progress and check results
neo runs --last 1 --short         # Quick status check
neo logs --type session:fail      # Any failures?
neo cost --short                  # Budget check

# Read the architect's output, then dispatch implementation
neo runs <runId> --output json    # Get full result
neo run developer --prompt "Implement the auth system based on this plan: ..."

# Dispatch a review
neo run reviewer-security --prompt "Review the auth changes on branch feat/run-..."

# If issues found, dispatch a fix
neo run fixer --prompt "Fix the issues found in the security review: ..."
```

### OpenClaw Agent as Supervisor

An OpenClaw agent with Linear, Notion, and Slack tools that manages the full cycle:

```typescript
import { Orchestrator, loadConfig, AgentRegistry } from "@neotx/core";

// The OpenClaw supervisor pulls tickets from Linear, dispatches neo agents,
// updates ticket status, and posts results to Slack
const result = await orchestrator.dispatch({
  workflow: "_run_developer",
  repo: "/path/to/repo",
  prompt: ticketDescription,
  metadata: { ticket: "PROJ-42", assignee: "openclaw-supervisor" },
});

// Supervisor reads result and decides next action
if (result.status === "success") {
  await linearClient.updateIssue(ticketId, { state: "in-review" });
  await slackClient.postMessage(channel, `Agent completed PROJ-42: ${result.branch}`);
}
```

### Events for Monitoring

The supervisor subscribes to events to monitor agent progress in real time:

```typescript
orchestrator.on("session:start", (e) => log(`Agent ${e.agent} started on ${e.repo}`));
orchestrator.on("session:complete", (e) => log(`Done in ${e.durationMs}ms for $${e.costUsd}`));
orchestrator.on("budget:alert", (e) => slack.alert(`Budget at ${e.utilizationPct}%`));
```

---

## Architecture

```
neotx              Thin CLI wrapper (citty)
  │
@neotx/core        Orchestration engine
  ├── orchestrator   Dispatch, lifecycle, budget, events
  ├── runner         SDK session management, 3-level recovery
  ├── isolation      Git clone isolation, sandbox config
  ├── concurrency    Priority semaphore with per-repo limits
  ├── middleware     Chain execution, SDK hooks conversion
  ├── events         Typed emitter, JSONL journals
  └── cost           Daily tracking, monthly rotation
  │
@neotx/agents      YAML agent definitions and prompts
```

### Packages

| Package | Description |
|---------|-------------|
| `@neotx/cli` | CLI interface built with citty |
| `@neotx/core` | Orchestration engine with dispatch, recovery, budgeting |
| `@neotx/agents` | Built-in agent definitions and system prompts |

### Design Principles

- **Framework, not product** — No UI, no database, no opinions on trackers
- **SDK-first** — Wraps the Claude Agent SDK; SDK updates flow through naturally
- **YAML for definitions, TypeScript for dispatch** — Agents are YAML, orchestration is code
- **Zero infrastructure** — JSONL journals, git clone isolation, in-memory semaphore
- **Events are the integration primitive** — Everything emits typed events

### Recovery

Sessions use 3-level recovery escalation:

1. **Normal retry** — Same session, same context
2. **Resume session** — New session, previous session ID for context continuity
3. **Fresh session** — Clean slate, no previous context

Each level uses exponential backoff. Non-retryable errors (auth failures, invalid config) skip retries entirely.

---

## Contributing

We welcome contributions! Here's how to get started:

### Development Setup

```bash
# Clone the repository
git clone https://github.com/andyoucreate/neo.git
cd neo

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint (with auto-fix)
pnpm lint:fix
```

### Project Structure

```
neo/
├── packages/
│   ├── cli/          # CLI interface (@neotx/cli)
│   ├── core/         # Orchestration engine (@neotx/core)
│   └── agents/       # Agent definitions (@neotx/agents)
├── package.json      # Root workspace config
└── README.md
```

### Guidelines

1. **Run checks before committing**: `pnpm typecheck && pnpm test && pnpm lint`
2. **Follow existing patterns**: Look at adjacent code for style and conventions
3. **Write tests**: Add tests for new functionality
4. **Keep commits focused**: One logical change per commit

### Reporting Issues

- Check existing issues before opening a new one
- Include reproduction steps and environment details
- For security issues, please email directly instead of opening a public issue

---

## License

MIT
