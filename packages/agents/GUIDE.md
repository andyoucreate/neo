# Neo — AI Integration Guide

You are reading the neo integration guide. This document explains how an AI agent can use neo to orchestrate autonomous developer agents across git repositories.

neo is a framework that wraps the Claude Agent SDK with clone isolation, 3-level recovery, DAG workflows, concurrency control, budget guards, and approval gates. Agents work in isolated git clones — your main branch is never touched.

---

## Two ways to use neo

### Mode A: Supervisor (recommended)

**This is the recommended way to use neo.** The supervisor is a long-lived autonomous daemon that acts as your CTO. You send it messages in natural language and it handles everything — agent selection, dispatch ordering, review cycles, retries, and memory.

The supervisor is NOT a chatbot. It's an event-driven heartbeat loop that:
- Picks up your messages at the next heartbeat
- Dispatches the right agents in the right order
- Monitors progress and reacts to completions/failures
- Persists memory across sessions — it learns your codebase over time
- Handles the full lifecycle: refine → architect → develop → review → fix → done

```bash
# Start the supervisor (background daemon)
neo supervise --detach

# Send a task — the supervisor handles the rest
neo supervise --message "Implement user authentication with JWT. Create login/register endpoints, middleware, and tests."

# The supervisor autonomously:
#   1. Analyzes your request
#   2. Dispatches architect if design is needed
#   3. Dispatches developer for each task
#   4. Dispatches reviewer to review PRs
#   5. Dispatches fixer if issues are found
#   6. Reports back via activity log

# Check supervisor status
neo supervisor status

# View what the supervisor is doing
neo supervisor activity --limit 10

# Send follow-up instructions
neo supervise --message "Prioritize the auth middleware — we need it before the API routes"

# Check costs
neo cost --short
```

**Why supervisor mode?** You don't need to know which agent to use, how to chain them, or when to retry. The supervisor makes those decisions based on its experience and memory. It also handles edge cases (review cycles, CI failures, anti-loop guards) that are tedious to manage manually.

### Mode B: Direct dispatch (advanced)

For cases where you want full control over the workflow — you decide what to build, which agent to use, and when to follow up. Useful for one-off tasks or when you have a specific agent pipeline in mind.

```bash
# Dispatch a developer agent
neo run developer --prompt "Add input validation to POST /api/users" \
  --repo /path/to/project --branch feat/input-validation \
  --meta '{"label":"input-validation","stage":"develop"}'

# Check progress
neo runs --short --status running

# Read the result when done
neo runs <runId>

# Check costs
neo cost --short
```

You handle the develop → review → fix cycle yourself. See "Typical Workflows" at the end for examples.

---

## Installation & Setup

```bash
# Prerequisites: Node.js >= 22, git >= 2.20, Claude Code CLI installed

# Install neo globally
npm install -g @neotx/cli

# Verify installation
neo doctor

# Initialize in your project
cd /path/to/your/project
neo init

# (Optional) Add MCP integrations
neo mcp add github    # requires GITHUB_TOKEN env var
neo mcp add linear    # requires LINEAR_API_KEY env var
neo mcp add notion    # requires NOTION_TOKEN env var
```

---

## Available Agents

| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `developer` | opus | writable | Implementing code changes, bug fixes, new features |
| `architect` | opus | readonly | Designing systems, planning features, decomposing work |
| `reviewer` | sonnet | readonly | Code review — blocks on ≥1 CRITICAL or ≥3 WARNINGs |
| `fixer` | opus | writable | Fixing issues found by reviewer — targets root causes |
| `refiner` | opus | readonly | Evaluating ticket quality, splitting vague tickets |

**Custom agents:** Drop a YAML file in `.neo/agents/` to extend built-in agents:

```yaml
# .neo/agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger instead of console.log.
  Follow the patterns in src/shared/conventions.ts.
```

List all agents: `neo agents`

---

## Complete Command Reference

### neo run — Dispatch an agent

```bash
neo run <agent> --prompt "..." --repo <path> --branch <name> [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--prompt` | string | required | Task description for the agent |
| `--repo` | string | `.` | Target repository path |
| `--branch` | string | required | Branch name for the isolated clone |
| `--priority` | string | `medium` | `critical`, `high`, `medium`, `low` |
| `--meta` | JSON string | — | Metadata: `{"label":"...","ticketId":"...","stage":"..."}` |
| `--detach`, `-d` | boolean | `true` | Run in background, return immediately |
| `--sync`, `-s` | boolean | `false` | Run in foreground (blocking) |
| `--git-strategy` | string | `branch` | `branch` (push only) or `pr` (create PR) |
| `--output` | string | — | `json` for machine-readable output |

**Detached output:** returns `runId` and PID immediately. Use `neo logs -f <runId>` to follow.

**Example with full metadata:**
```bash
neo run developer \
  --prompt "Add rate limiting to POST /api/upload: max 10 req/min/IP, return 429 with Retry-After" \
  --repo /path/to/api \
  --branch feat/rate-limiting \
  --priority high \
  --meta '{"label":"T1-rate-limit","ticketId":"PROJ-42","stage":"develop"}' \
  --git-strategy pr
```

### neo runs — Monitor runs

```bash
neo runs                          # List all runs for current repo
neo runs <runId>                  # Full details + agent output (prefix match on ID)
neo runs --short                  # Compact output (minimal tokens)
neo runs --short --status running # Check active runs
neo runs --last 5                 # Last N runs
neo runs --status failed          # Filter by status: completed, failed, running
neo runs --repo my-project        # Filter by repo
neo runs --output json            # Machine-readable
```

**Important:** After an agent completes, ALWAYS read `neo runs <runId>` — it contains the agent's structured output (PR URLs, issues found, plans, milestones).

### neo supervise — Manage the supervisor daemon

```bash
neo supervise                     # Start daemon + open live TUI
neo supervise --detach            # Start daemon in background (no TUI)
neo supervise --attach            # Open TUI for running daemon
neo supervise --status            # Show supervisor status (PID, port, costs, heartbeats)
neo supervise --kill              # Stop the running supervisor
neo supervise --message "..."     # Send a message to the supervisor inbox
neo supervise --name my-supervisor  # Use a named supervisor instance (default: "supervisor")
```

**Status output includes:** PID, port, session ID, started timestamp, heartbeat count, last heartbeat, cost today, cost total, status (running/idle/stopped).

### neo supervisor — Query supervisor state

```bash
neo supervisor status             # Current status + recent activity (top 5)
neo supervisor status --json      # Machine-readable status
neo supervisor activity           # Activity log (last 50 entries)
neo supervisor activity --type dispatch  # Filter: decision, action, error, event, message, plan, dispatch
neo supervisor activity --since "2024-01-15T00:00:00Z" --until "2024-01-16T00:00:00Z"
neo supervisor activity --limit 20
neo supervisor activity --json    # Machine-readable
```

### neo logs — Event journal

```bash
neo logs                          # Last 20 events
neo logs --last 50                # Last N events
neo logs --type session:complete  # Filter: session:start, session:complete, session:fail, cost:update, budget:alert
neo logs --run <runId>            # Events for a specific run
neo logs --follow --run <runId>   # Live tail of a running agent's log
neo logs --short                  # Ultra-compact (one-line per event)
neo logs --output json            # Machine-readable
```

### neo log — Report to supervisor

Agents use this to report progress. Reports appear in the supervisor's TUI and activity log.

```bash
neo log progress "3/5 endpoints done"
neo log action "Pushed to branch feat/auth"
neo log decision "Chose JWT over sessions — simpler for MVP"
neo log blocker "Tests failing, missing dependency"     # Also wakes the supervisor via inbox
neo log milestone "All tests passing, PR opened"
neo log discovery "Repo uses Prisma + PostgreSQL"
```

Flags: `--memory` (force to memory store), `--knowledge` (force to knowledge), `--procedure` (write as procedure memory).

### neo cost — Budget tracking

```bash
neo cost                          # Today's total + all-time + breakdown by agent and repo
neo cost --short                  # One-liner: today=$X.XX sessions=N agent1=$X.XX
neo cost --repo my-project        # Filter by repo
neo cost --output json            # Machine-readable
```

### neo memory — Persistent memory store

The supervisor maintains semantic memory using SQLite + FTS5 + optional vector embeddings.

```bash
# Write memory
neo memory write --type fact --scope /path/to/repo "main branch uses protected merges"
neo memory write --type procedure --scope /path/to/repo "After architect run: parse milestones, create tasks"
neo memory write --type focus --expires 2h "Working on auth module — 3 tasks remaining"
neo memory write --type task --scope /path/to/repo --severity high --category "neo runs abc123" "Implement login endpoint"
neo memory write --type feedback --scope /path/to/repo "User wants PR descriptions in French"

# Update
neo memory update <id> "Updated content"
neo memory update <id> --outcome done          # pending, in_progress, done, blocked, abandoned

# Search & list
neo memory search "authentication"              # Semantic search (uses embeddings if available)
neo memory list                                 # All memories
neo memory list --type fact                     # Filter by type: fact, procedure, episode, focus, feedback, task

# Delete
neo memory forget <id>

# Statistics
neo memory stats                                # Count by type and scope
```

**Memory types:**

| Type | Use when | TTL |
|------|----------|-----|
| `fact` | Stable truth affecting dispatch decisions | Permanent (decays) |
| `procedure` | Same failure 3+ times, reusable how-to | Permanent |
| `focus` | Current working context (scratchpad) | `--expires` required |
| `task` | Planned work items | Until done/abandoned |
| `feedback` | Recurring review complaints | Permanent |
| `episode` | Event log entries | Permanent (decays) |

Additional flags: `--scope` (default: global), `--source` (developer/reviewer/supervisor/user), `--severity` (critical/high/medium/low), `--category` (context reference), `--tags` (comma-separated).

### neo webhooks — Event notifications

Neo can push events to external URLs when things happen (agent completes, budget alert, etc.).

```bash
neo webhooks                      # List all registered webhooks
neo webhooks add https://example.com/neo-events   # Register a new endpoint
neo webhooks remove https://example.com/neo-events # Deregister
neo webhooks test                 # Test all endpoints (shows response codes + latency)
neo webhooks --output json        # Machine-readable
```

**Events emitted:** `supervisor_started`, `heartbeat`, `run_dispatched`, `run_completed`, `supervisor_stopped`, `session:start`, `session:complete`, `session:fail`, `cost:update`, `budget:alert`.

**Webhook payloads** are JSON. Optional HMAC signature verification via `X-Neo-Signature` header (configure `supervisor.secret` in config).

**Receiving webhooks in your app:**
```
POST /webhook
Content-Type: application/json
X-Neo-Signature: sha256=<hmac>

{
  "event": "run_completed",
  "source": "neo-supervisor",
  "payload": {
    "runId": "abc-123",
    "status": "completed",
    "costUsd": 1.24,
    "durationMs": 45000
  }
}
```

### neo mcp — MCP server integrations

MCP (Model Context Protocol) servers give agents access to external tools (Linear, GitHub, Notion, etc.).

```bash
neo mcp list                      # List configured MCP servers

# Add a preset (auto-configured)
neo mcp add linear                # Requires LINEAR_API_KEY env var
neo mcp add github                # Requires GITHUB_TOKEN env var
neo mcp add notion                # Requires NOTION_TOKEN env var
neo mcp add jira                  # Requires JIRA_API_TOKEN + JIRA_URL env vars
neo mcp add slack                 # Requires SLACK_BOT_TOKEN env var

# Add a custom MCP server
neo mcp add my-server --type stdio --command npx --serverArgs "@org/my-mcp-server"
neo mcp add my-http-server --type http --url http://localhost:8080

# Remove
neo mcp remove linear
```

Once configured, MCP tools are available to the supervisor and agents during their sessions.

### neo repos — Repository management

```bash
neo repos                         # List registered repositories
neo repos add /path/to/repo --name my-project --branch main
neo repos remove my-project       # By name or path
```

### neo agents — List agents

```bash
neo agents                        # Table: name, model, sandbox, source (builtin/custom)
neo agents --output json          # Machine-readable
```

### neo doctor — Health check

```bash
neo doctor                        # Check all prerequisites
neo doctor --fix                  # Auto-fix missing directories, stale sessions
neo doctor --output json          # Machine-readable
```

---

## Configuration Reference

Neo stores global configuration in `~/.neo/config.yml`. Created automatically on `neo init`.

```yaml
repos:
  - path: "/path/to/your/repo"
    defaultBranch: main
    branchPrefix: feat
    pushRemote: origin
    gitStrategy: branch           # "branch" or "pr"

concurrency:
  maxSessions: 5                  # Total concurrent agent sessions
  maxPerRepo: 4                   # Max sessions per repository

budget:
  dailyCapUsd: 500                # Hard daily spending limit
  alertThresholdPct: 80           # Emit budget:alert at this threshold

recovery:
  maxRetries: 3                   # Retry attempts per session
  backoffBaseMs: 30000            # Base delay between retries

sessions:
  initTimeoutMs: 120000           # Timeout waiting for session init
  maxDurationMs: 3600000          # Max session duration (1 hour)

supervisor:
  port: 7777                      # Webhook server port
  dailyCapUsd: 50                 # Supervisor-specific daily cap
  secret: ""                      # HMAC secret for webhook signature verification

memory:
  embeddings: true                # Enable local vector embeddings for semantic search
```

### Editing configuration

The config file is plain YAML — edit directly:

```bash
# Open in editor
nano ~/.neo/config.yml

# Or use neo init to reset defaults
neo init
```

### Per-project setup

Each project has a `.neo/` directory (created by `neo init`):

```
.neo/
├── agents/           # Custom agent YAML definitions
│   └── my-dev.yml    # Extends built-in agents
└── (created by init)
```

---

## Programmatic API

For deep integration, use `@neotx/core` directly:

```typescript
import { AgentRegistry, loadGlobalConfig, Orchestrator } from "@neotx/core";

const config = await loadGlobalConfig();
const orchestrator = new Orchestrator(config);

// Load agents
const registry = new AgentRegistry("path/to/agents");
await registry.load();
for (const agent of registry.list()) {
  orchestrator.registerAgent(agent);
}

// Listen to events
orchestrator.on("session:complete", (e) => console.log(`Done: $${e.costUsd}`));
orchestrator.on("session:fail", (e) => console.log(`Failed: ${e.error}`));
orchestrator.on("budget:alert", (e) => console.log(`Budget: ${e.utilizationPct}%`));

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

---

## Typical Workflows

### Feature implementation (supervisor — recommended)

```bash
# Just describe what you want — the supervisor orchestrates everything
neo supervise --message "Implement JWT authentication: login/register endpoints, middleware, refresh tokens, and tests"

# Monitor progress
neo supervisor status
neo supervisor activity --type dispatch
neo runs --short --status running
neo cost --short

# Send follow-up context if needed
neo supervise --message "The JWT secret should come from env var JWT_SECRET, not hardcoded"
```

The supervisor will autonomously: refine the task if vague → dispatch architect for design → dispatch developer for each sub-task → dispatch reviewer → dispatch fixer if issues → report completion.

### Bug fix (supervisor)

```bash
neo supervise --message "Fix: POST /api/users returns 500 when email contains '+'. The Zod schema rejects it. High priority."
```

### Code review (supervisor)

```bash
neo supervise --message "Review PR #42 on branch feat/caching. Focus on cache invalidation strategy and memory leaks."
```

### Feature implementation (direct dispatch — advanced)

```bash
# 1. Design
neo run architect --prompt "Design auth system with JWT" --repo . --branch feat/auth

# 2. Read architect output, get task list
neo runs <architectRunId>

# 3. Implement each task
neo run developer --prompt "Task 1: Create JWT middleware" --repo . --branch feat/auth \
  --meta '{"label":"T1-jwt-middleware","stage":"develop"}'

# 4. Review
neo run reviewer --prompt "Review PR on branch feat/auth" --repo . --branch feat/auth

# 5. Fix if needed
neo run fixer --prompt "Fix issues: missing token expiry check" --repo . --branch feat/auth
```

### Bug fix (direct dispatch)

```bash
neo run developer --prompt "Fix: POST /api/users returns 500 when email contains '+'. The Zod schema rejects it." \
  --repo . --branch fix/email-validation --priority high
```
