# Neo — Implementation Roadmap

Ordered phases with clear deliverables. Each phase produces something usable.

---

## Phase 0 — Monorepo Scaffold

**Goal:** Project structure, tooling, CI.

**Tasks:**
- [ ] Init pnpm monorepo (`pnpm-workspace.yaml`)
- [ ] Root `package.json` with workspace scripts
- [ ] Root `tsconfig.json` (base, strict)
- [ ] Root `eslint.config.js`
- [ ] `packages/core/` — package.json, tsconfig extends root
- [ ] `packages/cli/` — package.json, tsconfig, bin entry
- [ ] `packages/agents/` — package.json, embedded .md prompts
- [ ] GitHub Actions CI (typecheck + lint + test on all packages)
- [ ] Archive `dispatch-service/` (keep as reference, stop modifying)

**Deliverable:** Empty monorepo that builds and passes CI.

---

## Phase 1 — Core Types & Config

**Goal:** Type foundation and config loading.

**Tasks:**
- [ ] `core/src/types.ts` — all shared types from 03-data-model.md
- [ ] `core/src/config.ts` — load `.neo/config.yml`, validate with Zod, merge defaults
- [ ] Config Zod schemas with sensible defaults
- [ ] `yaml` dependency for parsing
- [ ] Unit tests for config loading (valid, invalid, missing, partial)

**Deliverable:** `loadConfig(".neo/config.yml")` that returns typed, validated config.

---

## Phase 2 — Agent Loader (with extends)

**Goal:** Load built-in and custom agents with partial override support.

**Tasks:**
- [ ] `core/src/agents/schema.ts` — Zod schema for agent YAML (supports `extends`, `$inherited` tools, `promptAppend`)
- [ ] `core/src/agents/loader.ts` — load .yml + resolve .md prompt files
- [ ] `core/src/agents/resolver.ts` — merge logic: extends resolution, `$inherited` tool expansion, prompt append
- [ ] `core/src/agents/registry.ts` — registry class (built-in + custom merged, list/get methods)
- [ ] Migrate prompts from `.claude/agents/*.md` → `packages/agents/prompts/`
- [ ] Tests: load built-in, extend (model override, tool inherit+add, promptAppend), full custom, invalid schema, name collision

**Deliverable:** `loadAgents(config)` that returns `Record<string, ResolvedAgent>` with full merge support.

---

## Phase 3 — Isolation & Git

**Goal:** Worktree management and sandbox config.

**Tasks:**
- [ ] `core/src/isolation/worktree.ts` — extract from dispatch-service, clean up API
- [ ] `core/src/isolation/sandbox.ts` — SDK sandbox config (writable vs readonly)
- [ ] `core/src/isolation/git.ts` — branch creation, lock management, push
- [ ] Tests: create/remove worktree, sandbox config generation
- [ ] `core/src/isolation/git-mutex.ts` — per-repo mutex for serializing git operations
- [ ] Tests: concurrent git operations use mutex, no index corruption

**Deliverable:** `createWorktree(repo, branch)` / `removeWorktree(path)`.

---

## Phase 4 — Concurrency

**Goal:** Semaphore with per-repo limits and FIFO queue.

**Tasks:**
- [ ] `core/src/concurrency/semaphore.ts` — extract from dispatch-service
- [ ] `core/src/concurrency/queue.ts` — FIFO with priority support
- [ ] Emit queue events (enqueue, dequeue)
- [ ] Tests: acquire/release, queue ordering, per-repo limits, queue overflow

**Deliverable:** `Semaphore` class with `acquire(repo)` / `release(sessionId)`.

---

## Phase 5 — Runner & Recovery

**Goal:** Execute SDK sessions with automatic recovery.

**Tasks:**
- [ ] `core/src/runner/session.ts` — wrap SDK `query()`, emit typed events
- [ ] `core/src/runner/recovery.ts` — 3-level recovery (normal → resume session → fresh session), non-retryable error detection, exponential backoff
- [ ] `core/src/runner/output-parser.ts` — extract JSON from agent output, validate with Zod
- [ ] Wire up event emission (session:start, session:complete, session:fail, agent:tool_use)
- [ ] Tests: mock SDK, test recovery flow, output parsing

**Deliverable:** `runSession(agent, prompt, options)` with recovery and events.

---

## Phase 6 — Middleware

**Goal:** Composable hook system.

**Tasks:**
- [ ] `core/src/middleware/types.ts` — Middleware interface
- [ ] `core/src/middleware/chain.ts` — execute middleware chain, handle block/pass/async
- [ ] `core/src/middleware/loop-detection.ts` — extract from dispatch-service hooks
- [ ] `core/src/middleware/audit-log.ts` — JSONL tool call logging
- [ ] `core/src/middleware/budget-guard.ts` — daily cost cap
- [ ] Convert middleware chain to SDK hooks format
- [ ] Tests: chain execution, blocking, async, ordering

**Deliverable:** `buildHooks(middleware[])` that returns SDK-compatible hooks.

---

## Phase 7 — Events & Cost

**Goal:** Typed event system and cost tracking.

**Tasks:**
- [ ] `core/src/events/emitter.ts` — typed EventEmitter with wildcard support
- [ ] `core/src/events/types.ts` — all NeoEvent types
- [ ] `core/src/events/journal.ts` — JSONL append-only event log
- [ ] `core/src/cost/tracker.ts` — per-session cost accumulation
- [ ] `core/src/cost/journal.ts` — monthly JSONL cost journal
- [ ] `core/src/cost/budget.ts` — daily budget enforcement + alerts
- [ ] Tests: event emission, wildcard matching, cost accumulation
- [ ] In-memory cache for daily cost total (invalidated on write, avoids O(n) JSONL re-read)

**Deliverable:** Event system that powers all downstream features (UI, metrics, etc.)

---

## Phase 8 — Orchestrator (the main class)

**Goal:** Wire everything together into the public API.

**Tasks:**
- [ ] `core/src/orchestrator.ts` — main class, composes all subsystems
- [ ] `dispatch()` method — validate input, acquire semaphore, create worktree, run session
- [ ] `pause()` / `resume()` / `kill()` / `drain()` control methods
- [ ] `status` / `activeSessions` / `metrics` getters
- [ ] Integration tests: dispatch a task end-to-end (mocked SDK)
- [ ] Export public API from `core/src/index.ts`
- [ ] Graceful shutdown protocol: reject new dispatches → wait for active sessions → persist run states → cleanup worktrees → flush journals
- [ ] Startup recovery: scan for orphaned runs (status: "running") and orphaned worktrees

**Deliverable:** Working `Orchestrator` class — the core product.

---

## Phase 9 — Workflow Engine

Phase 9 is the highest-value feature. It's split into 4 sub-phases, each producing a testable milestone.

### Phase 9a — Graph & Loader (pure logic, no I/O)

**Goal:** Load YAML workflows, build and validate the DAG. No execution yet.

**Tasks:**
- [ ] `core/src/workflows/loader.ts` — load workflow YAML, validate with Zod schema
- [ ] `core/src/workflows/graph.ts` — build adjacency list from `dependsOn`, topological sort, cycle detection
- [ ] `core/src/workflows/validator.ts` — enforce constraints: no parallel writable steps, valid agent refs, no orphan dependsOn
- [ ] `core/src/workflows/condition.ts` — parse and evaluate condition expressions (`status()`, `output()`, `hasOutput()`, `always`, `never`)
- [ ] `core/src/workflows/template.ts` — resolve `{{steps.plan.rawOutput}}` and `{{prompt}}` templates
- [ ] Tests: valid/invalid YAML, cycle detection, topological ordering, parallel writable rejection, condition parsing, template resolution

**Deliverable:** `loadWorkflow("feature.yml")` returns a validated `WorkflowDefinition`. `buildGraph(def)` returns a sorted step list. All pure functions, 100% unit-testable.

### Phase 9b — Persistence & Context (run state, no execution)

**Goal:** Create, load, and update persisted run state.

**Tasks:**
- [ ] `core/src/workflows/persistence.ts` — serialize/deserialize `PersistedRun` to `.neo/runs/<runId>.json`
- [ ] `core/src/workflows/context.ts` — `WorkflowContext` class: create from dispatch, load from persisted run, update step results
- [ ] Run targeting logic: given `--step`, `--from`, `--retry` + existing run state → compute which steps are targeted
- [ ] `core/src/workflows/branch.ts` — branch naming from repo config (`feat/<runId>`, `fix/<runId>`, etc.)
- [ ] Tests: persistence round-trip (write → read → identical), targeting logic (all modes), branch naming

**Deliverable:** `createRun()`, `loadRun(runId)`, `saveRun(run)`, `computeTargets(run, flags)`. All I/O is filesystem only, no SDK dependency.

### Phase 9c — Executor (the main loop)

**Goal:** Execute a workflow graph end-to-end using the Orchestrator's runner.

**Tasks:**
- [ ] `core/src/workflows/executor.ts` — main execution loop:
  - Compute ready set from targeted steps
  - Evaluate conditions → skip or execute
  - Acquire semaphore → create/reuse worktree → build prompt (template) → run via runner → parse output
  - Persist after each step
  - Re-evaluate ready set → repeat until done
- [ ] Wire per-step recovery config into runner (merge step.recovery with global recovery)
- [ ] Wire into `Orchestrator.dispatch()` — detect workflow in input, load, execute
- [ ] Tests (mocked SDK): single-step mode, full-auto linear workflow, parallel readonly steps, --from resume, --retry

**Deliverable:** `neo.dispatch({ workflow: "feature", ... })` executes a full workflow with mocked agents. The core loop works.

### Phase 9d — Gates & Built-in Workflows

**Goal:** Approval gates + ship the 4 built-in workflows.

**Tasks:**
- [ ] `core/src/workflows/gate.ts` — gate logic:
  - Full-auto mode: emit `gate:waiting` event with `approve()`/`reject()` callbacks, await resolution or timeout
  - Step-by-step mode: persist run (gate status: "waiting"), exit
  - `neo gate approve/reject` updates persisted run state directly
  - Timeout → auto-reject, mark downstream as skipped
- [ ] Built-in workflow YAMLs in `packages/agents/workflows/`:
  - `feature.yml`: architect → gate → developer → reviewer-quality → conditional fixer
  - `review.yml`: 4 parallel reviewers (readonly)
  - `hotfix.yml`: developer only (no architect)
  - `refine.yml`: refiner with outputSchema
- [ ] Tests: gate approve/reject/timeout, built-in workflow validation, full feature workflow (mocked SDK)

**Deliverable:** Complete workflow engine. `neo run feature --step plan` works end-to-end.

---

## Phase 10 — CLI

**Goal:** The supervisor's interface — drives workflows via CLI commands. All commands support `--output json`.

**Tasks:**
- [ ] `cli/src/index.ts` — entry point, arg parsing (native `parseArgs`)
- [ ] `cli/src/output.ts` — output formatter (human-readable default, `--output json`)
- [ ] `neo init` — interactive wizard:
  - [ ] Detect project type (React, NestJS, Python, etc.) from package.json/pyproject.toml
  - [ ] Prompt: model preference (opus/sonnet), budget cap, enable review workflow
  - [ ] Generate `.neo/config.yml` with repo config (branch strategy)
  - [ ] Generate `.neo/workflows/feature.yml` (default workflow)
  - [ ] Optionally generate `.neo/agents/developer.yml` (extended, tuned for detected stack)
  - [ ] Non-interactive mode: `neo init --model sonnet --budget 100 --no-interactive`
- [ ] `neo run <workflow> --repo --prompt` — dispatch full workflow
- [ ] `neo run <workflow> --step <step>` — run single step, persist, exit
- [ ] `neo run <workflow> --run-id <id> --from <step>` — resume from step
- [ ] `neo run <workflow> --run-id <id> --retry <step>` — retry failed step
- [ ] `neo gate approve/reject <runId> <gateName>` — approve/reject gates
- [ ] `neo runs` — list persisted runs with status
- [ ] `neo runs <runId> [--step <step>]` — inspect run/step output
- [ ] `neo agents` — list resolved agents (built-in + extended + custom)
- [ ] `neo workflows` — list available workflows (built-in + custom)
- [ ] `neo status` — active sessions + queue
- [ ] `neo kill <sessionId>` — abort a session
- [ ] `neo logs [sessionId|runId]` — stream session events to stdout
- [ ] `neo cost [--today|--month]` — show cost summary
- [ ] `neo doctor` — check prerequisites (claude CLI, git, node version)
- [ ] `--output json` flag on all commands
- [ ] Bin entry in package.json
- [ ] Supervisor skills (`.claude/skills/neo/`):
  - [ ] `cli/src/skills/` — 7 skill template .md files (neo-run, neo-inspect, neo-recover, neo-agents, neo-workflows, neo-gate, neo-troubleshoot)
  - [ ] `neo init` — install skills to `.claude/skills/neo/` with frontmatter
  - [ ] `neo init --upgrade-skills` — update skills without touching config

**Deliverable:** `npx @neo-cli/neo run feature --prompt "Add auth"` + supervisor skills installed.

---

## Phase 11 — Metrics

**Goal:** Analytics API built on the event/cost journals.

**Tasks:**
- [ ] `core/src/metrics/collector.ts` — aggregate from cost journal
- [ ] Success rate, avg cost, avg duration, retry rate (per workflow, per agent)
- [ ] `costByDay()`, `costByWorkflow()`
- [ ] Prometheus export format
- [ ] Wire into Orchestrator as `neo.metrics`
- [ ] Tests: metric calculations from sample data

**Deliverable:** `neo.metrics.successRate("feature")` API.

---

## Phase 12 — Polish & Publish

**Goal:** Production-ready npm package.

**Tasks:**
- [ ] README.md with examples
- [ ] API documentation (TSDoc on public exports)
- [ ] `neo doctor` refinements
- [ ] Error messages review (helpful, actionable)
- [ ] Publish to npm: `@neo-cli/core`, `@neo-cli/cli`, `@neo-cli/agents`
- [ ] `npx @neo-cli/neo` works out of the box

**Deliverable:** Published, installable, documented packages.

---

## Dependency Graph

```
Phase 0 (scaffold)
    │
    ▼
Phase 1 (types + config) ──→ Phase 2 (agents)
    │                              │
    ▼                              ▼
Phase 3 (isolation) ──→ Phase 4 (concurrency) ──→ Phase 5 (runner)
                                                       │
                              Phase 6 (middleware) ─────┤
                                                       │
                              Phase 7 (events + cost) ──┤
                                                       │
                                                       ▼
                                                 Phase 8 (orchestrator)
                                                       │
                                                       ▼
                                                 Phase 9 (workflows)
                                                       │
                                              ┌────────┼────────┐
                                              ▼        ▼        ▼
                                        Phase 10   Phase 11  Phase 12
                                         (CLI)    (metrics)  (publish)
```

## Notes

- Phases 1-7 can be partially parallelized (agents, isolation, concurrency are independent)
- Phase 8 is the integration point — everything must work before this
- Phase 9 (workflows) is the highest-value feature — prioritize after Phase 8
- Phase 10 (CLI) can start as soon as Phase 8 is done
- The dispatch-service stays running in production until neo is ready to replace it
