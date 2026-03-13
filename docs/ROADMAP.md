# Neo — Roadmap

Implementation roadmap for `@neo-cli/core`, `@neo-cli/cli`, and `@neo-cli/agents`.
Each milestone produces something testable. Estimated effort assumes one developer using Claude Code agents.

---

## Overview

```
Phase 0   Scaffold                          ░░░░
Phase 1   Types & Config                    ░░░░
Phase 2   Agent Loader                      ░░░░░░
Phase 3   Isolation & Git                   ░░░░░░
Phase 4   Concurrency                       ░░░░
Phase 5   Runner & Recovery                 ░░░░░░░░
Phase 6   Middleware                         ░░░░░░
Phase 7   Events & Cost                     ░░░░░░
Phase 8   Orchestrator                      ░░░░░░░░░░
Phase 9a  Workflow: Graph & Loader          ░░░░░░
Phase 9b  Workflow: Persistence & Context   ░░░░░░
Phase 9c  Workflow: Executor                ░░░░░░░░░░
Phase 9d  Workflow: Gates & Built-ins       ░░░░░░
Phase 10  CLI                               ░░░░░░░░░░░░
Phase 11  Metrics                           ░░░░
Phase 12  Polish & Publish                  ░░░░░░
```

### Dependency graph

```
Phase 0
    │
    ▼
Phase 1 ──────────────→ Phase 2
    │                        │
    ▼                        ▼
Phase 3 ──→ Phase 4 ──→ Phase 5
                              │
              Phase 6 ────────┤
                              │
              Phase 7 ────────┤
                              │
                              ▼
                         Phase 8
                              │
                    ┌─────────┤
                    ▼         ▼
                  9a  +  9b (parallel)
                    │         │
                    └────┬────┘
                         ▼
                        9c
                         │
                         ▼
                        9d
                         │
                ┌────────┼────────┐
                ▼        ▼        ▼
           Phase 10  Phase 11  Phase 12
```

**Parallelizable:** Phases 2, 3, 4 are independent after Phase 1. Phases 6, 7 are independent of each other. Phases 9a and 9b are independent.

---

## Milestone 1 — Foundation (Phases 0–2)

> **Goal:** Monorepo builds, config loads, agents resolve.

### Phase 0 — Scaffold

| Task | Files |
|------|-------|
| Init pnpm monorepo | `pnpm-workspace.yaml`, root `package.json` |
| Root tsconfig (strict) | `tsconfig.json`, `tsconfig.build.json` |
| ESLint config | `eslint.config.js` |
| `packages/core/` skeleton | `package.json`, `tsconfig.json`, `src/index.ts` |
| `packages/cli/` skeleton | `package.json`, `tsconfig.json`, `src/index.ts`, bin entry |
| `packages/agents/` skeleton | `package.json`, `prompts/*.md` |
| GitHub Actions CI | `.github/workflows/ci.yml` (typecheck + lint + test) |
| Archive dispatch-service | Move to `archive/`, stop modifying |

**Checkpoint:** `pnpm build` passes on an empty monorepo.

### Phase 1 — Types & Config

| Task | Files |
|------|-------|
| All shared types (from 03-data-model.md) | `core/src/types.ts` |
| Config loader (YAML → Zod → typed config) | `core/src/config.ts` |
| Zod schemas with sensible defaults | `core/src/config.ts` |
| Unit tests | `core/src/__tests__/config.test.ts` |

**Checkpoint:** `loadConfig(".neo/config.yml")` returns typed, validated `NeoConfig`.

### Phase 2 — Agent Loader

| Task | Files |
|------|-------|
| Zod schema for agent YAML | `core/src/agents/schema.ts` |
| Load .yml + resolve .md prompt files | `core/src/agents/loader.ts` |
| Merge logic: extends, `$inherited`, promptAppend | `core/src/agents/resolver.ts` |
| Registry class (list, get, built-in + custom) | `core/src/agents/registry.ts` |
| Migrate prompts from dispatch-service | `packages/agents/prompts/*.md` |
| Tests: extend, inherit, custom, invalid, collision | `core/src/__tests__/agents.test.ts` |

**Checkpoint:** `loadAgents(config)` returns `Record<string, ResolvedAgent>`. `neo agents` could list them.

---

## Milestone 2 — Runtime Engine (Phases 3–8)

> **Goal:** `neo.dispatch()` runs a single agent session with isolation, recovery, events, and cost tracking.

### Phase 3 — Isolation & Git

| Task | Files |
|------|-------|
| Worktree create/remove (extract from dispatch-service) | `core/src/isolation/worktree.ts` |
| SDK sandbox config (writable vs readonly) | `core/src/isolation/sandbox.ts` |
| Branch creation, push | `core/src/isolation/git.ts` |
| Per-repo mutex for git operations | `core/src/isolation/git-mutex.ts` |
| Tests: worktree lifecycle, mutex contention | `core/src/__tests__/isolation.test.ts` |

**Checkpoint:** `createWorktree(repo, branch)` / `removeWorktree(path)` work reliably under concurrency.

### Phase 4 — Concurrency

| Task | Files |
|------|-------|
| Semaphore with per-repo limits | `core/src/concurrency/semaphore.ts` |
| FIFO queue with priority | `core/src/concurrency/queue.ts` |
| Queue events (enqueue, dequeue) | Wired into semaphore |
| Tests: acquire/release, ordering, overflow | `core/src/__tests__/concurrency.test.ts` |

**Checkpoint:** `Semaphore.acquire(repo)` / `release(sessionId)` with blocking and queueing.

### Phase 5 — Runner & Recovery

| Task | Files |
|------|-------|
| SDK session wrapper (`query()` + events) | `core/src/runner/session.ts` |
| 3-level recovery (normal → resume → fresh) | `core/src/runner/recovery.ts` |
| Non-retryable error detection (`max_turns`) | `core/src/runner/recovery.ts` |
| Structured output parser (JSON extract + Zod) | `core/src/runner/output-parser.ts` |
| Session timeouts (init 2min, max 60min) | `core/src/runner/session.ts` |
| Tests: mock SDK, recovery escalation, output parsing | `core/src/__tests__/runner.test.ts` |

**Checkpoint:** `runSession(agent, prompt, options)` executes an SDK session with automatic retry and structured output.

### Phase 6 — Middleware

| Task | Files |
|------|-------|
| Middleware interface + types | `core/src/middleware/types.ts` |
| Chain execution (block/pass/async) | `core/src/middleware/chain.ts` |
| Loop detection (Bash command dedup) | `core/src/middleware/loop-detection.ts` |
| Audit log (JSONL tool calls) | `core/src/middleware/audit-log.ts` |
| Budget guard (daily cap) | `core/src/middleware/budget-guard.ts` |
| Convert chain to SDK hooks format | `core/src/middleware/chain.ts` |
| Tests: chain order, blocking, async | `core/src/__tests__/middleware.test.ts` |

**Checkpoint:** `buildHooks(middleware[])` returns SDK-compatible hooks.

### Phase 7 — Events & Cost

| Task | Files |
|------|-------|
| Safe EventEmitter (try/catch + wildcard) | `core/src/events/emitter.ts` |
| All NeoEvent type definitions | `core/src/events/types.ts` |
| JSONL event journal | `core/src/events/journal.ts` |
| Per-session cost accumulation | `core/src/cost/tracker.ts` |
| Monthly JSONL cost journal | `core/src/cost/journal.ts` |
| Daily budget enforcement + alerts | `core/src/cost/budget.ts` |
| In-memory cache for daily cost total | `core/src/cost/journal.ts` |
| Tests: emission, wildcard, cost accumulation | `core/src/__tests__/events.test.ts` |

**Checkpoint:** Event system works. Cost tracking writes JSONL. Budget alerts fire.

### Phase 8 — Orchestrator

| Task | Files |
|------|-------|
| Main class (composes all subsystems) | `core/src/orchestrator.ts` |
| `dispatch()` — validate → semaphore → worktree → run | `core/src/orchestrator.ts` |
| `pause()` / `resume()` / `kill()` / `drain()` | `core/src/orchestrator.ts` |
| `status` / `activeSessions` / `metrics` getters | `core/src/orchestrator.ts` |
| Idempotency check (deduplicate dispatches) | `core/src/orchestrator.ts` |
| Input validation (prompt size, metadata depth) | `core/src/orchestrator.ts` |
| Graceful shutdown protocol | `core/src/orchestrator.ts` |
| Startup recovery (orphaned runs + worktrees) | `core/src/orchestrator.ts` |
| Public API export | `core/src/index.ts` |
| Integration tests (mocked SDK, end-to-end dispatch) | `core/src/__tests__/orchestrator.test.ts` |

**Checkpoint:** `neo.dispatch({ workflow: "hotfix", repo: ".", prompt: "..." })` runs a single-step workflow end-to-end.

---

## Milestone 3 — Workflow Engine (Phase 9)

> **Goal:** DAG-based multi-step workflows with persistence, conditions, and gates.

### Phase 9a — Graph & Loader (pure logic, no I/O)

| Task | Files |
|------|-------|
| Load workflow YAML, validate with Zod | `core/src/workflows/loader.ts` |
| Adjacency list, topological sort, cycle detection | `core/src/workflows/graph.ts` |
| Constraint enforcement (parallel writable, agent refs) | `core/src/workflows/validator.ts` |
| Condition expression parser (`status()`, `output()`, etc.) | `core/src/workflows/condition.ts` |
| Template resolution (`{{steps.plan.rawOutput}}`) | `core/src/workflows/template.ts` |
| Tests: all pure, no mocks needed | `core/src/__tests__/workflows/graph.test.ts` |

**Checkpoint:** `loadWorkflow("feature.yml")` + `buildGraph(def)` work. 100% unit-testable.

### Phase 9b — Persistence & Context (parallel with 9a)

| Task | Files |
|------|-------|
| Serialize/deserialize PersistedRun to JSON | `core/src/workflows/persistence.ts` |
| WorkflowContext class (create, load, update) | `core/src/workflows/context.ts` |
| Run targeting (`--step`, `--from`, `--retry`) | `core/src/workflows/context.ts` |
| Branch naming from repo config | `core/src/workflows/branch.ts` |
| Tests: round-trip, targeting logic, branch names | `core/src/__tests__/workflows/persistence.test.ts` |

**Checkpoint:** `createRun()`, `loadRun(id)`, `saveRun(run)`, `computeTargets(run, flags)` all work.

### Phase 9c — Executor (requires 9a + 9b)

| Task | Files |
|------|-------|
| Main execution loop (ready set → condition → run → persist → repeat) | `core/src/workflows/executor.ts` |
| Per-step recovery config merge | `core/src/workflows/executor.ts` |
| Wire into `Orchestrator.dispatch()` | `core/src/orchestrator.ts` |
| Tests (mocked SDK): linear, parallel, --step, --from, --retry | `core/src/__tests__/workflows/executor.test.ts` |

**Checkpoint:** `neo.dispatch({ workflow: "feature" })` runs a full DAG (mocked agents).

### Phase 9d — Gates & Built-in Workflows (requires 9c)

| Task | Files |
|------|-------|
| Gate logic: emit event, await approve/reject/timeout | `core/src/workflows/gate.ts` |
| Step-by-step mode: persist + exit at gate | `core/src/workflows/gate.ts` |
| `neo gate approve/reject` updates persisted state | `core/src/workflows/gate.ts` |
| `feature.yml` — architect → gate → dev → review → fix | `packages/agents/workflows/feature.yml` |
| `review.yml` — 4 parallel reviewers | `packages/agents/workflows/review.yml` |
| `hotfix.yml` — developer only | `packages/agents/workflows/hotfix.yml` |
| `refine.yml` — refiner with outputSchema | `packages/agents/workflows/refine.yml` |
| Tests: gate approve/reject/timeout, built-in validation | `core/src/__tests__/workflows/gate.test.ts` |

**Checkpoint:** `neo run feature --step plan` works end-to-end. Gates block and resume correctly.

---

## Milestone 4 — CLI & Ship (Phases 10–12)

> **Goal:** Users can `npx @neo-cli/neo run feature --prompt "Add auth"`.

### Phase 10 — CLI

| Task | Files |
|------|-------|
| Entry point, arg parsing (`parseArgs`) | `cli/src/index.ts` |
| Output formatter (human + `--output json`) | `cli/src/output.ts` |
| `neo init` — interactive wizard | `cli/src/commands/init.ts` |
| `neo run` — dispatch with all flags | `cli/src/commands/run.ts` |
| `neo gate approve/reject` | `cli/src/commands/gate.ts` |
| `neo runs` — list + inspect | `cli/src/commands/runs.ts` |
| `neo agents` / `neo workflows` — list | `cli/src/commands/agents.ts`, `workflows.ts` |
| `neo status` / `neo kill` | `cli/src/commands/status.ts`, `kill.ts` |
| `neo logs` / `neo cost` | `cli/src/commands/logs.ts`, `cost.ts` |
| `neo doctor` — prerequisite checks | `cli/src/commands/doctor.ts` |
| Supervisor skills (7 .md files) | `cli/src/skills/*.md` |
| `neo init` installs skills to `.claude/skills/neo/` | `cli/src/commands/init.ts` |

**Checkpoint:** All CLI commands work. `neo doctor` passes. Skills installed.

### Phase 11 — Metrics

| Task | Files |
|------|-------|
| Aggregate from cost journal | `core/src/metrics/collector.ts` |
| Success rate, avg cost, duration, retry rate | `core/src/metrics/collector.ts` |
| `costByDay()`, `costByWorkflow()` | `core/src/metrics/collector.ts` |
| Prometheus export format | `core/src/metrics/prometheus.ts` |
| Wire into Orchestrator as `neo.metrics` | `core/src/orchestrator.ts` |

**Checkpoint:** `neo.metrics.successRate("feature")` returns data. `neo cost --today` works.

### Phase 12 — Polish & Publish

| Task | Files |
|------|-------|
| README.md with quick start + examples | `README.md` |
| TSDoc on all public exports | `core/src/**/*.ts` |
| Error messages review (helpful, actionable) | All packages |
| `neo doctor` refinements | `cli/src/commands/doctor.ts` |
| Publish to npm | `@neo-cli/core`, `@neo-cli/cli`, `@neo-cli/agents` |

**Checkpoint:** `npx @neo-cli/neo init && npx @neo-cli/neo run feature --prompt "Add auth"` works from zero.

---

## Post-V1 (deferred)

These features were explicitly deferred to keep V1 focused:

| Feature | Why deferred | Revisit when |
|---------|-------------|--------------|
| **Workflow composition** (workflows as steps) | Adds nesting complexity (prefixed steps, shared worktree) | Users request reusable workflow fragments |
| **Fork** (`--fork` with new prompt) | Advanced use case, adds branching + persistence complexity | `--retry` proves insufficient for common recovery |
| **TypeScript builder API** | YAML covers 95% of use cases, builder is a second format to maintain | Users need truly dynamic workflows (computed step counts, etc.) |
| **Streaming events** | Events work, streaming adds SSE/WebSocket complexity | Users build real-time dashboards |
| **Plugin system** (custom step types, output formats) | Middleware + events cover most extension needs | Community requests specific extension points |

---

## Design documents

| Document | What it covers |
|----------|---------------|
| [00-vision.md](plans/00-vision.md) | Philosophy, what neo does and doesn't do |
| [01-architecture.md](plans/01-architecture.md) | Package structure, `.neo/` directory, design constraints |
| [02-core-api.md](plans/02-core-api.md) | Orchestrator API, events, dispatch, middleware, metrics |
| [03-data-model.md](plans/03-data-model.md) | All TypeScript types (config, agents, workflows, events) |
| [04-workflow-engine.md](plans/04-workflow-engine.md) | DAG concepts, execution modes, conditions, git strategy |
| [05-middleware.md](plans/05-middleware.md) | Middleware interface, built-in middleware, custom examples |
| [06-implementation-roadmap.md](plans/06-implementation-roadmap.md) | Detailed task lists per phase |
| [07-decisions.md](plans/07-decisions.md) | 22 Architecture Decision Records |
| [08-supervisor-skills.md](plans/08-supervisor-skills.md) | 7 Claude Code skills for the supervisor |
