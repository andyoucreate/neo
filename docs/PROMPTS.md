# Neo — Implementation Prompts

One prompt per phase. Each prompt is designed to be passed directly to a `/oneshot` or `cartesian-worker` agent. The agent receives the prompt, reads the referenced plan documents, and implements the phase autonomously.

**Convention:** Each prompt ends with a `## Checkpoint` section that defines what "done" looks like — the agent must validate this before marking the phase complete.

---

## Phase 0 — Monorepo Scaffold

```markdown
# Task: Scaffold the neo monorepo

Create a pnpm monorepo with 3 packages: `@neo-cli/core`, `@neo-cli/cli`, and `@neo-cli/agents`.

## Context

Read these documents before starting:
- `docs/plans/01-architecture.md` — package structure and `.neo/` directory layout
- `docs/ROADMAP.md` — Phase 0 tasks and file list

## Requirements

### 1. Root configuration

- `pnpm-workspace.yaml` referencing `packages/*`
- Root `package.json` with:
  - `name: "neo-monorepo"` (private: true)
  - Workspace scripts: `build`, `test`, `lint`, `typecheck` (run across all packages)
  - Dev dependencies: `typescript`, `vitest`, `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`
- Root `tsconfig.json` — strict mode base config:
  - `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
  - `target: "ES2022"`, `module: "Node16"`, `moduleResolution: "Node16"`
- Root `tsconfig.build.json` extending `tsconfig.json` with `composite: true` and project references
- Root `eslint.config.js` — flat config with TypeScript rules

### 2. packages/core/

- `package.json`: name `@neo-cli/core`, type `module`, main/types pointing to `dist/`
- `tsconfig.json` extending root, `outDir: "dist"`, `rootDir: "src"`
- `src/index.ts` — empty export (`export {}`)
- `vitest.config.ts` configured for this package

### 3. packages/cli/

- `package.json`: name `@neo-cli/cli`, type `module`, bin entry `neo` → `dist/index.js`
- `tsconfig.json` extending root
- `src/index.ts` — `#!/usr/bin/env node` + placeholder
- Dependency on `@neo-cli/core` via `workspace:*`

### 4. packages/agents/

- `package.json`: name `@neo-cli/agents`, type `module`
- `prompts/` directory with placeholder `.gitkeep`
- No TypeScript compilation needed — this package only contains .md and .yml files

### 5. CI

- `.github/workflows/ci.yml`:
  - Triggers: push to main, all PRs
  - Steps: checkout, setup Node 22, setup pnpm, install, typecheck, lint, test
  - Matrix is NOT needed (monorepo scripts run all packages)

### 6. Archive

- Move `dispatch-service/` to `archive/dispatch-service/` (keep as reference, stop modifying)
- Add `archive/` to `.gitignore` or just leave it tracked for reference

## Constraints

- pnpm only (no npm, no yarn)
- Node 22+ (use "engines" field)
- ESM only (`"type": "module"` everywhere)
- Vitest for all tests
- No unnecessary dependencies — keep it minimal

## Checkpoint

- `pnpm install` succeeds
- `pnpm build` succeeds (even if packages are empty)
- `pnpm test` succeeds (no tests yet, vitest should pass with 0 tests)
- `pnpm typecheck` succeeds
- `pnpm lint` succeeds
- Directory structure matches `01-architecture.md`
```

---

## Phase 1 — Types & Config

```markdown
# Task: Implement core types and config loader

Create all shared TypeScript types and the YAML config loader with Zod validation.

## Context

Read these documents before starting:
- `docs/plans/03-data-model.md` — ALL type definitions to implement
- `docs/plans/01-architecture.md` — file locations
- `docs/ROADMAP.md` — Phase 1 tasks

## Requirements

### 1. Core types — `packages/core/src/types.ts`

Implement ALL types from `03-data-model.md`:
- `NeoConfig`, `RepoConfig`, `McpServerConfig`
- `AgentConfig`, `AgentModel`, `AgentToolEntry`, `AgentTool`, `ResolvedAgent`
- `WorkflowDefinition`, `WorkflowStepDef`, `WorkflowGateDef`
- `PersistedRun`, `StepResult`
- `DispatchInput`, `Priority`, `TaskResult`
- `ActiveSession`, `OrchestratorStatus`
- `WorkflowContext`
- All event types (`SessionStartEvent`, `SessionCompleteEvent`, etc.)
- `NeoEvent` union type
- `Middleware`, `MiddlewareHandler`, `MiddlewareEvent`, `MiddlewareContext`, `MiddlewareResult`
- `HookEvent`
- `CostEntry`, `MetricsSnapshot`, `AgentMetrics`

Copy types EXACTLY from the data model document. Do not invent new fields.

### 2. Config loader — `packages/core/src/config.ts`

- `loadConfig(configPath: string): Promise<NeoConfig>` — loads `.neo/config.yml`
- Uses `yaml` package to parse YAML
- Uses `zod` to validate and apply defaults
- Zod schema must match `NeoConfig` interface exactly
- Sensible defaults for ALL optional fields:
  - `concurrency.maxSessions: 5`, `maxPerRepo: 2`, `queueMax: 50`
  - `budget.dailyCapUsd: 500`, `alertThresholdPct: 80`
  - `recovery.maxRetries: 3`, `backoffBaseMs: 30_000`
  - `sessions.initTimeoutMs: 120_000`, `maxDurationMs: 3_600_000`
  - `idempotency.enabled: true`, `key: "metadata"`, `ttlMs: 3_600_000`
- Throws a clear, actionable error if the config file is invalid

### 3. Dependencies

Add to `packages/core/package.json`:
- `zod` (runtime)
- `yaml` (runtime)

### 4. Tests — `packages/core/src/__tests__/config.test.ts`

Test cases:
- Valid config loads with all fields
- Partial config applies defaults correctly
- Missing required field (`repos`) throws descriptive error
- Invalid YAML throws
- Missing config file throws
- RepoConfig defaults (`defaultBranch: "main"`, `branchPrefix: "feat"`, etc.)
- McpServerConfig validates both `http` and `stdio` types

### 5. Public export

`packages/core/src/index.ts` — export everything:
```typescript
export * from "./types.js";
export { loadConfig } from "./config.js";
```

## Constraints

- All types must match `03-data-model.md` exactly
- Use `z.infer<>` to derive TypeScript types from Zod schemas (single source of truth)
- No classes for types — use interfaces and type aliases
- File extensions in imports: `.js` (ESM Node16 resolution)

## Checkpoint

- `pnpm typecheck` passes
- `pnpm test` passes — all config tests green
- `loadConfig()` returns typed `NeoConfig` from a valid YAML file
- Types exported from `@neo-cli/core`
```

---

## Phase 2 — Agent Loader

```markdown
# Task: Implement the agent loader with extends/merge support

Load built-in and custom agent definitions from YAML, resolve extends chains, and expose a registry.

## Context

Read these documents before starting:
- `docs/plans/03-data-model.md` — AgentConfig, ResolvedAgent, agent resolution rules
- `docs/plans/02-core-api.md` — agent configuration examples, extends syntax
- `docs/plans/01-architecture.md` — file locations
- `docs/ROADMAP.md` — Phase 2 tasks
- `dispatch-service/src/agents.ts` — existing agent loading logic (reference, don't copy)

## Requirements

### 1. Agent Zod schema — `packages/core/src/agents/schema.ts`

- Zod schema for `AgentConfig` (from YAML)
- Validates: name, extends, description, model, tools, prompt, promptAppend, sandbox, maxTurns, mcpServers
- `tools` array supports both `AgentTool` strings and the `"$inherited"` token
- Model is enum: `"opus" | "sonnet" | "haiku"`
- Sandbox is enum: `"writable" | "readonly"`

### 2. Agent loader — `packages/core/src/agents/loader.ts`

- `loadAgentFile(filePath: string): Promise<AgentConfig>` — loads a single .yml file, validates with Zod
- If the agent has a `prompt` field pointing to a .md file, resolve it relative to the YAML file's directory and read it
- If the agent has a `promptAppend` field, keep it as-is (merged later)

### 3. Agent resolver — `packages/core/src/agents/resolver.ts`

- `resolveAgent(config: AgentConfig, builtIns: Map<string, AgentConfig>): ResolvedAgent`
- Resolution rules (from 03-data-model.md):
  1. No `extends` → agent must define all required fields
  2. With `extends: "developer"` → start from built-in, apply overrides:
     - `model`, `sandbox`, `maxTurns`, `mcpServers` → simple replace
     - `description` → replace if provided, else inherit
     - `prompt` → replace if provided. Use `promptAppend` to append to inherited prompt
     - `tools: [Read, Write]` → replaces entire tool list
     - `tools: [$inherited, WebSearch]` → keeps inherited tools + adds WebSearch
  3. Same name as built-in without `extends:` → treated as `extends: <name>` implicitly

### 4. Agent registry — `packages/core/src/agents/registry.ts`

- `AgentRegistry` class:
  - `constructor(builtInDir: string, customDir?: string)`
  - `async load(): Promise<void>` — loads all agents from both directories
  - `get(name: string): ResolvedAgent | undefined`
  - `list(): ResolvedAgent[]`
  - `has(name: string): boolean`
- Built-in agents come from `packages/agents/`
- Custom agents come from `.neo/agents/`
- Custom agents override or extend built-in agents

### 5. Built-in agent definitions — `packages/agents/`

Create YAML definitions for all 8 built-in agents:
- `agents/architect.yml` + `prompts/architect.md`
- `agents/developer.yml` + `prompts/developer.md`
- `agents/refiner.yml` + `prompts/refiner.md`
- `agents/reviewer-quality.yml` + `prompts/reviewer-quality.md`
- `agents/reviewer-security.yml` + `prompts/reviewer-security.md`
- `agents/reviewer-perf.yml` + `prompts/reviewer-perf.md`
- `agents/reviewer-coverage.yml` + `prompts/reviewer-coverage.md`
- `agents/fixer.yml` + `prompts/fixer.md`

Check `archive/dispatch-service/` for existing prompts to migrate. Adapt them to the new format.

Agent properties (from 02-core-api.md):
| Agent | Model | Sandbox | Tools |
|-------|-------|---------|-------|
| architect | opus | readonly | Read, Glob, Grep, WebSearch, WebFetch |
| developer | opus | writable | Read, Write, Edit, Bash, Glob, Grep |
| refiner | opus | readonly | Read, Glob, Grep, WebSearch, WebFetch |
| reviewer-quality | sonnet | readonly | Read, Glob, Grep, Bash |
| reviewer-security | sonnet | readonly | Read, Glob, Grep, Bash |
| reviewer-perf | sonnet | readonly | Read, Glob, Grep, Bash |
| reviewer-coverage | sonnet | readonly | Read, Glob, Grep, Bash |
| fixer | opus | writable | Read, Write, Edit, Bash, Glob, Grep |

### 6. Tests — `packages/core/src/__tests__/agents.test.ts`

- Load a built-in agent
- Extend a built-in: override model only
- Extend with `$inherited` tools + new tool
- Extend with `promptAppend`
- Full custom agent (no extends)
- Invalid schema throws descriptive error
- Name collision: custom with same name as built-in → implicit extends
- Missing prompt file throws
- Registry: list(), get(), has()

### 7. Export

Add to `packages/core/src/index.ts`:
```typescript
export { AgentRegistry } from "./agents/registry.js";
export { loadAgentFile } from "./agents/loader.js";
export { resolveAgent } from "./agents/resolver.js";
```

## Checkpoint

- All agent tests pass
- `AgentRegistry.load()` loads all 8 built-in agents
- A custom agent with `extends: developer` + `tools: [$inherited, WebSearch]` resolves correctly
- `pnpm typecheck` passes
```

---

## Phase 3 — Isolation & Git

```markdown
# Task: Implement git worktree isolation and sandbox configuration

Provide reliable worktree lifecycle management and SDK sandbox config generation.

## Context

Read these documents before starting:
- `docs/plans/04-workflow-engine.md` — worktree & branch strategy, git mutex, cleanup protocol
- `docs/plans/07-decisions.md` — ADR-006 (worktree isolation), ADR-014 (one worktree per run), ADR-019 (branch strategy)
- `docs/ROADMAP.md` — Phase 3 tasks
- `archive/dispatch-service/src/worktree.ts` — existing implementation (extract and clean up)
- `archive/dispatch-service/src/git-lock.ts` — existing git lock implementation

## Requirements

### 1. Worktree manager — `packages/core/src/isolation/worktree.ts`

- `createWorktree(options: { repoPath: string; branch: string; baseBranch: string; worktreeDir: string }): Promise<WorktreeInfo>`
  - Creates a new branch from baseBranch
  - Creates a worktree at the specified directory
  - Returns `{ path, branch, repoPath }`
- `removeWorktree(worktreePath: string): Promise<void>`
  - Removes the worktree
  - Prunes worktree references
  - Does NOT delete the branch (branch stays for the PR)
- `listWorktrees(repoPath: string): Promise<WorktreeInfo[]>`
- `cleanupOrphanedWorktrees(worktreeBaseDir: string): Promise<void>` — remove worktrees that have no matching run
- All git operations must use the git mutex (from git-mutex.ts)

### 2. Git mutex — `packages/core/src/isolation/git-mutex.ts`

- Per-repo in-memory mutex using `Map<repoPath, Promise>`
- `withGitLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T>`
- Serializes all git operations on the same repo
- Must handle errors (release lock even on failure)
- This is critical: concurrent git operations on the same repo corrupt the index

### 3. Git operations — `packages/core/src/isolation/git.ts`

All operations acquire the git mutex internally:
- `createBranch(repoPath: string, branch: string, baseBranch: string): Promise<void>`
- `pushBranch(repoPath: string, branch: string, remote: string): Promise<void>`
- `fetchRemote(repoPath: string, remote: string): Promise<void>`
- `deleteBranch(repoPath: string, branch: string): Promise<void>`
- `getCurrentBranch(repoPath: string): Promise<string>`
- `getBranchName(config: RepoConfig, runId: string): string` — e.g. `feat/run-abc123`

Use `child_process.execFile` for git commands (NOT exec — avoid shell injection).

### 4. Sandbox config — `packages/core/src/isolation/sandbox.ts`

- `buildSandboxConfig(agent: ResolvedAgent, worktreePath?: string): SandboxConfig`
- Writable agent: allow all file operations in the worktree directory
- Readonly agent: no write tools, read access to the repo
- Returns SDK-compatible sandbox configuration

### 5. Tests — `packages/core/src/__tests__/isolation.test.ts`

- Worktree lifecycle: create → verify exists → remove → verify gone
- Git mutex: two concurrent operations on same repo are serialized (second waits for first)
- Git mutex: operations on different repos run in parallel
- Branch creation and naming
- Sandbox config: writable vs readonly agents produce correct configs
- Error handling: create worktree on non-existent repo throws
- Error handling: remove non-existent worktree is idempotent (no throw)

## Constraints

- Use `execFile` not `exec` for git commands (security)
- Git mutex MUST use try/finally to release lock on errors
- All paths must be absolute (resolve relative paths early)

## Checkpoint

- All isolation tests pass
- `createWorktree()` + `removeWorktree()` lifecycle works
- Git mutex prevents concurrent git operations on same repo
- `pnpm typecheck` passes
```

---

## Phase 4 — Concurrency

```markdown
# Task: Implement semaphore with per-repo limits and priority queue

Create a concurrency control system with global + per-repo limits and a FIFO priority queue.

## Context

Read these documents before starting:
- `docs/plans/03-data-model.md` — NeoConfig.concurrency, QueueEnqueueEvent, QueueDequeueEvent
- `docs/plans/02-core-api.md` — concurrency config
- `docs/ROADMAP.md` — Phase 4 tasks
- `archive/dispatch-service/src/concurrency.ts` — existing implementation (reference)

## Requirements

### 1. Semaphore — `packages/core/src/concurrency/semaphore.ts`

- `Semaphore` class:
  - `constructor(config: { maxSessions: number; maxPerRepo: number })`
  - `acquire(repo: string, sessionId: string): Promise<void>` — blocks until a slot is available
  - `release(sessionId: string): void` — releases the slot
  - `tryAcquire(repo: string, sessionId: string): boolean` — non-blocking attempt
  - `activeCount(): number` — total active slots
  - `activeCountForRepo(repo: string): number`
  - `isAvailable(repo: string): boolean` — can acquire without blocking?
- Enforces both global limit (`maxSessions`) and per-repo limit (`maxPerRepo`)
- When full, `acquire()` adds to the queue and awaits
- Release triggers dequeue of the next waiting session

### 2. Queue — `packages/core/src/concurrency/queue.ts`

- `PriorityQueue<T>` class:
  - `enqueue(item: T, priority: Priority): void`
  - `dequeue(): T | undefined`
  - `peek(): T | undefined`
  - `size: number`
  - `isEmpty: boolean`
  - `remove(predicate: (item: T) => boolean): boolean` — remove a specific item
- FIFO within same priority level
- Priority order: critical > high > medium > low
- Max queue size from config (reject with error when full)

### 3. Events

The semaphore should accept an optional `onEnqueue` and `onDequeue` callback for event emission:
- `onEnqueue: (sessionId: string, repo: string, position: number) => void`
- `onDequeue: (sessionId: string, repo: string, waitedMs: number) => void`

### 4. Tests — `packages/core/src/__tests__/concurrency.test.ts`

- Acquire and release: basic flow
- Global limit: acquiring beyond maxSessions blocks
- Per-repo limit: acquiring beyond maxPerRepo blocks
- Release unblocks waiting acquire
- Priority queue: critical dequeued before low
- FIFO within same priority
- Queue overflow: throws when exceeding queueMax
- Remove from queue: cancel a waiting session
- Concurrent acquire/release stress test
- `tryAcquire` returns false when full

## Checkpoint

- All concurrency tests pass
- Semaphore correctly enforces both global and per-repo limits
- Priority queue dequeues in correct order
- `pnpm typecheck` passes
```

---

## Phase 5 — Runner & Recovery

```markdown
# Task: Implement SDK session wrapper with 3-level recovery

Wrap the Claude Agent SDK to run agent sessions with automatic retry, recovery escalation, and structured output parsing.

## Context

Read these documents before starting:
- `docs/plans/03-data-model.md` — session types, StepResult, events
- `docs/plans/07-decisions.md` — ADR-008 (SDK-first), ADR-009 (structured output via Zod), ADR-020 (3-level recovery), ADR-021 (per-step recovery)
- `docs/ROADMAP.md` — Phase 5 tasks
- `archive/dispatch-service/src/recovery.ts` — existing recovery logic
- `@anthropic-ai/claude-agent-sdk` — the SDK we wrap (use context7 MCP to fetch latest docs)

## Requirements

### 1. Session wrapper — `packages/core/src/runner/session.ts`

- `runSession(options: SessionOptions): Promise<SessionResult>`
  ```typescript
  interface SessionOptions {
    agent: ResolvedAgent;
    prompt: string;
    worktreePath?: string;
    sandboxConfig: SandboxConfig;
    hooks?: SDKHooks;           // from middleware chain
    mcpServers?: McpServerConfig[];
    initTimeoutMs: number;      // abort if SDK doesn't respond (default: 2min)
    maxDurationMs: number;      // absolute session timeout (default: 60min)
    resumeSessionId?: string;   // for recovery level 2
  }

  interface SessionResult {
    sessionId: string;
    output: string;             // raw text output
    costUsd: number;
    durationMs: number;
    turnCount: number;
  }
  ```
- Uses the Agent SDK `query()` method
- Implements session timeouts (initTimeoutMs via AbortController, maxDurationMs via setTimeout)
- Emits events: `session:start`, `session:complete`, `session:fail`
- Takes an optional event emitter callback for event emission

### 2. Recovery — `packages/core/src/runner/recovery.ts`

Implements ADR-020 — 3-level recovery:

- `runWithRecovery(options: RecoveryOptions): Promise<SessionResult>`
  ```typescript
  interface RecoveryOptions extends SessionOptions {
    maxRetries: number;           // default: 3
    backoffBaseMs: number;        // default: 30_000
    nonRetryable?: string[];      // error types to skip (e.g. "max_turns")
    onAttempt?: (attempt: number, strategy: string) => void;
  }
  ```
- Level 1 (attempt 1): Normal execution — new session
- Level 2 (attempt 2): Resume session — pass `resumeSessionId` from level 1
- Level 3 (attempt 3): Fresh session — abandon previous, start clean
- Non-retryable errors (`error_max_turns`, `budget_exceeded`) → skip to failure immediately
- Backoff between levels: `backoffBaseMs * attempt` (30s → 60s → 90s)
- Track last sessionId for resume

### 3. Output parser — `packages/core/src/runner/output-parser.ts`

- `parseOutput(raw: string, schema?: ZodSchema): ParsedOutput`
  ```typescript
  interface ParsedOutput {
    rawOutput: string;
    output?: unknown;            // parsed JSON if schema provided
    parseError?: string;         // if JSON extraction or validation failed
  }
  ```
- Extract JSON from agent output (may be wrapped in markdown code blocks)
- If a Zod schema is provided, validate the extracted JSON
- If validation fails, return the raw output + parseError (caller decides whether to retry)

### 4. Dependencies

Add to `packages/core/package.json`:
- `@anthropic-ai/claude-agent-sdk` (runtime)

### 5. Tests — `packages/core/src/__tests__/runner.test.ts`

Mock the Agent SDK for all tests:
- Basic session: runs and returns result
- Init timeout: throws if SDK doesn't respond within initTimeoutMs
- Max duration timeout: aborts after maxDurationMs
- Recovery level 1→2→3 escalation
- Non-retryable error skips directly to failure
- Backoff timing (verify delays between attempts)
- Output parser: extracts JSON from markdown code block
- Output parser: validates against Zod schema
- Output parser: returns parseError on invalid JSON
- Resume session: level 2 passes the previous sessionId

## Constraints

- Mock the SDK in tests — never make real API calls
- Use AbortController for timeouts (not setTimeout + process.kill)
- The runner is stateless — recovery state is per-invocation, not persisted

## Checkpoint

- All runner tests pass
- `runWithRecovery()` escalates through 3 levels correctly
- Non-retryable errors fail immediately
- Output parser extracts and validates JSON
- `pnpm typecheck` passes
```

---

## Phase 6 — Middleware

```markdown
# Task: Implement the middleware system with built-in middleware

Create a composable middleware chain that integrates with the Agent SDK hooks.

## Context

Read these documents before starting:
- `docs/plans/05-middleware.md` — full middleware design, interface, built-ins, execution chain
- `docs/plans/03-data-model.md` — Middleware types
- `docs/ROADMAP.md` — Phase 6 tasks
- `archive/dispatch-service/src/hooks.ts` — existing hook implementation

## Requirements

### 1. Middleware types — `packages/core/src/middleware/types.ts`

Already defined in `types.ts` but re-export from here for convenience:
```typescript
export type { Middleware, MiddlewareHandler, MiddlewareEvent, MiddlewareContext, MiddlewareResult, HookEvent } from "../types.js";
```

### 2. Middleware chain — `packages/core/src/middleware/chain.ts`

- `buildMiddlewareChain(middleware: Middleware[]): MiddlewareChain`
  ```typescript
  interface MiddlewareChain {
    execute(event: MiddlewareEvent, context: MiddlewareContext): Promise<MiddlewareResult>;
  }
  ```
- Executes middleware in registration order
- If any middleware returns `{ decision: "block" }` → stop chain, return block result
- If middleware returns `{ async: true }` → continue chain, run handler in background
- If middleware returns `{}` → continue to next middleware
- Tool name matching: only run middleware if `match` is undefined or matches the tool name
- Hook event matching: only run middleware if `on` matches the event's hookEvent

- `buildSDKHooks(chain: MiddlewareChain): SDKHooks` — convert the chain to Agent SDK hooks format
  - Maps `PreToolUse` → SDK's `preToolUse` hook
  - Maps `PostToolUse` → SDK's `postToolUse` hook
  - Maps `Notification` → SDK's `notification` hook

### 3. Built-in: Loop detection — `packages/core/src/middleware/loop-detection.ts`

- `loopDetection(options: { threshold: number; scope?: "session" }): Middleware`
- Tracks Bash commands per session
- If the same command appears `threshold` times → block
- Per-session tracking (cleared when session ends)
- Only matches `Bash` tool

### 4. Built-in: Audit log — `packages/core/src/middleware/audit-log.ts`

- `auditLog(options: { dir: string; includeInput?: boolean; includeOutput?: boolean }): Middleware`
- Appends a JSONL line for every tool call
- File per session: `<dir>/<sessionId>.jsonl`
- Fields: timestamp, sessionId, agent, toolName, input (optional), output (optional), durationMs
- Uses `{ async: true }` — never blocks the chain

### 5. Built-in: Budget guard — `packages/core/src/middleware/budget-guard.ts`

- `budgetGuard(): Middleware`
- Checks daily cost against budget cap on every tool call
- If over budget → block with reason "Daily budget exceeded"
- Uses the middleware context's `get("costToday")` and `get("budgetCapUsd")`

### 6. Tests — `packages/core/src/__tests__/middleware.test.ts`

- Chain executes in order
- Block result stops the chain
- Async result continues the chain
- Tool name matching: middleware only runs for matching tools
- Hook event matching: PreToolUse middleware doesn't run on PostToolUse events
- Loop detection: blocks after threshold
- Loop detection: different commands don't count together
- Audit log: writes JSONL file (check file exists and content)
- Budget guard: blocks when over budget
- buildSDKHooks: returns correct hook format

## Checkpoint

- All middleware tests pass
- `buildMiddlewareChain()` produces a working chain
- `buildSDKHooks()` converts to SDK format
- Built-in middleware works correctly
- `pnpm typecheck` passes
```

---

## Phase 7 — Events & Cost

```markdown
# Task: Implement typed event system and cost tracking

Create a safe EventEmitter, JSONL journals, and daily budget enforcement.

## Context

Read these documents before starting:
- `docs/plans/03-data-model.md` — all event types, CostEntry
- `docs/plans/07-decisions.md` — ADR-004 (EventEmitter), ADR-007 (JSONL journals), ADR-022 (safe EventEmitter)
- `docs/ROADMAP.md` — Phase 7 tasks
- `archive/dispatch-service/src/event-journal.ts` — existing event journal
- `archive/dispatch-service/src/cost-journal.ts` — existing cost journal

## Requirements

### 1. Safe EventEmitter — `packages/core/src/events/emitter.ts`

- `NeoEventEmitter` class extending or wrapping Node.js `EventEmitter`:
  - `on(type: string, listener)` / `emit(type: string, event)` — standard interface
  - Wildcard support: `on("session:*", listener)` matches all `session:` events
  - Global wildcard: `on("*", listener)` matches everything
  - Try/catch on EVERY listener invocation (ADR-022):
    - Caught errors are emitted as `error` events
    - A buggy listener never crashes the orchestrator
  - Typed: generic type parameter for event types
  - `off(type, listener)` / `removeAllListeners(type?)`

### 2. Event types — `packages/core/src/events/types.ts`

Re-export all event types from `types.ts`. Add:
- `NeoEventMap` — a mapped type for type-safe `.on()`:
  ```typescript
  interface NeoEventMap {
    "session:start": SessionStartEvent;
    "session:complete": SessionCompleteEvent;
    "session:fail": SessionFailEvent;
    // ... etc
  }
  ```

### 3. Event journal — `packages/core/src/events/journal.ts`

- `EventJournal` class:
  - `constructor(options: { dir: string })`
  - `append(event: NeoEvent): Promise<void>` — append to JSONL file
  - `read(options?: { type?: string; runId?: string; since?: Date }): AsyncIterable<NeoEvent>`
  - File naming: `events-<YYYY-MM>.jsonl` (monthly rotation)
  - Append-only, crash-safe (one JSON line per event)

### 4. Cost tracker — `packages/core/src/cost/tracker.ts`

- `CostTracker` class:
  - `addCost(entry: CostEntry): void` — accumulate per-session cost
  - `getSessionCost(sessionId: string): number`
  - `getTodayTotal(): number` — in-memory cached daily total
  - `reset(): void` — clear all tracked costs

### 5. Cost journal — `packages/core/src/cost/journal.ts`

- `CostJournal` class:
  - `constructor(options: { dir: string })`
  - `append(entry: CostEntry): Promise<void>` — write to JSONL
  - `readDay(date: Date): Promise<CostEntry[]>`
  - `readMonth(year: number, month: number): AsyncIterable<CostEntry>`
  - `getDayTotal(date: Date): Promise<number>` — with in-memory cache
  - File naming: `cost-<YYYY-MM>.jsonl`
  - In-memory cache for daily total:
    - Invalidated when a new entry is appended
    - Avoids O(n) re-read of the JSONL for every check

### 6. Budget enforcement — `packages/core/src/cost/budget.ts`

- `BudgetEnforcer` class:
  - `constructor(config: { dailyCapUsd: number; alertThresholdPct: number }, journal: CostJournal)`
  - `check(): Promise<BudgetStatus>`
    ```typescript
    interface BudgetStatus {
      allowed: boolean;
      todayTotal: number;
      capUsd: number;
      utilizationPct: number;
    }
    ```
  - `shouldAlert(): Promise<boolean>` — true if utilization > alertThresholdPct
  - Uses the cached daily total from CostJournal

### 7. Tests — `packages/core/src/__tests__/events.test.ts`

- Emit and receive typed events
- Wildcard: `session:*` matches `session:start` and `session:complete`
- Global wildcard: `*` matches everything
- Safe emission: listener error doesn't crash, emits `error` event
- Event journal: append → read round-trip
- Cost tracker: accumulate and query
- Cost journal: append → readDay → getDayTotal round-trip
- Daily cache: getDayTotal doesn't re-read file on second call
- Budget enforcer: allows when under cap, rejects when over
- Budget alert: fires at threshold

## Checkpoint

- All event and cost tests pass
- `NeoEventEmitter` catches listener errors safely
- Wildcard event matching works
- Cost journal caches daily totals
- `pnpm typecheck` passes
```

---

## Phase 8 — Orchestrator

```markdown
# Task: Wire all subsystems into the Orchestrator class

The Orchestrator is the main public API of @neo-cli/core. It composes agents, isolation, concurrency, runner, middleware, events, and cost into a single class.

## Context

Read these documents before starting:
- `docs/plans/02-core-api.md` — full Orchestrator API (dispatch, control, events, metrics)
- `docs/plans/03-data-model.md` — DispatchInput, TaskResult, OrchestratorStatus
- `docs/plans/07-decisions.md` — ADR-001 (framework not product)
- `docs/ROADMAP.md` — Phase 8 tasks

## Requirements

### 1. Orchestrator — `packages/core/src/orchestrator.ts`

- `Orchestrator` class extending `NeoEventEmitter`:
  ```typescript
  class Orchestrator extends NeoEventEmitter {
    constructor(config: NeoConfig);

    // ─── Dispatch ────────────────────────
    dispatch(input: DispatchInput): Promise<TaskResult>;

    // ─── Control ─────────────────────────
    pause(): void;
    resume(): void;
    kill(sessionId: string): Promise<void>;
    drain(): Promise<void>;

    // ─── Getters ─────────────────────────
    get status(): OrchestratorStatus;
    get activeSessions(): ActiveSession[];

    // ─── Lifecycle ───────────────────────
    start(): Promise<void>;     // initialize, recover orphaned runs
    shutdown(): Promise<void>;  // graceful shutdown
  }
  ```

### 2. dispatch() flow

1. Validate input (prompt not empty, repo exists, workflow exists)
2. Idempotency check — deduplicate if same metadata/prompt within TTL
3. If paused → reject
4. Acquire semaphore (blocks if at capacity, enqueue with priority)
5. Create or reuse worktree (writable agents only)
6. Build middleware hooks → SDK hooks
7. Run session via `runWithRecovery()`
8. Parse structured output if schema provided
9. Store result, update cost
10. Release semaphore
11. Clean up worktree (if terminal run)
12. Emit events
13. Return TaskResult

All of steps 5-12 must be in try/finally to ensure semaphore release and cleanup.

### 3. Idempotency

- Deduplicate dispatches based on configured key (metadata or prompt)
- In-memory Map with TTL (clear entries after ttlMs)
- If duplicate found within TTL → return existing result or reject

### 4. Graceful shutdown — `shutdown()`

1. Set paused = true (reject new dispatches)
2. Wait for all active sessions to complete (or timeout after 5min)
3. Persist all run states
4. Clean up worktrees
5. Flush journals (events + cost)
6. Emit `orchestrator:shutdown` event

### 5. Startup recovery — `start()`

1. Load config, initialize all subsystems
2. Scan `.neo/runs/` for runs with status `"running"` → mark as `"failed"`
3. Scan worktree directory for orphaned worktrees → remove and prune
4. Semaphore resets to zero (in-memory, no persistence needed)

### 6. Input validation

- `prompt` must be non-empty string, max 100KB
- `repo` must be a valid path that exists
- `workflow` must exist in the registry
- `metadata` must be a plain object (no nested depth > 5)
- `step`/`from`/`retry` are mutually exclusive

### 7. Static middleware factories

Expose built-in middleware as static methods:
```typescript
static middleware = {
  loopDetection: (options) => ...,
  auditLog: (options) => ...,
  budgetGuard: () => ...,
};
```

### 8. Public API export — `packages/core/src/index.ts`

Export the Orchestrator and all public types. This is the complete public API of `@neo-cli/core`.

### 9. Tests — `packages/core/src/__tests__/orchestrator.test.ts`

Mock the Agent SDK. Test:
- dispatch() end-to-end: input → validate → semaphore → worktree → session → result
- dispatch() while paused → rejects
- Idempotency: same dispatch within TTL → rejected
- kill() aborts a running session
- drain() waits for active sessions then resolves
- Graceful shutdown sequence
- Startup recovery: orphaned runs marked as failed
- Input validation: empty prompt, invalid repo, non-existent workflow
- Events emitted at correct points
- Cost tracked and budget checked

## Constraints

- The Orchestrator does NOT implement workflow DAG execution yet — that's Phase 9
- For now, `dispatch()` runs a SINGLE agent session (the first step or the only step)
- The workflow engine will be wired in Phase 9c

## Checkpoint

- All orchestrator tests pass
- `neo.dispatch({ workflow: "hotfix", repo: ".", prompt: "Fix the bug" })` runs end-to-end (mocked SDK)
- Events emitted correctly
- Graceful shutdown works
- `pnpm typecheck` passes
- `packages/core/src/index.ts` exports everything needed
```

---

## Phase 9a — Workflow Graph & Loader

```markdown
# Task: Implement workflow YAML loader and DAG graph engine (pure logic, no I/O)

Build the foundation for the workflow engine: load YAML, build DAG, validate constraints, evaluate conditions, resolve templates.

## Context

Read these documents before starting:
- `docs/plans/04-workflow-engine.md` — full workflow engine design, graph algorithm, conditions, templates
- `docs/plans/03-data-model.md` — WorkflowDefinition, WorkflowStepDef, WorkflowGateDef
- `docs/ROADMAP.md` — Phase 9a tasks

## Requirements

### 1. Workflow loader — `packages/core/src/workflows/loader.ts`

- `loadWorkflow(filePath: string): Promise<WorkflowDefinition>`
- Reads YAML file, validates with Zod schema
- Zod schema for:
  - `WorkflowDefinition`: name (required), description (optional), steps (required)
  - `WorkflowStepDef`: type (default "step"), agent (required), dependsOn, prompt, sandbox, maxTurns, mcpServers, recovery
  - `WorkflowGateDef`: type "gate" (required), dependsOn, description (required), timeout, autoApprove
- Returns validated, typed `WorkflowDefinition`
- Clear error messages on invalid YAML

### 2. Graph engine — `packages/core/src/workflows/graph.ts`

All pure functions:
- `buildAdjacencyList(steps: Record<string, WorkflowStepDef | WorkflowGateDef>): AdjacencyList`
- `topologicalSort(adjacency: AdjacencyList): string[]` — Kahn's algorithm
- `detectCycles(adjacency: AdjacencyList): string[] | null` — returns cycle path or null
- `getReadySteps(adjacency: AdjacencyList, completed: Set<string>, targeted: Set<string>): string[]` — steps with all dependencies met
- `getDependents(adjacency: AdjacencyList, stepName: string): string[]` — all downstream steps
- `getAncestors(adjacency: AdjacencyList, stepName: string): string[]` — all upstream steps

### 3. Validator — `packages/core/src/workflows/validator.ts`

- `validateWorkflow(def: WorkflowDefinition, agentNames: Set<string>): ValidationResult`
  ```typescript
  interface ValidationResult {
    valid: boolean;
    errors: string[];
  }
  ```
- Checks:
  - No cycles in the dependency graph
  - All `agent` references exist in the agent registry
  - All `dependsOn` references exist as step names
  - No parallel writable steps (two writable steps with no dependency between them)
  - No orphan dependencies (dependsOn a step that doesn't exist)
  - At least one step defined
  - No duplicate step names (handled by YAML parsing, but verify)

### 4. Condition parser — `packages/core/src/workflows/condition.ts`

- `evaluateCondition(condition: string, context: WorkflowContext): boolean`
- Supported expressions:
  - `"always"` → true (default)
  - `"never"` → false
  - `"hasOutput(stepName)"` → step produced non-empty output
  - `"status(stepName) == 'success'"` → step status check
  - `"output(stepName).fieldName == value"` → structured output field check
- Simple expression parser — NOT arbitrary JavaScript eval
- Use regex or a small hand-written parser
- Throws on unknown syntax with a helpful error

### 5. Template resolver — `packages/core/src/workflows/template.ts`

- `resolveTemplate(template: string, context: WorkflowContext): string`
- Replaces `{{steps.plan.rawOutput}}` with actual step output
- Replaces `{{steps.plan.output.fieldName}}` with structured output field
- Replaces `{{prompt}}` with the original dispatch prompt
- Replaces `{{runId}}` with the run ID
- Unknown references → empty string (with a warning, not an error)

### 6. Tests — `packages/core/src/__tests__/workflows/graph.test.ts`

- Load valid workflow YAML
- Load invalid workflow → descriptive error
- Build adjacency list from steps
- Topological sort: linear chain
- Topological sort: parallel steps
- Cycle detection: finds cycle
- Cycle detection: no false positives
- Validate: parallel writable steps → error
- Validate: missing agent reference → error
- Validate: orphan dependsOn → error
- Condition: "always" → true
- Condition: "never" → false
- Condition: "status(plan) == 'success'" with success → true
- Condition: "hasOutput(review)" with empty output → false
- Condition: "output(review).hasIssues == true" → works
- Condition: unknown syntax → throws
- Template: {{steps.plan.rawOutput}} resolved
- Template: {{prompt}} resolved
- Template: unknown reference → empty string

## Constraints

- ALL functions are pure (no I/O except the loader reading a YAML file)
- No SDK dependency
- No mocking needed for graph/condition/template tests

## Checkpoint

- All graph tests pass
- `loadWorkflow("feature.yml")` returns validated WorkflowDefinition
- `topologicalSort()` produces correct execution order
- Cycle detection works
- Parallel writable detection works
- Conditions evaluate correctly
- Templates resolve correctly
- `pnpm typecheck` passes
```

---

## Phase 9b — Persistence & Context

```markdown
# Task: Implement run persistence and workflow context (parallel with 9a)

Create the persistence layer for workflow runs and the context class that carries state between steps.

## Context

Read these documents before starting:
- `docs/plans/04-workflow-engine.md` — run persistence, context, run targeting, branch naming
- `docs/plans/03-data-model.md` — PersistedRun, StepResult, WorkflowContext
- `docs/ROADMAP.md` — Phase 9b tasks

## Requirements

### 1. Persistence — `packages/core/src/workflows/persistence.ts`

- `createRun(options: { workflow: string; repo: string; prompt: string; steps: string[]; metadata?: Record<string, unknown> }): PersistedRun`
  - Generates a unique runId (e.g. `run-<nanoid(10)>`)
  - Initializes all steps as `{ status: "pending", attempt: 0, costUsd: 0, durationMs: 0, agent: "" }`
  - Sets `version: 1`, `status: "running"`, timestamps
- `saveRun(run: PersistedRun, dir: string): Promise<void>` — write to `.neo/runs/<runId>.json`
- `loadRun(runId: string, dir: string): Promise<PersistedRun>` — read from file
- `listRuns(dir: string): Promise<PersistedRun[]>` — list all runs, sorted by updatedAt desc
- `updateStepResult(run: PersistedRun, stepName: string, result: Partial<StepResult>): PersistedRun` — immutable update

### 2. Workflow context — `packages/core/src/workflows/context.ts`

- `WorkflowContext` class:
  - `static fromDispatch(input: DispatchInput, workflowDef: WorkflowDefinition): WorkflowContext`
  - `static fromPersistedRun(run: PersistedRun): WorkflowContext`
  - `runId: string`
  - `workflow: string`
  - `repo: string`
  - `prompt: string`
  - `steps: Record<string, StepResult>`
  - `getStepOutput(stepName: string): unknown` — structured output
  - `getStepRawOutput(stepName: string): string`
  - `getStepStatus(stepName: string): StepResult["status"]`
  - `updateStep(stepName: string, result: Partial<StepResult>): void`
  - `toPersisted(): PersistedRun` — serialize for saving

### 3. Run targeting — `packages/core/src/workflows/context.ts` (same file)

- `computeTargets(run: PersistedRun, flags: TargetFlags, graph: AdjacencyList): Set<string>`
  ```typescript
  interface TargetFlags {
    step?: string;      // run only this step
    from?: string;      // run this step + all downstream
    retry?: string;     // reset and re-run this step only
  }
  ```
- Logic:
  - No flags → all steps are targeted
  - `--step plan` → only "plan" is targeted
  - `--from implement` → "implement" + all downstream steps
  - `--retry implement` → reset "implement" to pending, target only "implement"
- Validation: for targeted steps, all dependencies must be "success" or also targeted

### 4. Branch naming — `packages/core/src/workflows/branch.ts`

- `getBranchName(repoConfig: RepoConfig, runId: string): string`
  - Uses `branchPrefix` from repo config (default: "feat")
  - Format: `<prefix>/<runId>` (e.g. `feat/run-abc123`)
- `getWorkflowBranchPrefix(workflowName: string): string`
  - `feature` → `feat`
  - `hotfix` → `fix`
  - `refine` → `chore`
  - Other → `feat`

### 5. Dependencies

Add `nanoid` to `packages/core/package.json` for run ID generation.

### 6. Tests — `packages/core/src/__tests__/workflows/persistence.test.ts`

- Create run: generates valid runId, correct initial state
- Save + load round-trip: write → read → identical PersistedRun
- Update step result: immutable, only changes specified step
- List runs: returns sorted by updatedAt
- Targeting: no flags → all steps targeted
- Targeting: --step → only that step
- Targeting: --from → step + downstream
- Targeting: --retry → reset step, target only that
- Targeting: missing dependency → validation error
- Branch naming: feat prefix, fix prefix, chore prefix
- Context: fromDispatch creates correct context
- Context: fromPersistedRun restores context
- Context: getStepOutput/getRawOutput work

## Constraints

- No SDK dependency — filesystem only
- PersistedRun always has `version: 1` for future migration
- Run IDs are unique and URL-safe

## Checkpoint

- All persistence tests pass
- `createRun()` → `saveRun()` → `loadRun()` round-trips correctly
- `computeTargets()` handles all 4 modes (full, --step, --from, --retry)
- Branch naming follows convention
- `pnpm typecheck` passes
```

---

## Phase 9c — Workflow Executor

```markdown
# Task: Implement the main workflow execution loop

The executor combines the graph engine (9a) + persistence (9b) + runner (Phase 5) to execute full DAG workflows.

## Context

Read these documents before starting:
- `docs/plans/04-workflow-engine.md` — graph resolution algorithm (the 7-step algorithm)
- `docs/ROADMAP.md` — Phase 9c tasks
- Results from Phase 9a: `workflows/graph.ts`, `workflows/loader.ts`, `workflows/condition.ts`, `workflows/template.ts`, `workflows/validator.ts`
- Results from Phase 9b: `workflows/persistence.ts`, `workflows/context.ts`, `workflows/branch.ts`
- Phase 5 runner: `runner/session.ts`, `runner/recovery.ts`

## Requirements

### 1. Executor — `packages/core/src/workflows/executor.ts`

- `executeWorkflow(options: ExecutorOptions): Promise<TaskResult>`
  ```typescript
  interface ExecutorOptions {
    workflowDef: WorkflowDefinition;
    context: WorkflowContext;
    targetedSteps: Set<string>;
    graph: AdjacencyList;
    orchestrator: Orchestrator;   // for semaphore, runner, events, config
    runsDir: string;              // where to persist run state
  }
  ```

Main execution loop (from 04-workflow-engine.md algorithm):

```
1. Compute ready set: targeted steps with all dependencies met ("success" or not targeted)
2. For each ready step:
   a. If step is a gate → handle gate logic (delegate to Phase 9d)
   b. Evaluate condition → skip if false (mark as "skipped")
   c. Acquire semaphore slot
   d. Build prompt: resolve templates against context
   e. Execute via runWithRecovery():
      - Merge step-level recovery config with global
      - Pass worktree path, sandbox config, middleware hooks
   f. Parse output (if step has outputSchema)
   g. Store result in context
   h. Persist run state to .neo/runs/<runId>.json
   i. Release semaphore
   j. Emit workflow:step_complete event
3. Re-evaluate ready set → repeat
4. When all targeted steps are complete/skipped → return TaskResult
```

- Parallel execution: steps with no dependency between them execute concurrently (limited by semaphore)
- Per-step recovery config: merge `step.recovery` with global `config.recovery`
- On step failure (retries exhausted): mark as "failure", check if downstream steps can still proceed
- Persist run state after EVERY step completion (not just at the end)

### 2. Wire into Orchestrator — `packages/core/src/orchestrator.ts`

Update `dispatch()`:
- If the input specifies a workflow → load workflow definition
- Build graph, compute targets (based on --step/--from/--retry flags)
- Create or load context (--run-id loads existing)
- Create or reuse worktree and branch
- Execute via `executeWorkflow()`
- On completion: push branch if configured, optionally create PR

### 3. Tests — `packages/core/src/__tests__/workflows/executor.test.ts`

Mock the Agent SDK for all tests:
- Linear workflow: plan → implement → review (sequential)
- Parallel readonly: 4 reviewers run concurrently
- --step mode: only runs specified step, persists, returns
- --from mode: resumes from step, runs downstream
- --retry mode: re-runs failed step
- Condition: step skipped when condition is false
- Step failure: downstream steps are skipped
- Template resolution: prompt contains {{steps.plan.rawOutput}} → resolved correctly
- Persistence: run state saved after each step
- Per-step recovery: step with maxRetries=1 only retries once

## Constraints

- Gates are NOT implemented yet — if a gate is encountered, skip it (Phase 9d handles this)
- The executor must be resilient: any step failure should not crash the whole workflow

## Checkpoint

- All executor tests pass
- `executeWorkflow()` runs a linear DAG end-to-end (mocked SDK)
- Parallel readonly steps execute concurrently
- --step, --from, --retry all work correctly
- Run state persisted after each step
- `pnpm typecheck` passes
```

---

## Phase 9d — Gates & Built-in Workflows

```markdown
# Task: Implement approval gates and ship the 4 built-in workflows

Add gate logic (approve/reject/timeout) and create the built-in workflow YAML files.

## Context

Read these documents before starting:
- `docs/plans/04-workflow-engine.md` — gate concept, gate behavior (full-auto vs step-by-step), built-in workflows
- `docs/plans/08-supervisor-skills.md` — how gates are used from the CLI
- `docs/ROADMAP.md` — Phase 9d tasks

## Requirements

### 1. Gate logic — `packages/core/src/workflows/gate.ts`

- `handleGate(options: GateOptions): Promise<GateResult>`
  ```typescript
  interface GateOptions {
    runId: string;
    gateName: string;
    gateDef: WorkflowGateDef;
    context: WorkflowContext;
    emitter: NeoEventEmitter;
    runsDir: string;
  }

  type GateResult =
    | { status: "approved" }
    | { status: "rejected"; reason: string }
    | { status: "timeout" }
    | { status: "paused" };   // step-by-step mode
  ```

Two modes:

**Full-auto mode** (default when running `neo run feature` without --step):
1. Emit `gate:waiting` event with `approve()` / `reject()` callbacks
2. Wait for one of:
   - `approve()` called → return { status: "approved" }
   - `reject(reason)` called → return { status: "rejected", reason }
   - Timeout expires → return { status: "timeout" }
3. If `autoApprove: true` → immediately approve (for testing/CI)

**Step-by-step mode** (when the run was started with --step):
1. Persist run state with gate status: "waiting"
2. Return { status: "paused" }
3. The supervisor resumes later via `neo gate approve` or `neo run --from`

- `approveGate(runId: string, gateName: string, runsDir: string): Promise<void>` — update persisted run
- `rejectGate(runId: string, gateName: string, reason: string, runsDir: string): Promise<void>` — update persisted run, mark downstream as skipped

### 2. Wire gates into executor

Update `packages/core/src/workflows/executor.ts`:
- When the ready set includes a gate step → call `handleGate()`
- On approved → mark gate as "success", continue
- On rejected → mark gate as "failure", mark all downstream as "skipped"
- On timeout → same as rejected
- On paused → persist run state, return TaskResult with status "paused"

### 3. Built-in workflow YAMLs — `packages/agents/workflows/`

Create 4 workflow files:

**`feature.yml`:**
```yaml
name: feature
description: "Plan, approve, implement, review, fix"
steps:
  plan:
    agent: architect
    sandbox: readonly
  approve-plan:
    type: gate
    dependsOn: [plan]
    description: "Review the architecture plan before implementation"
    timeout: 30m
  implement:
    agent: developer
    dependsOn: [approve-plan]
  review:
    agent: reviewer-quality
    dependsOn: [implement]
    sandbox: readonly
  fix:
    agent: fixer
    dependsOn: [review]
    condition: "output(review).hasIssues == true"
```

**`review.yml`:**
```yaml
name: review
description: "Comprehensive 4-lens code review"
steps:
  quality:
    agent: reviewer-quality
    sandbox: readonly
  security:
    agent: reviewer-security
    sandbox: readonly
  perf:
    agent: reviewer-perf
    sandbox: readonly
  coverage:
    agent: reviewer-coverage
    sandbox: readonly
```

**`hotfix.yml`:**
```yaml
name: hotfix
description: "Fast-track implementation without architecture phase"
steps:
  implement:
    agent: developer
```

**`refine.yml`:**
```yaml
name: refine
description: "Evaluate and decompose tickets"
steps:
  evaluate:
    agent: refiner
    sandbox: readonly
    outputSchema:
      type: object
      properties:
        action:
          type: string
          enum: [pass_through, decompose, escalate]
        score:
          type: number
        reason:
          type: string
        subTickets:
          type: array
          optional: true
          items:
            type: object
            properties:
              title: { type: string }
              description: { type: string }
              files: { type: array, items: { type: string } }
              complexity: { type: number }
```

### 4. Tests — `packages/core/src/__tests__/workflows/gate.test.ts`

- Full-auto: approve → gate succeeds, workflow continues
- Full-auto: reject → gate fails, downstream skipped
- Full-auto: timeout → auto-reject
- Auto-approve: `autoApprove: true` → immediate approve
- Step-by-step: gate returns "paused", run state saved with gate "waiting"
- CLI approve: `approveGate()` updates persisted run
- CLI reject: `rejectGate()` updates run + marks downstream skipped
- Built-in workflows: load and validate all 4 (no cycle, no parallel writable, valid agents)
- Full feature workflow: plan → gate → implement → review → fix (mocked SDK)

## Checkpoint

- All gate tests pass
- Gates work in both full-auto and step-by-step modes
- All 4 built-in workflows load and validate without errors
- Feature workflow executes end-to-end (mocked SDK)
- `neo run feature --step plan` → persists → `neo gate approve` → `neo run --from implement` works
- `pnpm typecheck` passes
```

---

## Phase 10 — CLI

```markdown
# Task: Implement the CLI — the supervisor's interface

Build all CLI commands using native Node.js parseArgs. Every command supports `--output json`.

## Context

Read these documents before starting:
- `docs/plans/02-core-api.md` — CLI examples, workflow running
- `docs/plans/08-supervisor-skills.md` — all 7 skills to install
- `docs/plans/03-data-model.md` — DispatchInput flags
- `docs/ROADMAP.md` — Phase 10 tasks

## Requirements

### 1. Entry point — `packages/cli/src/index.ts`

- `#!/usr/bin/env node`
- Parse args with `node:util` `parseArgs()`
- Route to command handlers based on first positional arg
- Commands: `init`, `run`, `gate`, `runs`, `agents`, `workflows`, `status`, `kill`, `logs`, `cost`, `doctor`
- Global flags: `--output json`, `--help`, `--version`
- Unknown command → helpful error with list of available commands

### 2. Output formatter — `packages/cli/src/output.ts`

- `OutputFormatter` class:
  - `format(data: unknown, options: { json: boolean }): string`
  - Human mode: formatted tables, colors (via ANSI codes, no chalk dependency)
  - JSON mode: `JSON.stringify(data, null, 2)`
- Table helper for lists (agents, runs, workflows)
- Status colors: success=green, failure=red, running=yellow, pending=gray

### 3. Commands

**`neo init`** — `packages/cli/src/commands/init.ts`
- Interactive wizard (detect project type, ask model preference, budget)
- Generate `.neo/config.yml`
- Generate `.neo/workflows/feature.yml` (default workflow)
- Optionally generate `.neo/agents/developer.yml` (extended for detected stack)
- Install supervisor skills to `.claude/skills/neo/` (7 files from 08-supervisor-skills.md)
- Non-interactive: `neo init --model sonnet --budget 100 --no-interactive`
- `--upgrade-skills` flag: update skills without touching config

**`neo run`** — `packages/cli/src/commands/run.ts`
- `neo run <workflow> --repo <path> --prompt <text>`
- Flags: `--step`, `--from`, `--retry`, `--run-id`, `--meta`, `--output json`
- Loads config, creates Orchestrator, calls `dispatch()`
- Prints progress (events) in human mode, result in JSON mode

**`neo gate`** — `packages/cli/src/commands/gate.ts`
- `neo gate approve <runId> <gateName>`
- `neo gate reject <runId> <gateName> --reason <text>`
- Updates persisted run state

**`neo runs`** — `packages/cli/src/commands/runs.ts`
- `neo runs` — list all runs
- `neo runs <runId>` — detailed view
- `neo runs <runId> --step <step>` — step output
- Filters: `--status`, `--workflow`, `--filter key=value`
- `--set-meta '{"key": "value"}'` — update metadata on existing run

**`neo agents`** — `packages/cli/src/commands/agents.ts`
- Lists all resolved agents (built-in + extended + custom)
- Table: NAME, MODEL, SANDBOX, SOURCE

**`neo workflows`** — `packages/cli/src/commands/workflows.ts`
- Lists all available workflows (built-in + custom)
- Table: NAME, STEPS, DESCRIPTION

**`neo status`** — `packages/cli/src/commands/status.ts`
- Active sessions + queue depth + cost today

**`neo kill`** — `packages/cli/src/commands/kill.ts`
- `neo kill <sessionId>` — abort a running session

**`neo logs`** — `packages/cli/src/commands/logs.ts`
- `neo logs [sessionId|runId]` — stream events
- `--level error` filter

**`neo cost`** — `packages/cli/src/commands/cost.ts`
- `neo cost --today` / `neo cost --month`
- Table: date, workflow, agent, cost

**`neo doctor`** — `packages/cli/src/commands/doctor.ts`
- Check: Claude CLI installed and authenticated
- Check: git version ≥ 2.20
- Check: Node.js ≥ 22
- Check: `.neo/config.yml` valid
- Check: agent definitions valid
- Check: workflow definitions valid
- Print ✓/✗ for each check

### 4. Supervisor skills — `packages/cli/src/skills/`

Create 7 .md files from `docs/plans/08-supervisor-skills.md`:
- `neo-run.md`
- `neo-inspect.md`
- `neo-recover.md`
- `neo-agents.md`
- `neo-workflows.md`
- `neo-gate.md`
- `neo-troubleshoot.md`

Each with YAML frontmatter:
```yaml
---
name: neo-<name>
description: "<description>"
---
```

`neo init` copies these to `.claude/skills/neo/`.

### 5. Bin entry

`packages/cli/package.json`:
```json
"bin": {
  "neo": "./dist/index.js"
}
```

## Constraints

- No external CLI framework (no commander, no yargs) — use native `parseArgs`
- No chalk — use raw ANSI codes for colors (or a tiny helper)
- All commands support `--output json`
- Interactive prompts use `node:readline`

## Checkpoint

- `pnpm build && npx neo --help` shows all commands
- `neo doctor` runs all checks
- `neo agents` lists all 8 built-in agents
- `neo workflows` lists all 4 built-in workflows
- `neo init` generates valid `.neo/` directory + installs skills
- `neo run feature --step plan --repo . --prompt "test"` dispatches (mocked or real)
- `--output json` works on all commands
- `pnpm typecheck` passes
```

---

## Phase 11 — Metrics

```markdown
# Task: Implement metrics aggregation from cost/event journals

Build analytics API on top of the JSONL journals.

## Context

Read these documents before starting:
- `docs/plans/03-data-model.md` — MetricsSnapshot, AgentMetrics, CostEntry
- `docs/plans/02-core-api.md` — metrics API examples
- `docs/ROADMAP.md` — Phase 11 tasks

## Requirements

### 1. Metrics collector — `packages/core/src/metrics/collector.ts`

- `MetricsCollector` class:
  - `constructor(costJournal: CostJournal, eventJournal: EventJournal)`
  - `successRate(workflow?: string): Promise<number>` — last 24h
  - `avgCostUsd(workflow?: string): Promise<number>` — last 24h
  - `avgDurationMs(workflow?: string): Promise<number>` — last 24h
  - `retryRate(workflow?: string): Promise<number>` — last 24h
  - `totalRuns(workflow?: string): Promise<number>` — last 24h
  - `costToday(): Promise<number>`
  - `costByDay(options: { days: number }): Promise<DayCost[]>`
  - `costByWorkflow(options?: { days?: number }): Promise<WorkflowCost[]>`
  - `agentPerformance(agent: string): Promise<AgentMetrics>`
  - `snapshot(): Promise<MetricsSnapshot>`

### 2. Prometheus export — `packages/core/src/metrics/prometheus.ts`

- `toPrometheus(snapshot: MetricsSnapshot): string`
- Standard Prometheus text format:
  ```
  # HELP neo_active_sessions Number of active sessions
  # TYPE neo_active_sessions gauge
  neo_active_sessions 3
  # HELP neo_cost_today_usd Total cost today in USD
  # TYPE neo_cost_today_usd gauge
  neo_cost_today_usd 42.50
  ...
  ```

### 3. Wire into Orchestrator

- Add `metrics` getter to Orchestrator that returns a MetricsCollector instance
- `neo.metrics.successRate("feature")` works

### 4. Tests — `packages/core/src/__tests__/metrics.test.ts`

- Success rate calculation from sample data
- Average cost calculation
- Cost by day aggregation
- Agent performance metrics
- Prometheus export format
- Empty data returns sensible defaults (0 rate, 0 cost)

## Checkpoint

- All metrics tests pass
- `neo.metrics.successRate("feature")` returns correct data
- Prometheus export produces valid format
- `pnpm typecheck` passes
```

---

## Phase 12 — Polish & Publish

```markdown
# Task: Production-ready polish and npm publish preparation

Final quality pass: error messages, documentation, doctor refinements, publish config.

## Context

Read these documents before starting:
- `docs/ROADMAP.md` — Phase 12 tasks
- All packages in `packages/`

## Requirements

### 1. Error messages audit

Review ALL user-facing error messages across all packages:
- Config errors: actionable (show what's wrong + how to fix)
- Agent errors: show which agent, which field
- Workflow errors: show step name, what's invalid
- Runtime errors: include runId, sessionId for debugging
- CLI errors: show the correct command syntax

### 2. README.md

Quick start guide:
```
npm install -g @neo-cli/cli
cd my-project
neo init
neo run feature --prompt "Add user authentication"
```

Sections: Installation, Quick Start, Configuration, Agents, Workflows, CLI Reference, TypeScript API, Events, Middleware, Cost & Budget.

### 3. TSDoc on public exports

Add JSDoc/TSDoc to ALL exported types, classes, and functions in `@neo-cli/core`:
- One-line description
- @param descriptions
- @returns description
- @example for complex APIs

### 4. `neo doctor` refinements

- Suggest fixes for each failed check
- Check claude SDK version compatibility
- Check disk space in .neo/worktrees/
- Check for stale runs (running > 2h)

### 5. Publish configuration

For each package:
- `"publishConfig": { "access": "public" }`
- `"files"` field (only include dist/, README, LICENSE)
- `"repository"`, `"license"`, `"author"` fields
- Verify `"main"`, `"types"`, `"exports"` are correct

### 6. Verify end-to-end

```bash
npx @neo-cli/neo init
npx @neo-cli/neo doctor
npx @neo-cli/neo agents
npx @neo-cli/neo workflows
npx @neo-cli/neo run feature --prompt "Add auth" --step plan
```

## Checkpoint

- All tests pass: `pnpm test`
- Type check passes: `pnpm typecheck`
- Lint passes: `pnpm lint`
- README.md exists with quick start
- `neo doctor` gives actionable suggestions
- Package.json files are publish-ready
- `npx @neo-cli/neo --help` works from a clean install
```
