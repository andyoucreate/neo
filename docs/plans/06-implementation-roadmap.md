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

## Phase 9 — CLI

**Goal:** The supervisor's interface — drives agents via CLI commands. All commands support `--output json`.

**Tasks:**
- [ ] `cli/src/index.ts` — entry point, arg parsing (native `parseArgs`)
- [ ] `cli/src/output.ts` — output formatter (human-readable default, `--output json`)
- [ ] `neo init` — interactive wizard:
  - [ ] Detect project type (React, NestJS, Python, etc.) from package.json/pyproject.toml
  - [ ] Prompt: model preference (opus/sonnet), budget cap
  - [ ] Generate `.neo/config.yml` with repo config (branch strategy)
  - [ ] Optionally generate `.neo/agents/developer.yml` (extended, tuned for detected stack)
  - [ ] Non-interactive mode: `neo init --model sonnet --budget 100 --no-interactive`
- [ ] `neo run <agent> --repo --prompt` — dispatch a single agent
- [ ] `neo runs` — list persisted runs with status
- [ ] `neo runs <runId>` — inspect run output
- [ ] `neo agents` — list resolved agents (built-in + extended + custom)
- [ ] `neo status` — active sessions + queue
- [ ] `neo kill <sessionId>` — abort a session
- [ ] `neo logs [sessionId|runId]` — stream session events to stdout
- [ ] `neo cost [--today|--month]` — show cost summary
- [ ] `neo doctor` — check prerequisites (claude CLI, git, node version)
- [ ] `--output json` flag on all commands
- [ ] Bin entry in package.json
- [ ] Supervisor skills (`.claude/skills/neo/`):
  - [ ] `cli/src/skills/` — skill template .md files (neo-run, neo-inspect, neo-recover, neo-agents, neo-troubleshoot)
  - [ ] `neo init` — install skills to `.claude/skills/neo/` with frontmatter
  - [ ] `neo init --upgrade-skills` — update skills without touching config

**Deliverable:** `npx neotx run developer --prompt "Add auth"` + supervisor skills installed.

---

## Phase 10 — Metrics

**Goal:** Analytics API built on the event/cost journals.

**Tasks:**
- [ ] `core/src/metrics/collector.ts` — aggregate from cost journal
- [ ] Success rate, avg cost, avg duration, retry rate (per agent)
- [ ] `costByDay()`, `costByAgent()`
- [ ] Prometheus export format
- [ ] Wire into Orchestrator as `neo.metrics`
- [ ] Tests: metric calculations from sample data

**Deliverable:** `neo.metrics.successRate("developer")` API.

---

## Phase 11 — Polish & Publish

**Goal:** Production-ready npm package.

**Tasks:**
- [ ] README.md with examples
- [ ] API documentation (TSDoc on public exports)
- [ ] `neo doctor` refinements
- [ ] Error messages review (helpful, actionable)
- [ ] Publish to npm: `@neotx/core`, `neotx`, `@neotx/agents`
- [ ] `npx neotx` works out of the box

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
                                              ┌────────┼────────┐
                                              ▼        ▼        ▼
                                         Phase 9   Phase 10  Phase 11
                                          (CLI)   (metrics)  (publish)
```

## Notes

- Phases 1-7 can be partially parallelized (agents, isolation, concurrency are independent)
- Phase 8 is the integration point — everything must work before this
- Phase 9 (CLI) can start as soon as Phase 8 is done
- The dispatch-service stays running in production until neo is ready to replace it
