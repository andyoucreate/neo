# Plan 10 — Autonomous Sessions

> **Status**: Design
> **Depends on**: Phase 9 (Workflow Engine), Supervisor Daemon, Memory V2
> **Goal**: Enable neo to run time-bounded, objective-driven autonomous coding sessions

## Thesis

The supervisor today is **reactive** — it waits for events (webhooks, messages, run completions) and responds. An autonomous session makes it **proactive**: given a high-level objective and a time budget, the supervisor analyzes the codebase, generates its own backlog, dispatches agents, reviews results, and continuously feeds itself new work until the deadline.

This is the difference between "tell neo what to do" and "tell neo what you want, then go to sleep."

## Mental Model

```
┌─────────────────────────────────────────────────────┐
│                  Autonomous Session                  │
│                                                     │
│  Objective: "Optimize platform performance"         │
│  Deadline:  2026-03-17T00:00:00                     │
│  Repos:     [/path/to/platform]                     │
│                                                     │
│  ┌─────────┐    ┌──────────┐    ┌────────────────┐  │
│  │  PLAN   │───▶│ EXECUTE  │───▶│   EVALUATE     │  │
│  │         │    │          │    │                │  │
│  │ Analyze │    │ Dispatch │    │ Review results │  │
│  │ codebase│    │ agents   │    │ Pick next task │  │
│  │ Generate│    │ Monitor  │    │ Update backlog │  │
│  │ backlog │    │ runs     │    │ Re-prioritize  │  │
│  └─────────┘    └──────────┘    └───────┬────────┘  │
│       ▲                                 │           │
│       └─────────────────────────────────┘           │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │              TIME GUARD                      │    │
│  │  remainingMs < safetyMarginMs → WIND DOWN   │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Lifecycle

### Phase 1: PLANNING (first heartbeat)

The supervisor receives the session objective and enters planning mode:

1. **Codebase scan** — dispatches `architect` in readonly mode to analyze the target repo(s)
2. **Backlog generation** — architect returns a prioritized list of improvements
3. **Backlog persistence** — written to `notes/session-backlog.md` in supervisor dir
4. **Transition** — moves to EXECUTE phase

### Phase 2: EXECUTE (main loop)

Standard heartbeat loop, but with session-awareness injected into every prompt:

1. **Task selection** — picks highest-priority unstarted task from backlog
2. **Dispatch** — sends agent (developer, fixer, etc.) with task-specific prompt
3. **Monitor** — tracks active runs via existing event system
4. **On completion** — marks task done, evaluates result, picks next task
5. **Re-planning** — every N completions, re-evaluates backlog priorities

### Phase 3: WIND DOWN (approaching deadline)

When `remainingMs < safetyMarginMs` (default: 30 minutes before deadline):

1. **No new dispatches** — stops starting new work
2. **Wait for active** — lets running agents finish (with hard timeout)
3. **Summary generation** — produces a session report
4. **Clean exit** — writes summary to `notes/session-summary-<id>.md`, stops daemon

### Phase 4: STOPPED

Session complete. Summary available via `neo session report <id>`.

## Session Schema

```typescript
// Added to packages/core/src/supervisor/schemas.ts

const sessionPhaseSchema = z.enum([
  "planning",   // Initial codebase analysis
  "executing",  // Main autonomous loop
  "winding_down", // Approaching deadline, finishing active work
  "completed",  // Session finished normally
  "aborted",    // User stopped early
]);

const sessionTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]),
  runId: z.string().optional(),        // neo run ID when dispatched
  completedAt: z.string().optional(),
  result: z.string().optional(),       // brief outcome
  estimatedMinutes: z.number().optional(),
});

const autonomousSessionSchema = z.object({
  id: z.string(),
  objective: z.string(),
  repos: z.array(z.string()),          // target repo paths
  deadline: z.string(),                // ISO timestamp
  phase: sessionPhaseSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),

  // Backlog
  tasks: z.array(sessionTaskSchema),
  completedTaskCount: z.number().default(0),
  failedTaskCount: z.number().default(0),

  // Budget
  maxCostUsd: z.number().optional(),   // session-level budget cap
  spentUsd: z.number().default(0),

  // Time management
  safetyMarginMs: z.number().default(1_800_000), // 30 min
  replanAfterCompletions: z.number().default(5),  // re-evaluate backlog every N tasks

  // Constraints
  maxConcurrentRuns: z.number().default(1),  // start conservative
  allowedAgents: z.array(z.string()).optional(), // restrict which agents can be used
});
```

## Config Extension

```yaml
# ~/.neo/config.yml — new section
session:
  safetyMarginMs: 1800000     # 30 min before deadline = stop dispatching
  replanInterval: 5           # re-evaluate backlog every N completions
  maxConcurrentRuns: 1        # parallel agent runs per session
  summaryOnComplete: true     # auto-generate session report
```

## Prompt Augmentation

The session injects context into every heartbeat prompt. This is NOT a separate prompt — it augments the existing standard/consolidation prompts with session-awareness.

### Session Context Block (injected into `<context>`)

```
Session: "Optimize platform performance" [EXECUTING]
Deadline: 2026-03-17T00:00:00 (4h 32m remaining)
Progress: 7/23 tasks completed, 2 failed, 1 active
Budget: $12.40 / $50.00 spent (75% remaining)

Current backlog (top 5):
1. [in_progress] Optimize database queries in user-service (run abc123)
2. [pending] Add Redis caching layer for hot paths
3. [pending] Reduce bundle size — tree-shake unused lodash imports
4. [pending] Convert sync file reads to async in middleware
5. [pending] Add connection pooling configuration

Completed:
- ✓ Fix N+1 query in dashboard endpoint ($1.20)
- ✓ Add gzip compression middleware ($0.80)
- ✓ Remove unused dependencies from package.json ($0.40)
- ✗ Implement lazy loading for images (failed: test regression)
```

### Session Instructions Block (injected into `<instructions>`)

```
### Autonomous session rules
You are in an autonomous coding session. Your job is to continuously improve
the codebase toward the objective. After each task completes:
1. Evaluate the result (read run output via `neo runs <runId>`)
2. Mark the task done/failed in the session backlog
3. Pick the next highest-priority task and dispatch it
4. If a task fails, decide: retry with different approach, skip, or re-plan

Time management:
- Remaining: 4h 32m. Safety margin: 30m.
- Do NOT dispatch tasks estimated >2h when <3h remain.
- When <30m remain, enter wind-down: wait for active runs, then summarize.

Re-planning:
- After every 5 completions, re-evaluate the backlog.
- You may add new tasks discovered during execution.
- You may reprioritize based on what you've learned.
- You may skip tasks that are no longer relevant.

Quality:
- Each change must pass tests. Dispatch reviewer for non-trivial changes.
- Prefer small, focused changes over large refactors.
- If a change breaks tests, dispatch fixer before moving on.
```

## CLI Interface

```bash
# Start an autonomous session
neo session start \
  --objective "Optimize platform performance and reduce technical debt" \
  --until "00:00" \                    # deadline (parses relative/absolute)
  --repo /path/to/platform \          # target repo(s), repeatable
  --budget 50 \                       # max USD for this session
  --concurrent 2                      # max parallel runs

# Check session status
neo session status                     # current session progress

# Stop session early (graceful wind-down)
neo session stop                       # enters wind-down phase

# View session report
neo session report [sessionId]         # summary of completed session

# Send guidance to running session
neo session message "Focus on API endpoints, skip frontend for now"
```

### Time Parsing

The `--until` flag accepts:
- Absolute: `--until "2026-03-17T00:00:00"`, `--until "00:00"` (next midnight)
- Relative: `--until "4h"`, `--until "2h30m"`
- Natural: `--until "midnight"`, `--until "6am"`

## Implementation Plan

### T1: Session Schema + State (packages/core)

**Files:** `supervisor/schemas.ts`, `supervisor/session-state.ts`

- Add `AutonomousSession` schema to schemas.ts
- Create `SessionState` class: load/save/update session from `session.json`
- Add session config to `config.ts` (optional `session` section)

### T2: Session Prompt Builder (packages/core)

**Files:** `supervisor/prompt-builder.ts`

- Add `buildSessionContext()` — renders session progress, backlog, time remaining
- Add `buildSessionInstructions()` — session-specific rules
- Modify `buildStandardPrompt()` to inject session context when active
- Modify `buildConsolidationPrompt()` to include session awareness

### T3: Session Lifecycle in HeartbeatLoop (packages/core)

**Files:** `supervisor/heartbeat.ts`, `supervisor/daemon.ts`

- Load active session at heartbeat start
- Planning phase: first heartbeat dispatches architect for analysis
- Execute phase: inject session context, track task completion
- Wind-down: detect deadline approach, stop new dispatches
- Completion: generate summary, write report, stop daemon

Key change: **disable idle skip logic when session is active**. The supervisor must stay alert to pick up completed runs immediately.

### T4: CLI Commands (packages/cli)

**Files:** `commands/session.ts`

- `neo session start` — create session.json, start/restart daemon
- `neo session status` — read session state, format progress
- `neo session stop` — write abort signal, daemon enters wind-down
- `neo session report` — read session summary
- `neo session message` — inject message into supervisor inbox with session context

### T5: Session Planner Agent (packages/agents)

**Files:** `agents/planner.yml`

New agent definition:
```yaml
name: planner
description: "Analyze a codebase and generate a prioritized improvement backlog"
model: opus
sandbox: readonly
tools: [Read, Glob, Grep, Bash, WebSearch]
prompt: |
  You are a codebase analyst. Your job is to analyze a repository and produce
  a prioritized backlog of improvements aligned with the given objective.

  For each task, provide:
  - title: concise description
  - description: what to do and why
  - priority: critical/high/medium/low
  - estimatedMinutes: rough time estimate

  Output as JSON: { "tasks": [...] }

  Focus on:
  - Performance bottlenecks (slow queries, missing caching, N+1)
  - Code quality (dead code, duplication, missing types)
  - Security issues (input validation, auth gaps)
  - Developer experience (missing tests, unclear code)
  - Architecture improvements (modularity, separation of concerns)

  Constraints:
  - Each task must be independently implementable
  - No task should take more than 2 hours
  - Order by impact-to-effort ratio
  - Maximum 30 tasks per session
```

## Architectural Decisions

### ADR-030: Session is a supervisor overlay, not a new system

The session is a **state overlay** on the existing supervisor daemon. It does not replace the heartbeat loop — it augments it. When a session is active, the heartbeat prompt includes session context. When no session is active, the supervisor works normally.

**Why:** Reuses 100% of existing infrastructure (events, memory, runs, budget). No new daemon, no new loop, no architectural divergence.

### ADR-031: Conservative concurrency by default

Sessions default to `maxConcurrentRuns: 1` (sequential execution). Users can increase via `--concurrent`.

**Why:** Parallel changes to the same repo risk merge conflicts. Sequential is safer and easier to reason about. The user opts in to parallelism.

### ADR-032: Safety margin prevents orphaned work

The session enters wind-down `safetyMarginMs` before the deadline (default 30 minutes). No new work is dispatched. Active runs are given time to finish.

**Why:** An agent dispatched 5 minutes before deadline might produce a half-finished PR. The safety margin ensures all dispatched work has time to complete cleanly.

### ADR-033: Re-planning keeps the backlog relevant

Every `replanAfterCompletions` tasks (default 5), the supervisor re-evaluates the backlog. It may add new tasks discovered during execution, reprioritize based on what it learned, or skip tasks that are no longer relevant.

**Why:** A static backlog generated at session start becomes stale. The codebase changes as tasks complete. Re-planning keeps the session intelligent and adaptive.

### ADR-034: Planner is a separate agent, not supervisor logic

Backlog generation is delegated to a dedicated `planner` agent (readonly, architect-like). The supervisor does not analyze code itself.

**Why:** Separation of concerns. The supervisor orchestrates. The planner analyzes. The supervisor's SDK calls are short (15 turns max). Deep codebase analysis needs more turns and different tools.

## Example Flow

```
19:00  User: neo session start --objective "Optimize API performance" --until midnight --repo .
19:00  Session created. Daemon starts.
19:00  [PLANNING] Supervisor dispatches planner agent
19:02  Planner returns 18 tasks. Backlog saved.
19:02  [EXECUTING] Supervisor picks task #1: "Add database query indexes"
19:02  Dispatches developer agent → run abc123
19:08  Run abc123 completes. Developer created PR #45.
19:08  Supervisor dispatches reviewer → run def456
19:10  Reviewer approves. Task #1 done ($2.10).
19:10  Supervisor picks task #2: "Implement response caching"
19:10  Dispatches developer → run ghi789
19:18  Run ghi789 completes. PR #46 opened.
19:18  Reviewer dispatched. Changes requested.
19:20  Fixer dispatched. Fixes pushed. Re-review passes.
19:20  Task #2 done ($3.40). Picks task #3...
...
23:30  [WIND DOWN] 30 min to deadline. 14/18 tasks done.
23:30  Run xyz active — waiting for completion.
23:35  Last run completes. Task #15 done.
23:35  Session summary generated.
23:36  Daemon stops.

Summary: 15 tasks completed, 1 failed, 2 skipped.
         Total cost: $28.50. 8 PRs opened.
```

## Metrics

Track per session (written to session.json):
- `completedTaskCount` / `failedTaskCount` / `skippedTaskCount`
- `totalCostUsd`
- `totalDurationMs`
- `tasksPerHour` (velocity)
- `avgTaskCostUsd`
- `prCount` (PRs opened)
- `replanCount` (how many re-evaluations)

## Future Extensions (not in scope)

- **Multi-repo sessions**: session spans multiple repos with cross-repo awareness
- **Session templates**: predefined objectives ("security audit", "perf sweep", "test coverage")
- **Session history**: `neo session list` with trend analysis
- **Adaptive concurrency**: auto-increase parallelism when tasks are independent
- **Human-in-the-loop checkpoints**: pause session at milestones for review
