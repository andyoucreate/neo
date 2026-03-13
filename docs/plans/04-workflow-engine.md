# Neo — Workflow Engine (DAG)

The workflow engine is what makes neo more than a wrapper around the Agent SDK. It turns agent orchestration from "run one agent at a time" into "compose complex multi-agent pipelines with parallelism, conditions, and human checkpoints."

**Critical design principle:** The workflow is a **declarative flow definition**. The **supervisor** (user's script, human at CLI, or automation) drives execution by launching steps via `neo run`. Runs are **persisted** so the supervisor can step through a workflow across multiple CLI invocations.

## Concepts

### Steps

A step is a single agent execution. It has:
- An **agent** to run
- **Dependencies** (other steps or gates that must complete first)
- An optional **condition** (skip if not met)
- An optional **prompt override** (static template or dynamic function)
- An optional **output schema** (Zod, for structured parsing)

### Gates

A gate is a human approval checkpoint. It:
- Pauses the workflow and persists state
- In full-auto mode: emits a `gate:waiting` event, waits for `approve()` / `reject()`
- In step-by-step mode: the run stops at the gate. The supervisor inspects the output, then resumes with `neo gate approve <runId> <gateName>` or `--from <next-step>`
- Has an optional timeout (auto-reject after N minutes)
- Can be set to `autoApprove: true` for testing/CI

### Run Persistence

Every run is serialized to `.neo/runs/<runId>.json` after each step completes. This enables:
- **Step-by-step execution**: supervisor runs one step, inspects, decides what's next
- **Resume**: `neo run <workflow> --run-id <id> --from <step>`
- **Retry**: `neo run <workflow> --run-id <id> --retry <step>`
- **Inspection**: `neo runs <id>` shows full state, `neo runs <id> --step plan` shows step output
- **Cross-process**: the supervisor can be a bash script, a cron job, or a human at the terminal

### Context

The workflow context is persisted state that flows through all steps:
- Contains the results of every completed step
- Each step can reference prior steps' outputs in its prompt
- In YAML: `{{steps.plan.rawOutput}}` template syntax

### Conditions (YAML)

Steps can have a `condition` that determines whether to execute or skip them. In YAML, conditions are string expressions evaluated against the workflow context:

| Condition | Meaning |
|-----------|---------|
| `"hasOutput(review)"` | Step "review" produced non-empty output |
| `"status(review) == 'success'"` | Step "review" succeeded |
| `"output(review).hasIssues == true"` | Structured output field check |
| `"always"` | Always run (default) |
| `"never"` | Always skip (useful for debugging) |

```yaml
steps:
  fix:
    agent: fixer
    dependsOn: [review]
    condition: "output(review).hasIssues == true"
```

Conditions are evaluated as simple expressions — not arbitrary JavaScript. The available functions are:
- `status(stepName)` → `"success"` | `"failure"` | `"skipped"`
- `output(stepName)` → structured output object (if outputSchema was used)
- `hasOutput(stepName)` → boolean (did the step produce any output?)

### Graph Execution

The engine resolves the dependency graph and executes steps in topological order. Steps with no unmet dependencies run in parallel (limited by the semaphore).

```
plan ──→ approve-plan ──┬──→ dev-frontend ──┬──→ review ──→ fix (conditional)
                        └──→ dev-backend  ──┘
```

### Execution Modes

| Mode | How | Use case |
|------|-----|----------|
| **Full auto** | `neo run feature --repo . --prompt "..."` | Run all steps, stop only at gates |
| **Single step** | `neo run feature --step plan --repo . --prompt "..."` | Run one step, persist, exit |
| **Resume** | `neo run feature --run-id xxx --from implement` | Continue from a specific step |
| **Retry** | `neo run feature --run-id xxx --retry implement` | Re-run a failed step only |

## Graph Resolution Algorithm

```
0. Load or create run state:
   - If --run-id provided → load PersistedRun from .neo/runs/<runId>.json
   - If --step provided → mark only that step as target
   - If --from provided → mark that step + all downstream as targets
   - If --retry provided → reset that step to "pending", mark as sole target
   - Else → all steps are targets (full auto)

1. Build adjacency list from step.dependsOn
2. Detect cycles (throw if found)
3. Validate: for targeted steps, all dependencies must be "success" or targeted themselves

4. Find all TARGETED steps with zero unmet dependencies → "ready set"
5. For each ready step:
   a. Check condition → skip if false
   b. Acquire semaphore slot
   c. Create or reuse worktree (if writable agent)
   d. Build prompt (static template or context function)
   e. Execute via runner (with recovery)
   f. Parse output (if outputSchema)
   g. Store result in context
   h. **Persist run state to .neo/runs/<runId>.json**
   i. Release semaphore
   j. Emit workflow:step_complete event
   k. Re-evaluate ready set → repeat

6. When a gate is reached:
   - Full auto mode:
     a. Emit gate:waiting event
     b. Await approve/reject/timeout
     c. On approve → continue
     d. On reject/timeout → mark downstream as skipped
   - Step-by-step mode:
     a. Persist run state (gate status: "waiting")
     b. Exit. Supervisor will resume later.

7. When all targeted steps are complete or skipped:
   a. Persist final run state
   b. Return TaskResult
```

### Run State Lifecycle

```
neo run feature --step plan
  → creates run-abc123.json { status: "paused", steps: { plan: "success", ... rest: "pending" } }

neo runs run-abc123 --step plan
  → user inspects the plan output

neo gate approve run-abc123 approve-plan
  → updates run-abc123.json { steps: { approve-plan: "success" } }

neo run feature --run-id run-abc123 --from implement
  → loads context, runs implement → review → fix
  → updates run-abc123.json { status: "completed" }
```

## Worktree & Branch Strategy

**One worktree per run.** All steps in a workflow share the same worktree and branch. This eliminates merge complexity between parallel steps.

**Constraint:** Two writable steps cannot run in parallel in the same run. Parallel steps must be readonly (reviewers). This is enforced at workflow validation time.

### Branch naming

Each run creates a branch from the configured base branch:

```
feat/<runId>           # for feature workflows
fix/<runId>            # for hotfix workflows
chore/<runId>          # for refine/other workflows
```

### Branch configuration

The branch strategy is configured per-repo in `.neo/config.yml`:

```yaml
repos:
  - path: ./my-app
    defaultBranch: main           # where to branch from (default: main)
    branchPrefix: feat            # prefix for new branches (default: feat)
    pushRemote: origin            # remote to push to (default: origin)
    autoCreatePr: true            # auto-create PR after last writable step (default: false)
    prBaseBranch: develop         # PR target branch (default: same as defaultBranch)
```

### Branch lifecycle

```
1. Run starts → create branch feat/run-abc123 from main
2. Create worktree at .neo/worktrees/run-abc123/
3. All writable steps work in this worktree (sequentially)
4. Readonly steps (reviewers) read from the worktree — no separate checkout needed
5. On success → push branch, optionally create PR
6. On cleanup → remove worktree (branch stays for the PR)
```

### Git Mutex

Git is not thread-safe. Concurrent operations (fetch, worktree add, branch delete) on the same repository corrupt the index. Neo serializes all git operations per-repo using an in-memory mutex.

The mutex is acquired for:
- `git worktree add` / `git worktree remove`
- `git fetch`
- `git branch -D`
- `git push`

This is a hard-won lesson from the dispatch-service — without it, parallel sessions corrupt each other's git state.

### Merging

Neo **never** merges automatically. The supervisor or the human merges the PR. This is a deliberate constraint — merging is destructive and irréversible.

The workflow can include a gate at the end for merge approval:
```yaml
steps:
  # ... implement, review, fix ...
  merge-approval:
    type: gate
    dependsOn: [review]
    description: "Approve and merge the PR"
```

When approved, the supervisor runs `gh pr merge` or equivalent. Neo doesn't do it.

## Built-in Workflows

### `feature`
```
architect → [gate: approve-plan] → developer → reviewer-quality → [conditional: fixer]
```

### `review`
```
reviewer-quality ─┐
reviewer-security ─┤→ (all parallel, results merged)
reviewer-perf ─────┤
reviewer-coverage ─┘
```
Adaptive: <50 lines → 1 reviewer, 50-300 → 2, >300 → 4.

### `hotfix`
```
developer (fast-track, no architect)
```

### `refine`
```
refiner → structured output (pass_through | decompose | escalate)
```

## Implementation Roadmap

The workflow engine is built incrementally in 4 sub-phases (see `06-implementation-roadmap.md` Phase 9):

```
9a: Graph & Loader          9b: Persistence & Context
  (pure logic)                (filesystem I/O)
       │                            │
       └────────────┬───────────────┘
                    ▼
            9c: Executor
         (main execution loop)
                    │
                    ▼
          9d: Gates & Built-ins
         (approval + 4 workflows)
```

### Order and rationale

1. **9a first** — graph.ts and loader.ts are pure functions with zero dependencies. They're the foundation everything else builds on. Can be 100% unit-tested without mocking anything.

2. **9b in parallel with 9a** — persistence and context are also independent (filesystem only, no SDK). Run targeting (`--step`, `--from`, `--retry`) is implemented here as pure logic.

3. **9c after 9a + 9b** — the executor combines graph resolution + context + runner. This is where the workflow engine connects to the Orchestrator. Requires mocked SDK for testing.

4. **9d last** — gates add async control flow (approve/reject/timeout). Built-in workflows are YAML files that validate against the loader. Both depend on the executor working.

### Key files

| File | Phase | Responsibility |
|------|-------|---------------|
| `loader.ts` | 9a | Load + validate YAML workflows |
| `graph.ts` | 9a | DAG: adjacency, toposort, cycle detection |
| `validator.ts` | 9a | Constraint enforcement |
| `condition.ts` | 9a | Parse + evaluate condition expressions |
| `template.ts` | 9a | Resolve `{{steps.x.rawOutput}}` templates |
| `persistence.ts` | 9b | Read/write `.neo/runs/<runId>.json` |
| `context.ts` | 9b | WorkflowContext class |
| `branch.ts` | 9b | Branch naming from repo config |
| `executor.ts` | 9c | Main execution loop |
| `gate.ts` | 9d | Approval gates |

## Error Handling

- **Step failure with retries exhausted**: mark step as `failure`, emit event, check if downstream steps can still run
- **Gate timeout**: mark gate as `rejected`, skip all downstream
- **Workflow timeout**: kill all active sessions, mark as `timeout`
- **Budget exceeded**: pause orchestrator, reject new dispatches, let active sessions finish

## Cleanup Protocol

When a session ends (success, failure, timeout, or kill), the orchestrator must clean up in order:

1. **Release semaphore** — always, even on crash (use try/finally)
2. **Persist run state** — mark the step as failed/timed out
3. **Clear middleware state** — remove session from loop detection history
4. **Remove worktree** — only if no downstream steps need it (i.e., the run is terminal)
5. **Emit events** — session:fail or session:complete

If the process crashes without cleanup:
- On restart, scan `.neo/runs/` for runs with status "running" → mark as "failed"
- Scan `.neo/worktrees/` for orphaned directories → remove and prune
- The semaphore resets to zero (in-memory — no persistence needed)

### Worktree state on retry

When retrying a failed writable step:
- **Do not reset** the worktree. The agent may have made useful partial progress.
- The retry agent sees the current worktree state (including partial changes).
- If the user wants a clean retry, they can manually `git reset --hard` in the worktree before retrying.
