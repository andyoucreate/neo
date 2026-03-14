# Neo v0.1 — Minimal Shipping Path Prompts

Reduced prompt set for shipping a usable v0.1. Cuts the full roadmap (13 phases) down to 4 focused phases that build on top of the already-completed Phases 0–6 and the in-progress Phase 8.

**What v0.1 ships:** Single-agent dispatch with cost tracking, budget enforcement, JSONL journals, and a working CLI (`neo init`, `neo run`, `neo agents`, `neo doctor`).

**What v0.1 does NOT ship:** Multi-step DAG workflows, approval gates, conditions/templates, metrics aggregation, Prometheus export. These become v0.2.

---

## Ship-1 — Commit Phase 8 + Cost Journals

```markdown
# Task: Stabilize orchestrator and add JSONL cost/event journals

The orchestrator (orchestrator.ts, events.ts) is implemented but uncommitted.
Add lightweight JSONL persistence for costs and events, then commit everything.

## Context

Read these files before starting:
- `packages/core/src/orchestrator.ts` — current implementation (722 lines, in staging)
- `packages/core/src/events.ts` — NeoEventEmitter (in staging)
- `packages/core/src/__tests__/orchestrator.test.ts` — 36 tests (in staging)
- `packages/core/src/types.ts` — CostEntry, NeoEvent types

## Current state

- Orchestrator tracks `_costToday` in memory but does NOT persist costs to disk
- Events are emitted via NeoEventEmitter but not journaled
- 145 tests pass (`pnpm test`)
- Build and typecheck pass

## Requirements

### 1. Cost journal — `packages/core/src/cost/journal.ts`

- `CostJournal` class:
  - `constructor(options: { dir: string })`
  - `append(entry: CostEntry): Promise<void>` — append one JSON line to file
  - `getDayTotal(date?: Date): Promise<number>` — sum costUsd for the given day
  - File naming: `cost-<YYYY-MM>.jsonl` (monthly rotation)
  - Append-only — one `JSON.stringify(entry)` + `\n` per call
  - In-memory cache for daily total (invalidated on append)
- Keep it simple: no AsyncIterable, no readMonth — just append + getDayTotal

### 2. Event journal — `packages/core/src/events/journal.ts`

- `EventJournal` class:
  - `constructor(options: { dir: string })`
  - `append(event: NeoEvent): Promise<void>` — append one JSON line
  - File naming: `events-<YYYY-MM>.jsonl`
- No read API for v0.1 — write-only journal (read comes in v0.2 with metrics)

### 3. Wire journals into Orchestrator

Update `orchestrator.ts`:
- Accept optional `journalDir` in OrchestratorOptions (default: `.neo/journals/`)
- On `start()`: create CostJournal + EventJournal instances
- After each session: `costJournal.append(costEntry)`
- On every `this.emit(event)`: also `eventJournal.append(event)` (fire-and-forget, no await)
- On `start()`: load today's cost from journal via `getDayTotal()` to initialize `_costToday`
- On `shutdown()`: no special flush needed (append is already per-call)

### 4. Budget enforcement from journal

Update budget check in orchestrator:
- `_costToday` is initialized from `costJournal.getDayTotal()` on start
- Incremented in-memory on each session completion
- Budget alert threshold check stays as-is

### 5. Tests — `packages/core/src/__tests__/cost-journal.test.ts`

- Append + getDayTotal round-trip
- Monthly file rotation (entries in different months go to different files)
- Cache invalidation: append changes getDayTotal result
- Empty journal returns 0

### 6. Tests — `packages/core/src/__tests__/event-journal.test.ts`

- Append writes valid JSONL line
- Multiple appends produce multiple lines
- Monthly file rotation

## Constraints

- Journals are append-only — never read-modify-write
- Use `fs.appendFile` (not write streams) for simplicity and crash safety
- Create journal directory with `{ recursive: true }` on first append
- Do NOT add nanoid or other dependencies — use `crypto.randomUUID()` where needed
- Keep the existing 36 orchestrator tests passing

## Checkpoint

- `pnpm test` — all existing + new journal tests pass
- `pnpm typecheck` passes
- `pnpm build` passes
- Orchestrator persists cost entries to `.neo/journals/cost-YYYY-MM.jsonl`
- Orchestrator persists events to `.neo/journals/events-YYYY-MM.jsonl`
- Cost is restored from journal on `start()` — survives restart
```

---

## Ship-2 — CLI Foundation

```markdown
# Task: Implement the minimal CLI with 4 commands: init, run, agents, doctor

Build a thin CLI wrapper over @neo-cli/core. No external CLI framework.

## Context

Read these files before starting:
- `packages/cli/src/index.ts` — current stub ("coming soon")
- `packages/cli/package.json` — bin entry already configured
- `packages/core/src/index.ts` — all public exports
- `packages/agents/` — 8 built-in agent YAMLs + prompts
- `docs/plans/02-core-api.md` — CLI examples
- `docs/plans/08-supervisor-skills.md` — supervisor skill definitions

## Requirements

### 1. Entry point — `packages/cli/src/index.ts`

- `#!/usr/bin/env node`
- Parse args with `node:util` `parseArgs()`
- Route to command handlers based on first positional arg
- Commands: `init`, `run`, `agents`, `doctor`
- Global flags: `--output json`, `--help`, `--version`
- Unknown command → print available commands list + exit 1
- `--help` with no command → print usage summary

### 2. Output helper — `packages/cli/src/output.ts`

- `printJson(data: unknown): void` — JSON.stringify with 2-space indent
- `printTable(headers: string[], rows: string[][]): void` — simple column-aligned table
- `printSuccess(msg: string): void` — green prefix
- `printError(msg: string): void` — red prefix, writes to stderr
- Use raw ANSI codes — no chalk dependency
- Respect `NO_COLOR` env var (strip ANSI when set)

### 3. `neo init` — `packages/cli/src/commands/init.ts`

Non-interactive mode only for v0.1 (interactive wizard is v0.2):
- `neo init [--model sonnet] [--budget 500] [--force]`
- Creates `.neo/` directory structure:
  ```
  .neo/
  ├── config.yml          # Generated from defaults + flags
  ├── agents/             # Empty (for custom agents)
  ├── workflows/          # Empty (for custom workflows)
  ├── runs/               # Empty (populated at runtime)
  └── journals/           # Empty (populated at runtime)
  ```
- Generates `.neo/config.yml` with sensible defaults:
  ```yaml
  repos:
    - path: "."
      defaultBranch: main
  concurrency:
    maxSessions: 5
    maxPerRepo: 2
  budget:
    dailyCapUsd: 500
    alertThresholdPct: 80
  ```
- Installs supervisor skills to `.claude/skills/neo/` (7 .md files)
  - Read skill content from `docs/plans/08-supervisor-skills.md` and extract each skill
  - OR bundle them as static strings in `packages/cli/src/skills/`
- `--force` overwrites existing config
- Skip if `.neo/config.yml` already exists (unless --force)
- Print what was created

### 4. `neo run` — `packages/cli/src/commands/run.ts`

- `neo run <workflow> --repo <path> --prompt "<text>"`
- Optional flags: `--priority <level>`, `--meta '{"key":"value"}'`, `--output json`
- Flow:
  1. Load config from `.neo/config.yml` (or `--config <path>`)
  2. Create Orchestrator instance
  3. Call `orchestrator.start()`
  4. Call `orchestrator.dispatch({ workflow, repo, prompt, priority, metadata })`
  5. Subscribe to `"*"` events and print progress in human mode
  6. On completion: print TaskResult summary (or JSON if `--output json`)
  7. Call `orchestrator.shutdown()`
- Error handling: catch and print actionable error messages
- Human-mode progress: print `[step] agent: status` lines as events arrive
- JSON mode: suppress progress, print only final TaskResult

### 5. `neo agents` — `packages/cli/src/commands/agents.ts`

- `neo agents [--output json]`
- Load agent registry from built-in agents directory
- Print table: NAME | MODEL | SANDBOX | SOURCE
- JSON mode: print array of agent objects

### 6. `neo doctor` — `packages/cli/src/commands/doctor.ts`

- `neo doctor [--output json]`
- Run these checks, print ✓/✗ for each:
  1. Node.js version ≥ 22
  2. git installed and version ≥ 2.20
  3. `.neo/config.yml` exists and is valid (parse with Zod)
  4. Claude CLI installed (`claude --version` succeeds)
  5. Agent definitions valid (load and resolve all agents)
  6. Journal directories writable
- Exit 0 if all pass, exit 1 if any fail
- JSON mode: `{ checks: [{ name, status, message? }] }`

### 7. Supervisor skills — `packages/cli/src/skills/`

Create 7 markdown skill files. Each has YAML frontmatter:
```yaml
---
name: neo-<name>
description: "<one-line description>"
---
```

Skills to create (content from `docs/plans/08-supervisor-skills.md`):
- `neo-run.md` — Dispatch a workflow
- `neo-inspect.md` — Inspect run status and step outputs
- `neo-recover.md` — Resume or retry failed runs
- `neo-agents.md` — List and inspect agent configurations
- `neo-workflows.md` — List and inspect workflow definitions
- `neo-gate.md` — Approve or reject workflow gates
- `neo-troubleshoot.md` — Diagnose common issues

`neo init` copies these files to `.claude/skills/neo/`.

### 8. Package configuration

Update `packages/cli/package.json`:
- Add dependency on `@neo-cli/core: workspace:*`
- Add dependency on `yaml` (for config generation in init)
- Ensure `bin.neo` points to `./dist/index.js`
- Add build script using tsup (match core's config pattern)

### 9. CLI tsup config — `packages/cli/tsup.config.ts`

- Entry: `src/index.ts`
- Format: ESM
- Target: ES2022
- Bundle dependencies (except @neo-cli/core which is a workspace dep)
- Ensure shebang is preserved in output

## Constraints

- No external CLI framework (no commander, no yargs, no inquirer)
- No chalk — raw ANSI codes only
- CLI is a thin wrapper — zero business logic, all logic lives in @neo-cli/core
- All commands support `--output json`
- Use `process.exit(1)` on errors, `process.exit(0)` on success

## Checkpoint

- `pnpm build` succeeds (both core and cli)
- `pnpm --filter @neo-cli/cli exec neo --help` shows all 4 commands
- `neo doctor` runs all checks and prints results
- `neo agents` lists all 8 built-in agents
- `neo init` creates `.neo/` directory with valid config
- `neo run feature --repo . --prompt "test"` dispatches (SDK will fail without API key, but the orchestrator flow runs)
- `--output json` works on all commands
- `pnpm typecheck` passes
```

---

## Ship-3 — Built-in Workflows (single-step)

```markdown
# Task: Add built-in workflow YAML definitions and a workflow registry

Create the 4 built-in workflow definitions and a loader so `neo run feature` resolves to a workflow.
For v0.1, the orchestrator executes only the FIRST step of the workflow (single-agent dispatch).

## Context

Read these files before starting:
- `packages/core/src/orchestrator.ts` — current dispatch flow
- `packages/core/src/types.ts` — WorkflowDefinition, WorkflowStepDef, WorkflowGateDef
- `packages/agents/agents/` — 8 built-in agents
- `docs/plans/04-workflow-engine.md` — workflow definitions

## Requirements

### 1. Workflow loader — `packages/core/src/workflows/loader.ts`

- `loadWorkflow(filePath: string): Promise<WorkflowDefinition>` — load and validate YAML
- Zod schema for WorkflowDefinition:
  - `name`: string (required)
  - `description`: string (optional)
  - `steps`: Record<string, WorkflowStepDef | WorkflowGateDef> (required, min 1 step)
- Zod schema for WorkflowStepDef:
  - `type`: literal "step" (default)
  - `agent`: string (required)
  - `dependsOn`: string[] (optional)
  - `prompt`: string (optional — template, resolved at runtime)
  - `sandbox`: "writable" | "readonly" (optional)
  - `maxTurns`: number (optional)
  - `condition`: string (optional — ignored in v0.1)
- Zod schema for WorkflowGateDef:
  - `type`: literal "gate" (required)
  - `dependsOn`: string[] (optional)
  - `description`: string (required)
  - `timeout`: string (optional)
  - `autoApprove`: boolean (optional)
- Clear error on invalid YAML

### 2. Workflow registry — `packages/core/src/workflows/registry.ts`

- `WorkflowRegistry` class:
  - `constructor(builtInDir: string, customDir?: string)`
  - `async load(): Promise<void>` — load all .yml files from both directories
  - `get(name: string): WorkflowDefinition | undefined`
  - `list(): WorkflowDefinition[]`
  - `has(name: string): boolean`
- Built-in workflows come from `packages/agents/workflows/`
- Custom workflows come from `.neo/workflows/`
- Custom workflows with same name override built-in

### 3. Built-in workflow YAMLs — `packages/agents/workflows/`

Create 4 files:

**`feature.yml`:**
```yaml
name: feature
description: "Plan, implement, and review a feature"
steps:
  plan:
    agent: architect
    sandbox: readonly
  implement:
    agent: developer
    dependsOn: [plan]
    prompt: |
      Implement the following based on the architecture plan.

      Original request: {{prompt}}
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
description: "4-lens parallel code review"
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
description: "Fast-track single-agent implementation"
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
```

### 4. Wire into Orchestrator

Update `orchestrator.ts`:
- On `start()`: load WorkflowRegistry (built-in dir from config or default, custom dir from `.neo/workflows/`)
- In `dispatch()`: resolve workflow name → WorkflowDefinition from registry
- For v0.1: pick the FIRST step (the one with no `dependsOn`) and dispatch it as a single-agent session
  - If multiple root steps exist (like review.yml with 4 parallel steps), pick the first one alphabetically
  - Log a warning: "v0.1: executing only first step '{stepName}' of workflow '{workflowName}'"
- Use step-level `agent` to resolve from AgentRegistry
- Use step-level `sandbox` override if specified, else agent default
- Include workflow + step name in the persisted run

### 5. Export

Add to `packages/core/src/index.ts`:
```typescript
export { loadWorkflow } from "@/workflows/loader.js";
export { WorkflowRegistry } from "@/workflows/registry.js";
```

### 6. Tests — `packages/core/src/__tests__/workflows.test.ts`

- Load valid workflow YAML → correct WorkflowDefinition
- Load invalid YAML → descriptive error
- WorkflowRegistry: loads built-in workflows
- WorkflowRegistry: custom overrides built-in
- WorkflowRegistry: list(), get(), has()
- Orchestrator dispatch with workflow name resolves correctly
- Gate step type parsed but not executed (v0.1)
- Condition field parsed but not evaluated (v0.1)

## Constraints

- NO workflow execution engine yet — the orchestrator still runs single-agent dispatch
- NO template resolution — `{{prompt}}` in step prompts is stored as-is (resolved in v0.2)
- NO condition evaluation — conditions are parsed but ignored
- NO gate handling — gate steps are skipped with a warning
- Keep it simple: the goal is for `neo run feature` to know WHICH agent to run

## Checkpoint

- `pnpm test` — all existing + new workflow tests pass
- `pnpm typecheck` passes
- `neo agents` still works
- `neo run feature --repo . --prompt "test"` resolves workflow → picks architect agent → dispatches
- `neo run hotfix --repo . --prompt "test"` resolves workflow → picks developer agent → dispatches
- 4 built-in workflow files exist in `packages/agents/workflows/`
- WorkflowRegistry loads all 4 without errors
```

---

## Ship-4 — Polish & Release v0.1

```markdown
# Task: Final polish pass for v0.1 release

Error messages, package.json publish config, and a quick end-to-end smoke test.

## Context

Read all packages — `packages/core/`, `packages/cli/`, `packages/agents/`.

## Requirements

### 1. Error messages audit

Review all user-facing error messages and ensure they are:
- Actionable: tell the user what went wrong AND how to fix it
- Include context: runId, agent name, workflow name where available
- Consistent style: start with what failed, then why, then what to do

Focus areas:
- Config loading errors in `packages/core/src/config.ts`
- Agent resolution errors in `packages/core/src/agents/resolver.ts`
- Workflow loading errors in `packages/core/src/workflows/loader.ts`
- CLI command errors in `packages/cli/src/commands/`
- Dispatch validation errors in `packages/core/src/orchestrator.ts`

### 2. Package.json publish config

For `packages/core/package.json`:
- `"publishConfig": { "access": "public" }`
- `"files": ["dist", "README.md", "LICENSE"]`
- `"license": "MIT"`
- `"repository"` field
- Verify `"main"`, `"types"`, `"exports"` are correct for consumers

For `packages/cli/package.json`:
- Same publish fields
- Verify `"bin"` entry works after build
- `"files": ["dist", "README.md", "LICENSE"]`

For `packages/agents/package.json`:
- `"files": ["agents", "prompts", "workflows", "README.md", "LICENSE"]`
- No build step needed — this package ships raw YAML/MD

### 3. Root package.json

- `"version": "0.1.0"` across all 3 packages
- Ensure workspace scripts work: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`

### 4. LICENSE file

Create MIT LICENSE at root (or match existing license choice).

### 5. .npmignore or files field

Ensure these are NOT published:
- `src/` directories (only `dist/`)
- `__tests__/` directories
- `tsconfig*.json` build configs
- `*.test.ts` files

### 6. Smoke test script — `scripts/smoke-test.sh`

```bash
#!/bin/bash
set -e

echo "=== Neo v0.1 Smoke Test ==="

# Build
pnpm build

# Type check
pnpm typecheck

# Tests
pnpm test

# CLI commands
pnpm --filter @neo-cli/cli exec neo --help
pnpm --filter @neo-cli/cli exec neo --version
pnpm --filter @neo-cli/cli exec neo doctor --output json
pnpm --filter @neo-cli/cli exec neo agents --output json

# Init in temp dir
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
git init
npx --yes @neo-cli/cli init --budget 100
test -f .neo/config.yml
echo "✓ All smoke tests passed"
```

### 7. Version exports

Add to `packages/core/src/index.ts`:
```typescript
export const VERSION = "0.1.0";
```

Add to CLI `--version` handler: read version from core package.

## Constraints

- Do NOT create README.md files — that's a separate task
- Do NOT add features — this is polish only
- Keep changes minimal and focused

## Checkpoint

- `pnpm build && pnpm typecheck && pnpm test` — all green
- `bash scripts/smoke-test.sh` passes
- All 3 package.json files have consistent version "0.1.0"
- `"files"` field excludes source and test files
- Error messages are actionable (spot-check 5 error paths)
- CLI `--version` prints "0.1.0"
```

---

## Summary

| Phase | Name | Depends on | What it adds |
|-------|------|-----------|-------------|
| Ship-1 | Cost Journals | Current state | JSONL persistence, cost survives restart |
| Ship-2 | CLI Foundation | Ship-1 | `neo init`, `neo run`, `neo agents`, `neo doctor` |
| Ship-3 | Workflow Registry | Ship-2 | 4 built-in workflows, `neo run feature` resolves agent |
| Ship-4 | Polish & Release | Ship-3 | Error messages, publish config, smoke test |

**What ships in v0.1:**
- Single-agent dispatch with 3-level recovery
- Git worktree isolation
- Concurrency control (semaphore + per-repo limits)
- Middleware (loop detection, audit log, budget guard)
- JSONL cost + event journals
- 4 CLI commands
- 8 built-in agents, 4 workflow definitions
- Supervisor skills installed to `.claude/skills/neo/`

**What's deferred to v0.2:**
- Multi-step DAG workflow execution
- Approval gates
- Condition evaluation + template resolution
- Metrics aggregation + Prometheus export
- `neo gate`, `neo runs`, `neo logs`, `neo cost`, `neo status`, `neo kill` commands
- Interactive `neo init` wizard
