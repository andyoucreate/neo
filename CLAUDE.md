# Philosophy
- Framework, not product: neo is a library — no UI, no database, no opinions on trackers or notifications
- SDK-first: wrap the Claude Agent SDK, don't replace it — SDK updates flow through naturally
- YAML for definitions, TypeScript for dispatch: agents and workflows are YAML, orchestration is code
- Zero infrastructure: JSONL journals, git clone isolation, in-memory semaphore — no Docker, no Redis, no DB

# What this project does
Orchestration framework for autonomous developer agents. Wraps the Claude Agent SDK with clone isolation, 3-level recovery, DAG workflows, concurrency control, budget guards, and approval gates.
Extracted from the Voltaire Network dispatch-service (in archive/) which runs in production.

# Stack
- Monorepo: 3 packages — @neotx/core (engine), neotx (thin wrapper), @neotx/agents (prompts + YAML)
- Biome for lint+format (not ESLint) — config in biome.json
- @anthropic-ai/claude-agent-sdk is the only runtime AI dependency

# Commands
pnpm build && pnpm typecheck && pnpm test   # full validation pass
# No special setup — standard pnpm workspace scripts

# Architecture decisions
- Zod schemas are the single source of truth for types — use z.infer<>, not separate interfaces
- Each agent session gets an isolated git clone (`git clone --local`) — no shared state, no mutex needed
- One clone per workflow run — all steps share it. Parallel writable steps are forbidden
- Events are the integration primitive — orchestrator extends EventEmitter, everything emits typed events
- JSONL append-only journals for cost + events — monthly rotation, no database
- Middleware converts to SDK hooks format via buildSDKHooks() — not a custom hook system

# Patterns to follow
- ESM only: "type": "module" everywhere, tsup for bundling, `@/` path aliases for internal imports (Bundler resolution)
- Recovery escalation: normal → resume session → fresh session (3 levels, per ADR-020)
- Persisted runs: .neo/runs/<runId>.json written after EVERY step — enables cross-process resume
- Agent extends: $inherited token in tools array keeps parent tools, promptAppend adds to inherited prompt

# Do NOT
- Do not merge branches automatically — neo creates branches/PRs but NEVER merges (destructive, irreversible). **Exception:** in `autoDecide` mode, the supervisor MAY merge branches when it judges the PR is ready (CI green, review passed)
- Do not use exec() for git commands — use execFile() to prevent shell injection
- Do not add infrastructure dependencies (SQLite, Redis, etc.) — zero-infra is a hard constraint (ADR-007)
- Do not put business logic in CLI commands — CLI is a thin wrapper over @neotx/core

# Key references
- Design plans: docs/plans/00-vision.md through 08-supervisor-skills.md
- Implementation prompts: docs/PROMPTS.md (one per phase, designed for /oneshot agents)
- Roadmap: docs/ROADMAP.md (phases 0-12 with dependency graph)
- Dispatch service (reference): archive/dispatch-service/src/ (patterns to extract, not copy)
