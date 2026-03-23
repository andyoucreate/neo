---
name: neo
description: Orchestrate autonomous developer agents with neo. Use when the user asks to dispatch agents, implement features across repos, run code reviews, or manage an engineering team of AI agents. Covers installation, supervisor interaction, direct dispatch, monitoring, and configuration.
---

# Neo — AI Agent Orchestration

neo orchestrates autonomous developer agents (architect, developer, reviewer, scout) across git repositories with clone isolation, budget guards, and 3-level recovery.

## First time? Install and read the full guide

```bash
npm install -g @neotx/cli
neo guide
```

`neo guide` prints the complete AI integration reference — all commands, flags, workflows, and configuration options.

## Quick start (recommended: supervisor mode)

The **supervisor** is a long-lived autonomous daemon that acts as your CTO. You send it messages and it handles everything: agent selection, dispatch ordering, review cycles, retries, and memory.

```bash
# Initialize in your project
cd /path/to/project && neo init

# Start the supervisor
neo supervise --detach

# Send work — the supervisor handles the rest
neo supervise --message "Implement JWT authentication with login/register endpoints, middleware, and tests"

# Monitor
neo supervisor status
neo supervisor activity --limit 10
neo runs --short
neo cost --short
```

The supervisor autonomously orchestrates the full lifecycle: architect → develop → review → done (re-dispatches developer on review issues). It persists memory across sessions so it learns your codebase over time.

## Direct dispatch (advanced)

If you need fine-grained control, bypass the supervisor and dispatch agents directly:

```bash
neo run developer --prompt "Add rate limiting to POST /api/upload" \
  --repo /path/to/project --branch feat/rate-limit \
  --meta '{"label":"rate-limit","stage":"develop"}'

neo runs <runId>    # Read agent output when done
neo cost --short    # Check spending
```

## When to use neo

- User asks to implement a feature, fix a bug, or refactor code across a repo
- User wants parallel agent execution (multiple tasks at once)
- User wants code review by specialized agents
- User needs an autonomous engineering pipeline (design → implement → review → fix)
- User asks to "dispatch", "send to an agent", or "use neo"

## Key commands cheat sheet

| Command | Purpose |
|---------|---------|
| `neo supervise --message "..."` | Send task to supervisor |
| `neo supervisor status` | Check supervisor state |
| `neo run <agent> --prompt "..."` | Direct agent dispatch |
| `neo runs --short` | List recent runs |
| `neo runs <runId>` | Read agent output |
| `neo cost --short` | Check budget |
| `neo logs -f <runId>` | Follow live logs |
| `neo guide` | Full reference (all commands, flags, config) |
