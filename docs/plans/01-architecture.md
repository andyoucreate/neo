# Neo — Architecture

## Package Structure

```
packages/
├── core/                          # Orchestration engine (zero HTTP, zero UI)
│   └── src/
│       ├── orchestrator.ts        # Main class — EventEmitter, public API
│       ├── config.ts              # Load & validate NeoConfig (YAML + Zod)
│       ├── types.ts               # All shared TypeScript types
│       │
│       ├── agents/
│       │   ├── loader.ts          # Load built-in + custom agents from YAML
│       │   ├── registry.ts        # Agent registry (merge built-in + custom)
│       │   └── schema.ts          # Zod schema for agent YAML config
│       │
│       ├── workflows/
│       │   ├── graph.ts           # DAG execution engine
│       │   ├── step.ts            # Workflow step definition
│       │   ├── gate.ts            # Approval gate logic
│       │   ├── context.ts         # Shared context between steps
│       │
│       ├── pipelines/             # Built-in workflow definitions
│       │   ├── feature.ts
│       │   ├── review.ts
│       │   ├── hotfix.ts
│       │   ├── fixer.ts
│       │   └── refine.ts
│       │
│       ├── runner/
│       │   ├── session.ts         # SDK session wrapper
│       │   ├── recovery.ts        # Retry + resume logic
│       │   └── output-parser.ts   # Structured output extraction (Zod)
│       │
│       ├── isolation/
│       │   ├── worktree.ts        # Git worktree create/cleanup
│       │   ├── sandbox.ts         # SDK sandbox configuration
│       │   └── git.ts             # Git operations (branch, lock, push)
│       │
│       ├── concurrency/
│       │   ├── semaphore.ts       # Global + per-repo concurrency limits
│       │   └── queue.ts           # FIFO dispatch queue
│       │
│       ├── middleware/
│       │   ├── types.ts           # Middleware interface
│       │   ├── chain.ts           # Middleware composition
│       │   ├── loop-detection.ts  # Block repeated commands
│       │   ├── audit-log.ts       # Tool call journaling
│       │   ├── budget-guard.ts    # Cost cap enforcement
│       │   └── backpressure.ts    # Rate limit → reduce concurrency
│       │
│       ├── events/
│       │   ├── emitter.ts         # Typed EventEmitter
│       │   ├── types.ts           # All event type definitions
│       │   └── journal.ts         # JSONL append-only event log
│       │
│       ├── cost/
│       │   ├── tracker.ts         # Per-session cost tracking
│       │   ├── journal.ts         # Monthly JSONL cost journal
│       │   └── budget.ts          # Daily budget enforcement
│       │
│       └── metrics/
│           ├── collector.ts       # Aggregate metrics from events
│           └── types.ts           # Metric types
│
├── agents/                        # Built-in agent prompts
│   └── prompts/
│       ├── architect.md
│       ├── developer.md
│       ├── refiner.md
│       ├── reviewer-quality.md
│       ├── reviewer-security.md
│       ├── reviewer-perf.md
│       ├── reviewer-coverage.md
│       └── fixer.md
│
└── cli/                           # CLI — the supervisor's interface
    └── src/
        ├── index.ts               # Entry point, arg parsing
        └── commands/
            ├── init.ts            # neo init — scaffold .neo/ in a repo
            ├── run.ts             # neo run <workflow> [--step|--from|--retry|--run-id]
            ├── runs.ts            # neo runs — list persisted runs and their state
            ├── agents.ts          # neo agents — list resolved agents (built-in + custom)
            ├── workflows.ts       # neo workflows — list available workflows
            ├── status.ts          # neo status — active sessions + queue
            ├── kill.ts            # neo kill <sessionId>
            ├── logs.ts            # neo logs [sessionId|runId]
            ├── cost.ts            # neo cost [--today|--month]
            └── doctor.ts          # neo doctor — check prerequisites
```

## User Configuration (`.neo/` directory)

Users create a `.neo/` directory in their project (or globally) to configure neo:

```
.neo/
├── config.yml                   # Main config (concurrency, budget, mcp servers)
├── agents/                      # Custom agent definitions
│   ├── my-agent.yml             # New agent — full definition
│   ├── my-agent.md              # Agent prompt (referenced from YAML)
│   └── developer.yml            # Override built-in — partial, merged with defaults
├── workflows/                   # Declarative workflow definitions (YAML)
│   ├── feature.yml              # Override built-in feature workflow
│   └── my-custom-flow.yml       # User's own workflow
└── runs/                        # Persisted run state (auto-managed by neo)
    ├── run-abc123.json           # Serialized WorkflowContext
    └── run-def456.json
```

### Agent Configuration Philosophy

Agents support **partial overrides** via `extends`. Users don't have to redefine everything — they tweak what matters:

```yaml
# .neo/agents/developer.yml — extends the built-in developer
extends: developer          # inherit prompt, tools, sandbox from built-in
model: sonnet               # override: use sonnet instead of opus (cheaper)
maxTurns: 50                # override: raise the limit
tools:                      # override: add WebSearch to the default toolset
  - $inherited              # special token: keep all built-in tools
  - WebSearch
```

```yaml
# .neo/agents/my-qa.yml — brand new agent (no extends)
name: my-qa
description: "QA specialist for e2e tests"
model: sonnet
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: my-qa.md
```

### Workflow Configuration Philosophy

Workflows are **declarative YAML** that define a launchable flow. The supervisor (user's code or script) invokes them via CLI. Runs are persisted so steps can be relaunched individually.

```yaml
# .neo/workflows/my-flow.yml
name: my-flow
description: "Custom feature pipeline with QA step"

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

  qa:
    agent: my-qa
    dependsOn: [implement]

  review:
    agent: reviewer-quality
    dependsOn: [qa]
    sandbox: readonly
```

The supervisor then drives the flow:

```bash
# Launch the full flow
neo run my-flow --repo ./my-app --prompt "Add OAuth2"

# Or step by step (supervisor decides when to proceed)
neo run my-flow --step plan --repo ./my-app --prompt "Add OAuth2"
# → outputs run-id: run-abc123

neo run my-flow --run-id run-abc123 --step implement
# → picks up context from plan step, runs implement

neo run my-flow --run-id run-abc123 --from review
# → runs review + everything after it

# Retry a failed step
neo run my-flow --run-id run-abc123 --retry implement
```

## Dependency Graph

```
neotx ──depends──> @neotx/core
                               │
                               ├──> @anthropic-ai/claude-agent-sdk
                               ├──> zod (config validation)
                               └──> yaml (config parsing)

@neotx/agents ──consumed-by──> @neotx/core (embedded prompts)
```

## Key Design Constraints

1. **Zero infrastructure** — no database, no Redis, no Docker. Just Node.js + git
2. **Zero HTTP in core** — the Orchestrator is a class, not a server. Users who want HTTP wrap it themselves
3. **Event-driven** — everything that happens emits a typed event. This is how users integrate
4. **Config over code** — agents and workflows are YAML. Only advanced dynamic logic (conditions, prompt functions) needs TypeScript
5. **SDK-first** — neo wraps the Claude Agent SDK, doesn't replace it. SDK updates flow through naturally
6. **CLI-driven orchestration** — the supervisor drives workflows via `neo run` commands. Runs are persisted so steps can be launched, retried, and resumed individually
7. **Extend, don't replace** — agents use `extends` to partially override built-ins. Users tweak what matters without redefining everything
8. **Claude Code native** — neo launches Claude Code sessions. The user's CLAUDE.md, project CLAUDE.md, and installed skills apply automatically. Neo handles orchestration, not prompting
9. **Machine-readable** — all CLI commands support `--output json` so any language/tool can drive neo
