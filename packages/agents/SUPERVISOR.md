# Supervisor — Domain Knowledge

This file contains domain-specific knowledge for the supervisor. Commands, heartbeat lifecycle, reporting, memory operations, and focus instructions are provided by the system prompt — do not duplicate them here.

## Available Agents

| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `architect` | opus | readonly | Triage + design + plan + execution strategy. Spawns spec-reviewer subagents. Never writes code. |
| `developer` | opus | writable | Implements tasks, self-reviews, spawns spec/quality reviewer subagents, verifies before reporting. |
| `reviewer` | sonnet | readonly | Thorough single-pass review: quality, standards, security, perf, and coverage. Challenges by default — blocks on ≥1 CRITICAL or ≥3 WARNINGs |
| `scout` | opus | readonly | Autonomous codebase explorer. Deep-dives into a repo to surface bugs, improvements, security issues, and tech debt. Creates decisions for the user |

## Agent Output Contracts

Each agent outputs structured JSON. Parse these to decide next actions.

### architect → `design` + `milestones[].tasks[]`

React to: create sub-tickets from `milestones[].tasks[]`, dispatch `developer` for each (respecting `depends_on` order).

Parse `strategy` from output:
- `parallel_groups`: dispatch developer tasks in group order. Tasks within a group can run in parallel (verify no file overlap first).
- `model_hints`: use suggested model when dispatching each task (haiku/sonnet/opus).

### developer → `status` + `PR_URL`

React to:
- `status: "DONE"` + `PR_URL` → extract PR number, set ticket to CI pending, check CI at next heartbeat
- `status: "DONE"` without PR → mark ticket done
- `status: "DONE_WITH_CONCERNS"` → read concerns, evaluate impact. If concerns are architectural → create a decision or dispatch architect. If minor → mark done with note.
- `status: "BLOCKED"` → route via decision system. If autoDecide, answer directly. Otherwise wait for human.
- `status: "NEEDS_CONTEXT"` → provide the requested context and re-dispatch developer on same branch.

### reviewer → `verdict` + `issues[]`

The reviewer challenges by default. It blocks on any CRITICAL issue or ≥3 WARNINGs.
Expect `CHANGES_REQUESTED` more often than `APPROVED` — this is intentional.

Also check `spec_compliance` field. If `FAIL`, the code deviated from spec.

React to:
- `verdict: "APPROVED"` → mark ticket done
- `verdict: "CHANGES_REQUESTED"` → check anti-loop guard, re-dispatch `developer` with review feedback as context on same branch (include severity — developer should prioritize CRITICALs first)

### scout → `findings[]` + `decisions_created`

React to:
- Parse `findings[]` — each has `severity`, `category`, `suggestion`, and optional `decision_id`
- CRITICAL findings with `decision_id` → wait for user decision before acting
- HIGH findings with `decision_id` → wait for user decision before acting
- User answers "yes" on a decision → route the finding as a ticket (dispatch `developer` or `architect` based on `effort`)
- User answers "later" → backlog the finding
- User answers "no" → discard
- MEDIUM/LOW findings (no decisions created) → log for reference, no action needed

## Dispatch — `--meta` fields

Use `--meta` for traceability and idempotency:

| Field | Required | Description |
|-------|----------|-------------|
| `ticketId` | always | Source ticket identifier for traceability |
| `stage` | always | Pipeline stage: `develop`, `review` |
| `prNumber` | if exists | GitHub PR number |
| `parentTicketId` | sub-tickets | Parent ticket ID for decomposed work |

### Branch & PR lifecycle

- `--branch` is **required for all agents**. Every session runs in an isolated clone on that branch.
- **develop**: pass `--branch feat/PROJ-42-description` to name the working branch.
- **review**: pass the same `--branch` and `prNumber` in `--meta`.
- On developer completion: extract `branch` and `prNumber` from `neo runs <runId>`, carry forward.

### Prompt writing

The `--prompt` is the agent's only context. It must be self-contained:

- **develop**: task description + acceptance criteria + instruction to create branch and PR
- **review**: PR number + branch name + what to review
- **architect**: feature description + constraints + scope

### Examples

```bash
# develop
neo run developer --prompt "Implement user auth flow. Criteria: login with email/password, JWT tokens, refresh flow. Open a PR when done." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"develop"}'

# review
neo run reviewer --prompt "Review PR #73 on branch feat/PROJ-42-add-auth." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"review","prNumber":73}'

# architect (handles triage for vague tickets)
neo run architect --prompt "Triage and design: multi-tenant auth system. The ticket is vague — evaluate clarity, ask for clarifications if needed, then produce design + execution strategy." \
  --repo /path/to/repo \
  --branch feat/PROJ-99-multi-tenant-auth \
  --meta '{"ticketId":"PROJ-99","stage":"refine"}'

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
   d. Route the ticket.
   e. Update tracker → in progress.
   f. **Yield.** Completion arrives at a future heartbeat.

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
| Bug + critical priority | Dispatch `developer` directly (hotfix) |
| Clear criteria + small scope (< 5 points) | Dispatch `developer` |
| Complexity ≥ 5 | Dispatch `architect` first |
| Unclear criteria or vague scope | Dispatch `architect` (handles triage) |
| Proactive exploration / no specific ticket | Dispatch `scout` on target repo |

### 3. On Developer Completion — with PR

1. Parse output for `PR_URL`, extract PR number.
2. Handle by status:
   - `status: "DONE"` → update tracker → CI pending.
   - `status: "DONE_WITH_CONCERNS"` → read concerns, evaluate impact. If architectural → create a decision or dispatch architect. If minor → update tracker → CI pending, note concerns.
   - `status: "BLOCKED"` → route via decision system. If autoDecide, answer directly. Otherwise wait for human.
   - `status: "NEEDS_CONTEXT"` → provide the requested context and re-dispatch developer on same branch.
3. For CI pending tickets: check CI: `gh pr checks <prNumber> --repo <repository>`.
4. CI passed → update tracker → in review, dispatch `reviewer`.
5. CI failed → re-dispatch `developer` with CI error context on same branch.
6. CI pending → note in focus, check at next heartbeat.

### 4. On Developer Completion — no PR

- `status: "DONE"` → update tracker → done.
- `status: "DONE_WITH_CONCERNS"` → evaluate concerns, mark done with note if minor.
- `status: "BLOCKED"` → route via decision system.
- `status: "NEEDS_CONTEXT"` → provide context, re-dispatch developer.

### 5. On Review Completion

Parse reviewer's JSON output:
- `verdict: "APPROVED"` → update tracker → done.
- `verdict: "CHANGES_REQUESTED"` → check anti-loop guard → re-dispatch `developer` with review feedback as context on same branch, or escalate.

### 6. On Scout Completion

Parse scout's JSON output:
- For each finding with `decision_id`: wait for user decision at future heartbeat.
- User answers "yes" on a decision:
  - **Run pre-dispatch dedup check** (§2) before dispatching — if a similar PR is already open or was merged recently, skip and log.
  - `effort: "XS" | "S"` → dispatch `developer` with finding as ticket
  - `effort: "M" | "L"` → dispatch `architect` for design first
- User answers "later" → log to backlog, no dispatch
- User answers "no" → discard finding, no action
- Log `health_score` and `strengths` for project context.

### 7. On Agent Failure

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
```

## Self-Evaluation (Missing Ticket Fields)

Infer missing fields before routing:

**Type:**
- "crash", "error", "broken", "fix", "regression" → `bug`
- "add", "create", "implement", "build", "new" → `feature`
- "refactor", "clean", "improve", "optimize" → `chore`
- Unclear → `feature`

**Complexity (Fibonacci):**
- 1: typo, config, single-line — 2: single file, <50 lines — 3: 2-3 files (default)
- 5+: triggers architect first — 8: 5-8 files — 13: large feature — 21+: major

**Criteria** (when unset):
- Bugs: "The bug described in the title is fixed and does not regress"
- Features: derive from title
- Chores: "Code is cleaned up without breaking existing behavior"

**Priority** (when unset): `medium`

## Execution Strategy

When an architect produces a `strategy` with `parallel_groups` and `model_hints`:

1. **Verify parallel safety**: for each group, confirm tasks have zero file overlap and zero `depends_on` between them.
2. **Dispatch by group**: dispatch all tasks in group 1 first. Wait for all to complete. Then group 2, etc.
3. **Model selection**: use `model_hints` to select the agent model for each task dispatch.
4. **Post-group validation**: after ALL tasks in a group complete, run full test suite on the branch. If failures → dispatch developer to resolve before proceeding.

## Decision Routing

When a pending decision arrives from an agent:

1. **Can you answer directly?** (strategic question, scope, priority)
   → `neo decision answer <id> <answer>`

2. **Needs codebase investigation?** (technical question about existing code)
   → Dispatch `scout` to investigate (already readonly)
   → Read run output → `neo decision answer <id>` with findings

3. **Needs human input?** (`autoDecide: false`, or genuinely uncertain)
   → Log and wait for human response

IMPORTANT: An agent is BLOCKED waiting on this decision.
Answer within 1–2 heartbeats. Stale decisions waste agent session budget.

## Idle Behavior

When the supervisor has **no events, no active runs, and no pending tasks**, it enters idle mode.

**Do not dispatch new agents proactively.** Instead, use idle time to audit past work and catch dropped tasks:

1. **Review completed runs:** `neo runs --short` — scan for runs that completed but were never followed up on.
2. **Check for missed dispatches:**
   - A `developer` run completed with a `PR_URL` but no `reviewer` was dispatched → dispatch `reviewer`.
   - A `reviewer` returned `CHANGES_REQUESTED` but no `developer` was re-dispatched → re-dispatch `developer` with review feedback (check anti-loop guard first).
   - An `architect` returned `milestones[].tasks[]` but sub-tickets were never created → create them and dispatch.
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

### Budget Enforcement
- Check `neo cost --short` before every dispatch.
- Never dispatch if budget would be exceeded.
