# Neo — AI Integration Guide

You are about to use **neo**, an orchestration framework for autonomous developer agents. Neo wraps the Claude Agent SDK with clone isolation, recovery, budget guards, and approval gates.

## How it works

Neo runs a **supervisor** — a long-lived autonomous agent that acts as a CTO. You interact with the supervisor by sending it messages. The supervisor then dispatches specialized agents (developer, architect, reviewer, etc.) to do the actual work in isolated git clones.

**You do NOT write code directly.** You describe what you want, and the supervisor orchestrates agents to implement it.

## Quick start

```bash
# 1. Install the CLI globally
npm install -g @neotx/cli

# 2. Navigate to your project and initialize neo
cd /path/to/your/project
neo init

# 3. Start the supervisor
neo supervise
```

The supervisor TUI opens. Type your request in natural language. The supervisor will:
- Analyze your request
- Dispatch the right agent(s)
- Monitor progress
- Review results
- Iterate until done

## Core commands

| Command | Description |
|---------|-------------|
| `neo init` | Initialize neo in the current git repository |
| `neo supervise` | Start/attach to the supervisor (interactive TUI) |
| `neo supervise --message "your task"` | Send a message to the supervisor without opening TUI |
| `neo run --prompt "task" --agent developer` | Dispatch a single agent directly (bypass supervisor) |
| `neo runs` | List all runs and their status |
| `neo runs <runId>` | Show details of a specific run |
| `neo cost` | Show cost breakdown (today + all-time) |
| `neo logs --follow --run <runId>` | Follow a running agent's logs |
| `neo agents` | List available agents |
| `neo doctor` | Check environment prerequisites |

## Available agents

| Agent | Purpose | Mode |
|-------|---------|------|
| `developer` | Implement code changes, bug fixes, features | writable |
| `architect` | Design systems, plan features, decompose work | readonly |
| `reviewer` | Code review — blocks on critical issues | readonly |
| `fixer` | Fix issues found by reviewer | writable |
| `refiner` | Evaluate and split vague tickets | readonly |

## Typical workflow

### Through the supervisor (recommended)

```bash
neo supervise
# Then type: "Add a /health endpoint that returns { status: 'ok', uptime: process.uptime() }"
```

The supervisor will:
1. Optionally refine your request
2. Dispatch `architect` if design is needed
3. Dispatch `developer` to implement
4. Dispatch `reviewer` to review the PR
5. Dispatch `fixer` if issues are found
6. Report back when done

### Direct agent dispatch

```bash
# Simple implementation task
neo run --agent developer --prompt "Add a /health endpoint to src/server.ts that returns JSON { status: 'ok' }"

# Design a feature first
neo run --agent architect --prompt "Design a caching layer for the API. Consider Redis vs in-memory."

# Review existing code
neo run --agent reviewer --prompt "Review PR #42 on branch feat/caching"
```

## Key concepts

- **Clone isolation**: Each agent session runs in a separate `git clone --local`. No shared state, no conflicts.
- **Budget guards**: Daily spending caps prevent runaway costs. Check with `neo cost`.
- **3-level recovery**: If an agent fails, neo retries with escalating strategies (resume → fresh session).
- **Branches, not merges**: Agents create branches and PRs but NEVER merge. You keep control.
- **Zero infrastructure**: No database, no Redis, no Docker. Just git and the filesystem.

## Sending tasks to the supervisor

When using `neo supervise --message`, write clear, self-contained prompts:

```bash
# Good: specific, actionable
neo supervise --message "Fix the failing test in src/auth.test.ts — the JWT mock is returning an expired token"

# Good: feature with acceptance criteria
neo supervise --message "Add rate limiting to POST /api/upload: max 10 requests per minute per IP. Return 429 with Retry-After header."

# Bad: vague
neo supervise --message "Fix the tests"
```

## Monitoring

```bash
# Check what's running
neo supervise --status

# Watch a specific run
neo logs --follow --run <runId>

# Check costs
neo cost

# See recent activity
neo runs --last 5
```

## Configuration

Neo stores its config in `~/.neo/config.yml`. Key settings:

- `budget.dailyCapUsd` — daily spending limit (default: $10)
- `sessions.maxDurationMs` — max agent session duration
- `concurrency.maxParallelSessions` — parallel agent limit

Edit with any text editor or use `neo init` to set defaults.
