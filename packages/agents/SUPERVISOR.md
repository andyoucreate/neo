# Supervisor — Domain Knowledge

This file contains domain-specific knowledge for the supervisor. Commands, heartbeat lifecycle, reporting, memory operations, and focus instructions are provided by the system prompt — do not duplicate them here.

## Available Agents

| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `architect` | opus | writable | Triage + design + write implementation plan to `.neo/specs/`. Spawns plan-reviewer subagent. Writes code in plans, NEVER modifies source files. |
| `developer` | opus | writable | Executes implementation plans step by step (plan mode) OR direct tasks (direct mode). Spawns spec-reviewer and code-quality-reviewer subagents. |
| `reviewer` | sonnet | readonly | Thorough two-pass review: spec compliance first (gate), then code quality. Challenges by default — blocks on ≥1 CRITICAL or ≥5 WARNINGs. |
| `scout` | opus | readonly | Autonomous codebase explorer. Deep-dives into a repo to surface bugs, improvements, security issues, and tech debt. Creates decisions for CRITICAL/HIGH findings. Writes institutional memory. |

## Agent Output Contracts

Read agent output to decide next actions.

### architect → approval decision (gate) → `plan_path` + `summary`

The architect workflow is two-phase:

**Phase A — Design Gate:** Before writing any plan, the architect creates a blocking approval decision:
```bash
neo decision create "Design approval for {ticket-id}" --type approval --context "..." --wait --timeout 30m
```
The architect is **paused waiting for your response**. Answer within 1-2 heartbeats — every missed heartbeat burns 30 minutes of architect session budget.

React to:
- `approved` → architect writes plan, then report arrives
- `approved_with_changes` → architect revises design, re-submits (max 2 cycles)
- `rejected` → architect restarts design

**Phase B — Plan Ready:** After design is approved, architect reports:
- `plan_path` + `summary` → dispatch `developer` with `--prompt "Execute the implementation plan at {plan_path}. Create a PR when all tasks pass."` on the same branch.

The developer handles the full plan autonomously — no task-by-task dispatch from supervisor.

### developer → `status` + `branch_completion`

React to status:
- `status: "DONE"` + `PR_URL` → extract PR number, set ticket to CI pending, check CI at next heartbeat
- `status: "DONE"` without PR → mark ticket done
- `status: "DONE_WITH_CONCERNS"` → read concerns, evaluate impact. If architectural → create a decision or dispatch architect. If minor → mark done with note.
- `status: "BLOCKED"` → route via decision system. If you can answer directly (scope, priority, strategic question), do it. Otherwise wait for human.
- `status: "NEEDS_CONTEXT"` → provide the requested context and re-dispatch developer on same branch.

When `branch_completion` is present, supervisor decides:
- `recommendation: "pr"` + tests passing → create/push PR (most common)
- `recommendation: "keep"` → note in focus, revisit later
- `recommendation: "discard"` → requires supervisor confirmation before executing
- `recommendation: "push"` → push without PR (rare, for config/doc changes)

### reviewer → `verdict` + `issues[]`

The reviewer runs two passes: spec compliance first (fail = stop), then code quality. It challenges by default.

Blocks on:
- Any CRITICAL issue
- ≥5 WARNINGs
- `spec_compliance: "FAIL"` (always blocks, regardless of code quality)

React to:
- `verdict: "APPROVED"` → mark ticket done
- `verdict: "CHANGES_REQUESTED"` → check anti-loop guard, re-dispatch `developer` with review feedback as context on same branch (include severity — developer should prioritize CRITICALs first, then spec deviations)

### scout → `findings[]` + `decisions_created`

React to:
- Parse `findings[]` — each has `severity`, `category`, `suggestion`, `effort`, and optional `decision_id`
- CRITICAL/HIGH findings with `decision_id` → wait for user decision before acting
- User answers `"yes"` on a decision → **run pre-dispatch dedup check** (§2) then route as ticket
- User answers `"later"` → backlog the finding
- User answers `"no"` → discard
- MEDIUM/LOW findings (no decisions created) → log for reference, no action needed
- Log `health_score` and `strengths` for project context

## Dispatch — `--meta` fields

Use `--meta` for traceability and idempotency:

| Field | Required | Description |
|-------|----------|-------------|
| `ticketId` | always | Source ticket identifier for traceability |
| `stage` | always | Pipeline stage: `plan`, `develop`, `review` |
| `prNumber` | if exists | GitHub PR number |
| `parentTicketId` | sub-tickets | Parent ticket ID for decomposed work |

### Branch & PR lifecycle

- `--branch` is **required for all agents**. Every session runs in an isolated clone on that branch.
- **plan**: pass `--branch feat/PROJ-42-description` — architect commits the spec to this branch.
- **develop**: pass the same `--branch` as architect used.
- **review**: pass the same `--branch` and `prNumber` in `--meta`.
- On developer completion: extract `branch` and `prNumber` from `neo runs <runId>`, carry forward.

### Prompt writing

The `--prompt` is the agent's only context. It must be self-contained:

- **architect**: feature description + constraints + scope
- **developer**: task description + acceptance criteria + instruction to create branch and PR (or plan path for plan mode)
- **reviewer**: PR number + branch name + what to review

### Examples

```bash
# architect (design + plan)
neo run architect --prompt "Design and plan: multi-tenant auth system" \
  --repo /path/to/repo --branch feat/PROJ-99-auth \
  --meta '{"ticketId":"PROJ-99","stage":"plan"}'

# developer with plan (after architect completes)
neo run developer --prompt "Execute the implementation plan at .neo/specs/PROJ-99-plan.md. Create a PR when all tasks pass." \
  --repo /path/to/repo --branch feat/PROJ-99-auth \
  --meta '{"ticketId":"PROJ-99","stage":"develop"}'

# developer direct (small task, no architect needed)
neo run developer --prompt "Fix: POST /api/users returns 500 when email contains '+'. Open a PR." \
  --repo /path/to/repo --branch fix/PROJ-43-email \
  --meta '{"ticketId":"PROJ-43","stage":"develop"}'

# review
neo run reviewer --prompt "Review PR #73 on branch feat/PROJ-42-add-auth." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"review","prNumber":73}'

# scout
neo run scout --prompt "Explore this repository and surface bugs, improvements, security issues, and tech debt. Create decisions for critical and high-impact findings." \
  --repo /path/to/repo \
  --branch main \
  --meta '{"stage":"scout"}'
```

## Protocol

### 1. Ticket Pickup

1. Query your tracker for ready tickets, sorted by priority.
2. Check capacity: `neo runs --short` and `neo cost --short`.
3. For each ticket (up to capacity):
   a. Read full ticket details.
   b. Self-evaluate missing fields (see below).
   c. Resolve target repository.
   d. **Scope check**: if the ticket involves removal or deletion of code, confirm exact scope before dispatching. If ambiguous, create a decision: "Should I delete ONLY X, or also Y?"
   e. Route the ticket.
   f. Update tracker → in progress.
   g. **Yield.** Completion arrives at a future heartbeat.

### 2. Routing

**Pre-dispatch dedup check (MANDATORY before every `developer` dispatch):**

```bash
# 1. Check for open PRs on the same topic
gh pr list --repo <repo> --search "<2-3 keywords from finding>" --state open --json number,title
# → If a similar PR is OPEN: skip dispatch, add a comment on the existing PR instead

# 2. Check for recently merged fixes
gh pr list --repo <repo> --search "<2-3 keywords>" --state merged --limit 5 --json number,title,mergedAt
# → If a similar fix was merged in the past 7 days: skip dispatch, the issue is already resolved
```

Skip silently and log: `neo log discovery "Skipping <finding> — covered by PR #<N>"`.

| Condition | Action |
|-----------|--------|
| Bug + critical priority | Dispatch `developer` direct (hotfix) |
| Clear criteria + small scope (< 3 points) | Dispatch `developer` direct |
| Complexity ≥ 3 | Dispatch `architect` first → design gate → plan → dispatch `developer` with plan path |
| Unclear criteria or vague scope | Dispatch `architect` (handles triage via decision poll) |
| Deletion / large removal | Create scope decision first, then dispatch `developer` direct |
| Proactive exploration / no specific ticket | Dispatch `scout` on target repo |

### 3. On Architect Design Gate

When architect creates an approval decision (`--type approval --wait`):

1. Read the decision context immediately — the architect is paused waiting.
2. Evaluate: does the proposed design match the ticket's intent? Are the components and scope reasonable?
3. **Can you approve directly?** (most common — if the approach is reasonable and in scope)
   → `neo decision answer <id> approved`
4. **Need changes?** → `neo decision answer <id> "approved_with_changes: <specific changes needed>"`
5. **Fundamentally wrong approach?** → `neo decision answer <id> rejected` + explain what direction to take instead.

Do NOT dispatch follow-up agents until the architect reports `plan_path`.

### 4. On Developer Completion — with PR

1. Parse output for `PR_URL`, extract PR number.
2. Handle by status:
   - `status: "DONE"` → update tracker → CI pending.
   - `status: "DONE_WITH_CONCERNS"` → read concerns, evaluate impact. If architectural → create a decision or dispatch architect. If minor → update tracker → CI pending, note concerns.
   - `status: "BLOCKED"` → route via decision system.
   - `status: "NEEDS_CONTEXT"` → provide context, re-dispatch developer on same branch.
3. For CI pending tickets: check CI: `gh pr checks <prNumber> --repo <repository>`.
4. CI passed → update tracker → in review, dispatch `reviewer`.
5. CI failed → re-dispatch `developer` with CI error context on same branch.
6. CI pending → note in focus, check at next heartbeat.

### 5. On Developer Completion — no PR

- `status: "DONE"` → update tracker → done.
- `status: "DONE_WITH_CONCERNS"` → evaluate concerns, mark done with note if minor.
- `status: "BLOCKED"` → route via decision system.
- `status: "NEEDS_CONTEXT"` → provide context, re-dispatch developer.

### 6. On Review Completion

Parse reviewer's JSON output:
- `verdict: "APPROVED"` → update tracker → done.
- `verdict: "CHANGES_REQUESTED"` → check anti-loop guard → re-dispatch `developer` with review feedback as context on same branch (include spec deviations + CRITICAL issues + WARNING count), or escalate.

### 7. On Scout Completion

Parse scout's JSON output:
- For each finding with `decision_id`: wait for user decision at future heartbeat.
- User answers `"yes"` on a decision:
  - **Run pre-dispatch dedup check** (§2) before dispatching.
  - `effort: "XS" | "S"` → dispatch `developer` with finding as ticket
  - `effort: "M" | "L"` → dispatch `architect` for design first
- User answers `"later"` → log to backlog, no dispatch
- User answers `"no"` → discard finding, no action
- Log `health_score` and `strengths` for project context.

### 8. On Agent Failure

Update tracker → abandoned. Log the failure reason.

## Pipeline State Machine

```
ready → in progress → ci pending → in review → done
             │             │            │
             │             │ failure     │ changes requested
             │             ▼            ▼
             │       developer ◄────────┘
             │       re-dispatch
             │
             └──→ blocked (escalation/budget/anti-loop)
             └──→ abandoned (terminal failure)

architect path:
ready → design gate (--wait decision) → plan written → in progress → ...
```

## Self-Evaluation (Missing Ticket Fields)

Infer missing fields before routing:

**Type:**
- "crash", "error", "broken", "fix", "regression" → `bug`
- "add", "create", "implement", "build", "new" → `feature`
- "refactor", "clean", "improve", "optimize" → `chore`
- "remove", "delete", "cleanup" → `chore` (requires scope confirmation — see §1d)
- Unclear → `feature`

**Complexity (Fibonacci):**
- 1: typo, config, single-line — 2: single file, <50 lines — 3: 2-3 files (default)
- 3+: triggers architect first — 5: 3-5 files — 8: 5-8 files — 13: large feature — 21+: major

**Criteria** (when unset):
- Bugs: "The bug described in the title is fixed and does not regress"
- Features: derive from title
- Chores: "Code is cleaned up without breaking existing behavior"
- Deletions: "ONLY the named subsystem is removed. Nothing adjacent is deleted."

**Priority** (when unset): `medium`

## Execution Strategy

When an architect completes:

1. Read `plan_path` from architect output.
2. Dispatch `developer` with the plan path on the same branch. The developer handles task ordering autonomously.
3. Post-completion: check CI, dispatch `reviewer` after CI passes.
4. Anti-loop guard: max 6 re-dispatch cycles per ticket.

## Decision Routing

When a pending decision arrives from an agent:

1. **Can you answer directly?** (strategic question, scope, priority, design approval)
   → `neo decision answer <id> <answer>`

2. **Needs codebase investigation?** (technical question about existing code)
   → Dispatch `scout` to investigate (already readonly)
   → Read run output → `neo decision answer <id>` with findings

3. **Needs human input?** (`autoDecide: false`, or genuinely uncertain)
   → Log and wait for human response

IMPORTANT: An agent may be BLOCKED waiting on this decision (especially architect with `--wait`).
Answer within 1-2 heartbeats. Stale decisions waste agent session budget.

## Memory Usage

Use `neo memory write` to capture stable facts that would change how future agents approach work on this repo.

Write memories when:
- A scout or developer reveals a non-obvious constraint not in docs (e.g., "build must pass locally before push — CI runs compiled output only")
- A developer or reviewer hits the same issue twice (→ write a `procedure` memory with the fix)
- A user provides feedback that affects future dispatches (→ write a `feedback` memory with scope)
- A design decision locks in a pattern that future architects should know (→ write a `fact` memory)

```bash
neo memory write --type fact --scope <repo-path> "<stable truth>"
neo memory write --type procedure --scope <repo-path> "<step-by-step how-to>"
neo memory write --type feedback --scope <repo-path> "<recurring complaint or preference>"
neo memory write --type focus --expires 2h "<current working context>"
```

Do NOT memorize: file paths, general best practices, obvious conventions, anything in README or package.json.

## Idle Behavior

When the supervisor has **no events, no active runs, and no pending tasks**, it enters idle mode.

**Do not dispatch new agents proactively.** Instead, use idle time to audit past work and catch dropped tasks:

1. **Review completed runs:** `neo runs --short` — scan for runs that completed but were never followed up on.
2. **Check for missed dispatches:**
   - A `developer` run completed with a `PR_URL` but no `reviewer` was dispatched → dispatch `reviewer`.
   - A `reviewer` returned `CHANGES_REQUESTED` but no `developer` was re-dispatched → re-dispatch `developer` with review feedback (check anti-loop guard first).
   - An `architect` returned a `plan_path` but no `developer` was dispatched with it → dispatch `developer` with the plan path.
   - Pending decisions not yet answered → check `neo decision list` and route appropriately.
3. **Verify ticket states:** cross-reference tracker state with run outcomes — a ticket stuck in "ci pending" or "in review" with no active run is a sign of a dropped handoff.
4. **If everything checks out:** do nothing. Wait for the next heartbeat or user input.

## Safety Guards

### Anti-Loop Guard
- Max **6** developer re-dispatch cycles per ticket.
- At limit: escalate. Do NOT dispatch again.

### Escalation Policy
- If developer reports `status: "BLOCKED"` or fails **3× on the same error type**: escalate immediately.
- Do NOT attempt a 4th variant.

### Scope Guard
- For deletion or large removal tasks: always confirm exact scope before dispatch.
- "Remove X" means ONLY X — never adjacent systems unless explicitly stated.
- When in doubt: create a decision with boundary options before dispatching.

### Budget Enforcement
- Check `neo cost --short` before every dispatch.
- Never dispatch if budget would be exceeded.
