# Changelog

## 0.1.0 (2026-03-14)

First public release.

### Features

- **Orchestrator** - dispatch agents with concurrency control, budget guards, and typed event streaming
- **8 built-in agents** - architect, developer, fixer, refiner, and 4 specialized reviewers (quality, security, perf, coverage)
- **Git worktree isolation** - each run gets its own branch and worktree, working directory is never touched
- **3-level recovery** - normal retry, session resume, fresh session with exponential backoff
- **Cost tracking** - daily budget caps, JSONL journals with monthly rotation, real-time budget alerts
- **Middleware system** - composable hooks with built-in budget guard, loop detection, and audit log
- **Agent inheritance** - extend built-in agents with `extends`, `promptAppend`, and `$inherited` tools
- **Run persistence** - `.neo/runs/<runId>.json` written after every step for cross-process recovery
- **CLI** - `neo init`, `neo run <agent>`, `neo agents`, `neo doctor`
- **Programmatic API** - full `@neo-cli/core` library for custom orchestration

### Architecture

- Monorepo with 3 packages: `@neo-cli/core`, `@neo-cli/cli`, `@neo-cli/agents`
- Zero infrastructure - no database, no Redis, no Docker
- Zod schemas as single source of truth for all types
- ESM only, TypeScript strict, Biome for linting
- 248 tests covering all modules
