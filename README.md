# neo

Neoscaling - the new way to scale your engineering team. Instead of hiring, you give a supervisor agent the ability to dispatch, monitor, and recover developer agents across your repositories.

neo is the orchestration layer between a supervisor and the developer agents it manages. The supervisor can be anything - a Claude Code session running in a loop, an OpenClaw agent with Linear/Notion/Slack tools, a custom script, or a human at the terminal. neo gives it the primitives to dispatch work safely: git worktree isolation, 3-level recovery, concurrency control, budget guards, and real-time cost tracking.

Zero infrastructure - no database, no Redis, no Docker.

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
               │ spawns in isolated worktrees
               v
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ dev  │ │ arch │ │ fix  │ │review│
│agent │ │agent │ │agent │ │agent │
└──────┘ └──────┘ └──────┘ └──────┘
```

The supervisor decides what needs to happen. neo handles how it happens safely.

## Quickstart

```bash
# Install
npm install -g neotx

# Initialize in your repo
cd your-project
neo init

# Dispatch a developer agent
neo run developer --prompt "Add input validation to the user registration endpoint"

# Check the result
neo runs               # list all runs with status, cost, duration
neo runs --last 1      # show the most recent run
neo cost               # see today's spend and breakdown by agent
```

A supervisor agent (Claude Code, OpenClaw, etc.) does exactly the same thing - it calls `neo run` or uses the programmatic API to dispatch agents, read results, and decide what to do next.

### Supervisor skills for Claude Code

Install the neo skills so your Claude Code supervisor knows how to dispatch, monitor, and recover agents:

```bash
# Install from skills.sh
npx skills add voltaire-network/neo

# Or copy manually to your project
cp -r neo/skills/neo-supervisor .claude/skills/
cp -r neo/skills/neo-recover .claude/skills/
```

This gives your supervisor two skills:
- `/neo-supervisor` - Full dispatch-monitor-decide loop with agent selection guide
- `/neo-recover` - Failure diagnosis and recovery strategies

## How it works

When a supervisor dispatches `neo run developer --prompt "..."`, neo:

1. Loads the agent definition (model, tools, sandbox permissions, system prompt)
2. Creates an isolated git worktree on a new branch
3. Starts a Claude session with the agent's configuration
4. Streams events back to the supervisor (start, cost updates, completion)
5. Tracks costs in JSONL journals with daily budget enforcement
6. Persists the run result to `.neo/runs/<runId>.json`

Each agent works in its own worktree. The main branch is never touched. The supervisor can inspect results, dispatch follow-up agents, or kill sessions at any point.

## CLI

```
neo init        Initialize a .neo/ project directory and register the repo
neo run         Dispatch an agent to execute a task in an isolated worktree
neo runs        List runs or show details of a specific run
neo logs        Show event logs from journals
neo cost        Show cost breakdown (today, by agent, by run)
neo repos       Manage registered repositories (list, add, remove)
neo agents      List available agents (built-in and custom)
neo supervise   Manage the autonomous supervisor daemon
neo mcp         Manage MCP server integrations (Linear, Notion, GitHub, etc.)
neo doctor      Check environment prerequisites
```

### neo init

```bash
neo init                    # auto-detects branch, creates .neo/agents/, registers repo
neo init --force            # re-register even if already initialized
```

Creates `.neo/agents/` for project-local agent definitions, adds `.neo/worktrees/` to `.gitignore`, registers the repo in the global config (`~/.neo/config.yml`), and auto-detects the default branch.

### neo run

```bash
neo run <agent> --prompt "..."

# Examples
neo run developer --prompt "Fix the N+1 query in UserService.findAll"
neo run architect --prompt "Design the notification system"
neo run reviewer-quality --prompt "Review the changes in src/auth/"
neo run fixer --prompt "Fix all issues from the quality review"

# Options
neo run developer --prompt "..." --repo ../other-repo      # target a different repo
neo run developer --prompt "..." --priority critical        # priority: critical, high, medium, low
neo run developer --prompt "..." --output json              # JSON output for scripting
neo run developer --prompt "..." --meta '{"ticket": "PROJ-123"}'  # attach metadata
neo run developer --prompt "..." --detach                   # run in background, return immediately
neo run developer --prompt "..." -d                         # short alias for --detach
```

When `--detach` / `-d` is used, neo forks a background worker and returns the run ID immediately. Follow with `neo logs -f <runId>` to tail the output.

### neo agents

```bash
neo agents              # table view
neo agents --output json  # JSON for scripting
```

### neo runs

```bash
neo runs                        # table of all runs (current repo)
neo runs <runId>                # detailed view of a specific run (prefix match)
neo runs --last 5               # last 5 runs only
neo runs --status failed        # filter by status: completed, failed, running
neo runs --all                  # show runs from all registered repos
neo runs --repo ../other-repo   # filter by repo name or path
neo runs --short                # one-line-per-run, minimal tokens for supervisors
neo runs --output json          # full JSON for programmatic use
```

### neo logs

```bash
neo logs                        # last 20 events
neo logs --last 50              # last 50 events
neo logs --type session:fail    # filter: session:start, session:complete, session:fail, cost:update, budget:alert
neo logs --run abc123           # filter by run ID prefix
neo logs --short                # ultra compact output for supervisors
neo logs --output json
neo logs -f <runId>             # follow a detached run log in real time
neo logs --follow --run abc123  # same as above (long form)
```

The `--follow` / `-f` flag tails a detached run's log file and exits when the run completes.

### neo cost

```bash
neo cost                        # today's total, all-time total, breakdown by agent (current repo)
neo cost --all                  # show costs from all registered repos (adds per-repo breakdown)
neo cost --repo ../other-repo   # filter by repo name or path
neo cost --short                # one-liner: today=$0.52 sessions=3 developer=$0.32
neo cost --output json          # structured JSON with today/allTime/byAgent
```

### neo repos

```bash
neo repos                               # list all registered repos
neo repos add                           # register CWD (auto-detects branch)
neo repos add ../other-repo             # register a specific path
neo repos add ../other-repo --name api  # register with a custom name
neo repos add ../other-repo --branch develop  # override default branch
neo repos remove <name-or-path>         # unregister a repo
neo repos --output json                 # JSON output for scripting
```

### neo supervise

```bash
neo supervise                   # start daemon (tmux) + open TUI
neo supervise --daemon          # start daemon without tmux (detached process, no TUI)
neo supervise --status          # show supervisor status (PID, port, cost, heartbeats)
neo supervise --attach          # open TUI for a running supervisor
neo supervise --kill            # stop the running supervisor (SIGTERM, then SIGKILL after 10s)
neo supervise --message "..."   # send a message to the supervisor inbox
neo supervise --name prod       # use a named instance (default: "supervisor")
```

The supervisor daemon exposes an HTTP health endpoint and webhook. When started via tmux, the session persists after terminal close.

### neo mcp

```bash
neo mcp list                                    # list configured MCP servers
neo mcp add linear                              # add from preset (linear, notion, github, jira, slack)
neo mcp add my-server --type stdio --command npx --serverArgs "-y,@my/mcp-server"
neo mcp add my-api --type http --url https://mcp.example.com
neo mcp remove <name>                           # remove an MCP server
```

Available presets: `linear`, `notion`, `github`, `jira`, `slack`. Each preset requires environment variables (shown on add if not set).

### neo doctor

```bash
neo doctor              # check Node.js, git, config, tmux, Claude CLI, agents, journals
neo doctor --output json
```

Checks: Node.js >= 22, git >= 2.20, global config, repo registration, legacy config detection, tmux availability, Claude CLI, agent definitions, journal directory permissions.

## Supervisor patterns

neo is designed to be driven by a supervisor. Here are the common patterns:

### Claude Code as supervisor

A Claude Code session in a loop that reads tickets, dispatches agents, and reviews results:

```bash
# The supervisor reads a ticket, then dispatches
neo run architect --prompt "Design the auth system from ticket PROJ-42"

# Monitor progress and check results
neo runs --last 1 --short         # quick status check
neo logs --type session:fail      # any failures?
neo cost --short                  # budget check

# Read the architect's output, then dispatch implementation
neo runs <runId> --output json    # get full result
neo run developer --prompt "Implement the auth system based on this plan: ..."

# Dispatch a review
neo run reviewer-security --prompt "Review the auth changes on branch feat/run-..."

# If issues found, dispatch a fix
neo run fixer --prompt "Fix the issues found in the security review: ..."
```

### OpenClaw agent as supervisor

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

### Events for monitoring

The supervisor subscribes to events to monitor agent progress in real time:

```typescript
orchestrator.on("session:start", (e) => log(`Agent ${e.agent} started on ${e.repo}`));
orchestrator.on("session:complete", (e) => log(`Done in ${e.durationMs}ms for $${e.costUsd}`));
orchestrator.on("budget:alert", (e) => slack.alert(`Budget at ${e.utilizationPct}%`));
```

## Agents

8 built-in agents, each with a specific role, model, and sandbox:

| Agent | Role | Model | Sandbox |
|-------|------|-------|---------|
| `architect` | Plans architecture, decomposes features into tasks. Never writes code. | opus | readonly |
| `developer` | Implements features and fixes in isolated worktrees. | opus | writable |
| `fixer` | Fixes issues found by reviewers. Targets root causes. | opus | writable |
| `refiner` | Evaluates tickets and splits vague requirements into precise specs. | opus | readonly |
| `reviewer-quality` | Catches real bugs and DRY violations. Approves by default. | sonnet | readonly |
| `reviewer-security` | Flags exploitable vulnerabilities. Approves by default. | opus | readonly |
| `reviewer-perf` | Flags N+1 queries and O(n^2) on unbounded data. Approves by default. | sonnet | readonly |
| `reviewer-coverage` | Recommends missing tests for critical paths. Never blocks. | sonnet | readonly |

### Custom agents

Drop a YAML file in `.neo/agents/` to define custom agents or extend built-in ones:

```yaml
# .neo/agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger instead of console.log.
  Follow the patterns in src/shared/conventions.ts.
```

Agents support inheritance with `extends`, tool customization with `$inherited`, and per-agent `maxTurns` and `mcpServers`.

## Configuration

`~/.neo/config.yml` - global config (auto-created with defaults on first use):

```yaml
repos:
  - path: "."
    defaultBranch: main      # auto-detected from git
    branchPrefix: feat        # prefix for worktree branches
    autoCreatePr: false       # auto PR creation (coming soon)

concurrency:
  maxSessions: 5              # total concurrent agent sessions
  maxPerRepo: 2               # max sessions per repository
  queueMax: 50                # max queued dispatches

budget:
  dailyCapUsd: 500            # hard daily spending limit
  alertThresholdPct: 80       # emit budget:alert at this threshold

recovery:
  maxRetries: 3               # retry attempts per session
  backoffBaseMs: 30000        # base delay between retries

sessions:
  initTimeoutMs: 120000       # timeout waiting for session init
  maxDurationMs: 3600000      # max session duration (1 hour)
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
    Orchestrator.middleware.budgetGuard(),           // block when over budget
    Orchestrator.middleware.loopDetection({           // detect tool loops
      threshold: 5,
      scope: "session",
    }),
    Orchestrator.middleware.auditLog({                // JSONL audit trail
      dir: ".neo/audit",
      includeInput: true,
    }),
  ],
});
```

## Architecture

```
neotx              Thin CLI wrapper (citty)
  |
@neotx/core        Orchestration engine
  |--- orchestrator   Dispatch, lifecycle, budget, events
  |--- runner         SDK session management, 3-level recovery
  |--- isolation      Git worktrees, sandbox config, mutex
  |--- concurrency    Priority semaphore with per-repo limits
  |--- middleware      Chain execution, SDK hooks conversion
  |--- events         Typed emitter, JSONL journals
  |--- cost           Daily tracking, monthly rotation
  |
@neotx/agents      YAML agent definitions and prompts
```

### Design principles

- **Framework, not product** - no UI, no database, no opinions on trackers
- **SDK-first** - wraps the Claude Agent SDK, SDK updates flow through naturally
- **YAML for definitions, TypeScript for dispatch** - agents are YAML, orchestration is code
- **Zero infrastructure** - JSONL journals, git worktrees, in-memory semaphore
- **Events are the integration primitive** - everything emits typed events

### Recovery

Sessions use 3-level recovery escalation:

1. **Normal retry** - same session, same context
2. **Resume session** - new session, previous session ID for context continuity
3. **Fresh session** - clean slate, no previous context

Each level uses exponential backoff. Non-retryable errors (auth failures, invalid config) skip retries entirely.

## Requirements

- Node.js >= 22
- git >= 2.20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## License

MIT
