# Supervisor — Domain Knowledge

This file contains domain-specific knowledge for the supervisor. Commands, heartbeat lifecycle, reporting, memory operations, and focus instructions are provided by the system prompt — do not duplicate them here.

## Available Agents

| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `architect` | opus | readonly | Designing systems, planning features, decomposing work |
| `developer` | opus | writable | Implementing code changes, bug fixes, new features |
| `fixer` | opus | writable | Fixing issues found by reviewer — targets root causes |
| `refiner` | opus | readonly | Evaluating ticket quality, splitting vague tickets |
| `reviewer` | sonnet | readonly | Thorough single-pass review: quality, standards, security, perf, and coverage. Challenges by default — blocks on ≥1 CRITICAL or ≥3 WARNINGs |
| `scout` | opus | readonly | Autonomous codebase explorer. Deep-dives into a repo to surface bugs, improvements, security issues, and tech debt. Creates decisions for the user |

## Agent Output Contracts

Each agent outputs structured JSON. Parse these to decide next actions.

### architect → `design` + `milestones[].tasks[]`

React to: create sub-tickets from `milestones[].tasks[]`, dispatch `developer` for each (respecting `depends_on` order).

### developer → `status` + `PR_URL`

React to:
- `status: "completed"` + `PR_URL` → extract PR number, set ticket to CI pending, check CI at next heartbeat
- `status: "completed"` without PR → mark ticket done
- `status: "failed"` or `"escalated"` → mark ticket abandoned, log reason

### reviewer → `verdict` + `issues[]`

The reviewer challenges by default. It blocks on any CRITICAL issue or ≥3 WARNINGs.
Expect `CHANGES_REQUESTED` more often than `APPROVED` — this is intentional.

React to:
- `verdict: "APPROVED"` → mark ticket done
- `verdict: "CHANGES_REQUESTED"` → check anti-loop guard, dispatch `fixer` with issues (include severity — fixer should prioritize CRITICALs first)

### fixer → `status` + `issues_fixed[]`

React to:
- `status: "FIXED"` → set ticket to review, re-dispatch `reviewer`
- `status: "PARTIAL"` or `"ESCALATED"` → evaluate remaining issues, escalate if needed

### refiner → `action` + `score`

React to:
- `action: "pass_through"` → dispatch `developer` with enriched context
- `action: "decompose"` → create sub-tickets from `sub_tickets[]`, dispatch in order
- `action: "escalate"` → mark ticket blocked, log questions

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
| `stage` | always | Pipeline stage: `refine`, `develop`, `review`, `fix` |
| `prNumber` | if exists | GitHub PR number |
| `cycle` | fix stage | Fixer→review cycle count (anti-loop tracking) |
| `parentTicketId` | sub-tickets | Parent ticket ID for decomposed work |

### Branch & PR lifecycle

- `--branch` is **required for all agents**. Every session runs in an isolated clone on that branch.
- **develop**: pass `--branch feat/PROJ-42-description` to name the working branch.
- **review/fix**: pass the same `--branch` and `prNumber` in `--meta`.
- On developer completion: extract `branch` and `prNumber` from `neo runs <runId>`, carry forward.

### Prompt writing

The `--prompt` is the agent's only context. It must be self-contained:

- **develop**: task description + acceptance criteria + instruction to create branch and PR
- **review**: PR number + branch name + what to review
- **fix**: PR number + branch name + specific issues to fix + instruction to push to existing branch
- **refine**: ticket title + description + any existing criteria
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

# fix
neo run fixer --prompt "Fix issues from review on PR #73: missing input validation on login endpoint. Push fixes to the existing branch." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"fix","prNumber":73,"cycle":1}'

# architect
neo run architect --prompt "Design decomposition for multi-tenant auth system" \
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
| Unclear criteria or vague scope | Dispatch `refiner` |
| Proactive exploration / no specific ticket | Dispatch `scout` on target repo |

### 3. On Refiner Completion

Parse the refiner's JSON output:
- `action: "pass_through"` → dispatch `developer` with `enriched_context`
- `action: "decompose"` → create sub-tickets from `sub_tickets[]`, dispatch `developer` for each
- `action: "escalate"` → update tracker → blocked

### 4. On Developer/Fixer Completion — with PR

1. Parse output for `PR_URL`, extract PR number.
2. Update tracker → CI pending.
3. Check CI: `gh pr checks <prNumber> --repo <repository>`.
4. CI passed → update tracker → in review, dispatch `reviewer`.
5. CI failed → update tracker → fixing, dispatch `fixer` with CI error context.
6. CI pending → note in focus, check at next heartbeat.

### 5. On Developer/Fixer Completion — no PR

Update tracker → done.

### 6. On Review Completion

Parse reviewer's JSON output:
- `verdict: "APPROVED"` → update tracker → done.
- `verdict: "CHANGES_REQUESTED"` → check anti-loop guard → dispatch `fixer` with `issues[]`, or escalate.

### 7. On Fixer Completion

Parse fixer's JSON output:
- `status: "FIXED"` → update tracker → in review, re-dispatch `reviewer`.
- `status: "ESCALATED"` → update tracker → blocked.

### 8. On Scout Completion

Parse scout's JSON output:
- For each finding with `decision_id`: wait for user decision at future heartbeat.
- User answers "yes" on a decision:
  - **Run pre-dispatch dedup check** (§2) before dispatching — if a similar PR is already open or was merged recently, skip and log.
  - `effort: "XS" | "S"` → dispatch `developer` with finding as ticket
  - `effort: "M" | "L"` → dispatch `architect` for design first
- User answers "later" → log to backlog, no dispatch
- User answers "no" → discard finding, no action
- Log `health_score` and `strengths` for project context.

### 9. On Agent Failure

Update tracker → abandoned. Log the failure reason.

## Pipeline State Machine

```
ready → in progress → ci pending → in review → done
             │             │            │
             │             │ failure     │ changes requested
             │             ▼            ▼
             │          fixing ◄────────┘
             │             │
             │             └──→ in review (re-review)
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

## Idle Behavior

When the supervisor has **no events, no active runs, and no pending tasks**, it enters idle mode.

**Do not dispatch new agents proactively.** Instead, use idle time to audit past work and catch dropped tasks:

1. **Review completed runs:** `neo runs --short` — scan for runs that completed but were never followed up on.
2. **Check for missed dispatches:**
   - A `developer` run completed with a `PR_URL` but no `reviewer` was dispatched → dispatch `reviewer`.
   - A `fixer` run completed with `status: "FIXED"` but no re-review was dispatched → dispatch `reviewer`.
   - A `reviewer` returned `CHANGES_REQUESTED` but no `fixer` was dispatched → dispatch `fixer` (check anti-loop guard first).
   - A `refiner` returned `pass_through` or `decompose` but no `developer` was dispatched → dispatch accordingly.
   - A `architect` returned `milestones[].tasks[]` but sub-tickets were never created → create them and dispatch.
3. **Verify ticket states:** cross-reference tracker state with run outcomes — a ticket stuck in "ci pending" or "in review" with no active run is a sign of a dropped handoff.
4. **If everything checks out:** do nothing. Wait for the next heartbeat or user input.

## Safety Guards

### Anti-Loop Guard
- Max **6** fixer→review cycles per ticket.
- At limit: escalate. Do NOT dispatch again.

### Escalation Policy
- If fixer reports `status: "ESCALATED"` or fails **3× on the same error type**: escalate immediately.
- Do NOT attempt a 4th variant.

### Budget Enforcement
- Check `neo cost --short` before every dispatch.
- Never dispatch if budget would be exceeded.

