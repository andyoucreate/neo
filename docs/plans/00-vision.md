# Neo — Vision & Philosophy

## What is Neo?

Neo is an **orchestration framework for autonomous developer agents**. It provides the infrastructure layer that makes AI agent pipelines reliable, observable, and composable.

Neo is **not** a product. It's a toolkit. It doesn't ship a dashboard, a ticket tracker, or a notification system. Instead, it provides the primitives that let people build their own supervisor — whether that's a TUI, a Slack bot, a web dashboard, or a simple script.

## Core Thesis

Orchestrating AI dev agents is hard. Not because of the AI part — the Claude Agent SDK handles that. The hard part is everything around it:

- **Isolation**: agents need their own copy of the repo to avoid conflicts
- **Recovery**: sessions crash, rate limits hit, models hallucinate loops
- **Concurrency**: 5 agents on the same repo will corrupt each other's git state
- **Cost control**: an unmonitored agent can burn $500 in an hour
- **Observability**: you need to know what's happening in real-time
- **Composition**: real workflows aren't linear — they're graphs with conditions, parallelism, and human checkpoints

Neo solves all of this as a library. Import it, configure it, dispatch tasks, listen to events.

## What Neo Does

| Capability | Description |
|-----------|-------------|
| **Worktree isolation** | Each agent session gets its own git worktree — no conflicts |
| **Recovery + retry** | Auto-retry with session resume, exponential backoff |
| **Concurrency control** | Semaphore with per-repo limits and FIFO queue |
| **Budget guards** | Daily cost caps, per-session tracking, alerts |
| **Event streaming** | Typed, granular events for building any UI on top |
| **Task graphs** | DAG-based workflows with parallel steps, conditions, and gates |
| **Approval gates** | Human-in-the-loop at any pipeline step |
| **Middleware** | Composable hooks for security, auditing, custom logic |
| **Structured output** | Zod-validated agent outputs, not regex on stdout |
| **Metrics API** | Success rates, costs, durations — export to anything |

## What Neo Does NOT Do

- **No UI** — emit events, let users build their own
- **No ticket management** — users connect their own tracker (Linear, Jira, GitHub Issues)
- **No notifications** — users wire events to their own channels (Slack, email, webhooks)
- **No opinions on agents** — ships useful defaults, but users define their own
- **No database** — append-only JSONL journals, zero infrastructure

## Target Users

1. **Teams building internal dev tooling** — they want an orchestration engine to plug into their existing CI/CD and project management
2. **Solo developers** — they want to run `neo run feature "Add auth"` and get a PR
3. **Platform engineers** — they want to offer "AI dev agents as a service" to their org

## Prior Art

Neo is extracted from the Voltaire Network dispatch-service, which has been running in production orchestrating Claude Code sessions via the Agent SDK. The patterns (worktree isolation, recovery, semaphore, hooks) are battle-tested.

## Packages

```
@neotx/core     — orchestration engine (the framework)
neotx      — thin CLI wrapper for direct usage
@neotx/agents   — built-in agent definitions & prompts
```

The CLI is a convenience. The real product is `@neotx/core`.
