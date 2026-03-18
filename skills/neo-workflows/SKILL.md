---
name: neo-workflows
description: Guide for understanding and selecting neo workflows. Use when deciding which workflow to apply, understanding workflow states, or designing how work flows through the system from ticket to merge.
---

# Neo Workflows

Guide for understanding how work flows through the neo system. Covers the 4 standard workflows, when to use each, state transitions, and composition patterns.

## The 4 Standard Workflows

| Workflow | Steps | Use When |
|----------|-------|----------|
| **feature** | architect → developer → reviewer → fixer | New features, multi-file changes, anything needing design |
| **hotfix** | developer | Urgent single-file fixes, time-critical patches |
| **review** | reviewer | Standalone code review, PR validation |
| **refine** | refiner | Backlog grooming, ticket clarification, decomposition |

### feature

Full development cycle with planning, implementation, review, and fix loop.

```
plan (architect) → implement (developer) → review (reviewer) → fix (fixer)*
                                                    ↑______________|
                                                    * conditional: only if issues found
```

**Use when**:
- New feature implementation
- Multi-file changes (3+ files)
- Changes requiring architectural decisions
- Refactors affecting multiple modules

**Workflow YAML**:
```yaml
steps:
  plan:
    agent: architect
    sandbox: readonly
  implement:
    agent: developer
    dependsOn: [plan]
  review:
    agent: reviewer
    dependsOn: [implement]
    sandbox: readonly
  fix:
    agent: fixer
    dependsOn: [review]
    condition: "output(review).hasIssues == true"
```

### hotfix

Fast-track single-agent implementation. Skips planning for urgent fixes.

```
implement (developer)
```

**Use when**:
- Production incidents requiring immediate fix
- Single-file bug fixes with clear root cause
- Typo corrections, config changes
- Time-critical patches where review happens post-merge

**Workflow YAML**:
```yaml
steps:
  implement:
    agent: developer
```

**Warning**: Hotfix skips review. Use only when urgency outweighs review value. Consider following up with a `review` workflow post-merge.

### review

Standalone single-pass code review.

```
review (reviewer)
```

**Use when**:
- Reviewing existing PRs
- Post-merge audit of hotfixes
- External contribution review
- Security or compliance audit

**Workflow YAML**:
```yaml
steps:
  review:
    agent: reviewer
    sandbox: readonly
```

### refine

Ticket evaluation and decomposition for backlog grooming.

```
evaluate (refiner)
```

**Use when**:
- Ticket is vague or ambiguous
- Scope is unclear or too large
- Sprint planning requires estimation
- Backlog grooming sessions

**Workflow YAML**:
```yaml
steps:
  evaluate:
    agent: refiner
    sandbox: readonly
```

## Workflow Selection Guide

### By Ticket Characteristics

| Ticket Type | Complexity | Clarity | Recommended Workflow |
|-------------|------------|---------|----------------------|
| New feature | High | Clear | `feature` |
| New feature | High | Vague | `refine` → `feature` |
| Bug fix | Low | Clear | `hotfix` |
| Bug fix | High | Clear | `feature` |
| Bug fix | Any | Vague | `refine` → `hotfix` or `feature` |
| Refactor | High | Any | `feature` |
| Config change | Low | Clear | `hotfix` |
| External PR | Any | N/A | `review` |

### By Development Stage

| Stage | Workflow | Purpose |
|-------|----------|---------|
| Backlog grooming | `refine` | Clarify and decompose tickets |
| Sprint planning | `refine` | Estimate and validate scope |
| Implementation | `feature` or `hotfix` | Build the solution |
| Code review | `review` | Validate changes |
| Post-incident | `review` | Audit hotfix quality |

### Decision Tree

```
Is the ticket clear and actionable?
├── No → refine
└── Yes
    ├── Is it urgent (production incident)?
    │   ├── Yes → hotfix (follow up with review)
    │   └── No
    │       ├── Does it affect 3+ files or need design?
    │       │   ├── Yes → feature
    │       │   └── No → hotfix
    │       └── Is it a PR to review?
    │           └── Yes → review
```

## Workflow State Machine

Every workflow run transitions through these states:

```
┌─────────┐     ┌─────────────┐     ┌────────────┐     ┌────────┐     ┌──────┐
│  ready  │ ──► │ in_progress │ ──► │ ci_pending │ ──► │ review │ ──► │ done │
└─────────┘     └─────────────┘     └────────────┘     └────────┘     └──────┘
     │                │                   │                │              │
     │                ▼                   ▼                ▼              │
     │          ┌──────────┐        ┌──────────┐    ┌──────────┐         │
     │          │  failed  │        │  failed  │    │  blocked │         │
     │          └──────────┘        └──────────┘    └──────────┘         │
     │                │                   │                │              │
     └────────────────┴───────────────────┴────────────────┴──────────────┘
                                    (retry or escalate)
```

### State Definitions

| State | Description | Next States |
|-------|-------------|-------------|
| `ready` | Queued, waiting for agent availability | `in_progress` |
| `in_progress` | Agent is actively working | `ci_pending`, `failed` |
| `ci_pending` | Code committed, waiting for CI | `review`, `failed` |
| `review` | Reviewer evaluating changes | `done`, `blocked` |
| `blocked` | Review found issues, awaiting fixes | `in_progress` (fixer) |
| `done` | Workflow completed successfully | Terminal |
| `failed` | Unrecoverable error, needs intervention | `ready` (retry) |

### State Transitions by Workflow

**feature**:
```
ready → in_progress (architect)
      → in_progress (developer)
      → ci_pending
      → review (reviewer)
      → blocked (if issues) → in_progress (fixer) → ci_pending → review
      → done
```

**hotfix**:
```
ready → in_progress (developer) → ci_pending → done
```

**review**:
```
ready → in_progress (reviewer) → done | blocked
```

**refine**:
```
ready → in_progress (refiner) → done
```

## Workflow Composition

Workflows compose naturally. A complex feature often requires multiple workflow runs.

### Pattern: Refine → Feature

When a ticket is vague, refine first:

```bash
# Step 1: Clarify the ticket
neo run refiner --prompt "Evaluate: Add user search to dashboard" \
  --meta '{"ticketId":"PROJ-100","stage":"refine"}'

# Refiner outputs: 3 sub-tickets with clear acceptance criteria

# Step 2: Feature workflow for each sub-ticket
neo run architect --prompt "Design: T1 - Add search input component..." \
  --meta '{"ticketId":"PROJ-100-T1","parentTicketId":"PROJ-100","stage":"refine"}'
```

### Pattern: Feature → Review Loop

The fix step creates a review loop:

```
developer commits → reviewer evaluates → issues found?
                                              │
                         ┌────────────────────┴───────────────────┐
                         │ Yes                                    │ No
                         ▼                                        ▼
                    fixer commits → reviewer re-evaluates     merge
                         │                   │
                         └───────────────────┘
                         (max 6 cycles before escalation)
```

### Pattern: Hotfix → Review (Post-Merge)

For production incidents:

```bash
# Urgent: fix now
neo run developer --prompt "Fix null pointer in login..." \
  --meta '{"ticketId":"PROJ-URGENT","stage":"develop"}'

# After merge: audit quality
neo run reviewer --prompt "Review the hotfix commit abc123..." \
  --meta '{"ticketId":"PROJ-URGENT","stage":"review"}'
```

### Pattern: Architect Decomposition → Parallel Features

Large features decompose into independent sub-features:

```
architect outputs:
  M1: Authentication layer (T1, T2, T3)
  M2: Authorization layer (T4, T5) - depends on M1
  M3: Admin UI (T6, T7) - depends on M2

Execution:
  M1 tasks run sequentially (shared files)
  M2 waits for M1 completion
  M3 waits for M2 completion

Within each milestone, independent tasks can parallelize if budget allows.
```

## Anti-Patterns to Avoid

### 1. Skipping Review for Non-Urgent Work

**Wrong**:
```bash
# Feature implemented without review
neo run developer --prompt "Add payment processing"
# PR merged directly → bugs in production
```

**Right**:
```bash
neo run developer --prompt "Add payment processing"
neo run reviewer --prompt "Review PR #42"
# Issues found → fix before merge
```

### 2. Direct-to-Main

**Wrong**:
```bash
neo run developer --prompt "Fix login" --branch main
# Pushes directly to main → no review, no rollback point
```

**Right**:
```bash
neo run developer --prompt "Fix login" --branch fix/PROJ-99-login
# Creates PR → review → merge
```

### 3. Feature Workflow for Simple Fixes

**Wrong**:
```bash
neo run architect --prompt "Plan typo fix in README"
# Wasted budget on planning a 1-line change
```

**Right**:
```bash
neo run developer --prompt "Fix typo in README.md: 'teh' → 'the' on line 5"
```

### 4. Hotfix Without Follow-Up

**Wrong**:
```bash
# Production incident fixed
neo run developer --prompt "Emergency fix for crash"
# Never reviewed → technical debt accumulates
```

**Right**:
```bash
neo run developer --prompt "Emergency fix for crash"
# Later
neo run reviewer --prompt "Audit hotfix commit abc123"
# Creates follow-up ticket if issues found
```

### 5. Endless Fix Loops

**Wrong**:
```bash
# Cycle 7, 8, 9... still fixing
neo run fixer --prompt "Fix issues" --meta '{"cycle":9}'
```

**Right**:
```bash
# Cycle 6 reached → escalate to human
# Root cause is deeper than the fixer can address
```

The system enforces a max of 6 fix cycles. After that, escalate to a human.

### 6. Refining Clear Tickets

**Wrong**:
```bash
neo run refiner --prompt "Evaluate: Fix the typo in line 5 of README.md"
# Ticket is already crystal clear
```

**Right**:
```bash
neo run developer --prompt "Fix the typo in line 5 of README.md"
```

## Examples

### Example 1: New Feature (Full Cycle)

```bash
# 1. Architect plans the feature
neo run architect \
  --prompt "Design user invitation system. Admin invites by email, expires in 7 days, user sets password on first login." \
  --branch feat/PROJ-50-invitations \
  --meta '{"ticketId":"PROJ-50","stage":"refine"}'

# 2. Developer implements (per task from architect output)
neo run developer \
  --prompt "Implement invitation model and service per architect T1 spec." \
  --branch feat/PROJ-50-invitations \
  --meta '{"ticketId":"PROJ-50-T1","parentTicketId":"PROJ-50","stage":"develop"}'

# 3. Reviewer validates
neo run reviewer \
  --prompt "Review PR #73 on branch feat/PROJ-50-invitations" \
  --branch feat/PROJ-50-invitations \
  --meta '{"ticketId":"PROJ-50","stage":"review","prNumber":73}'

# 4. Fixer addresses issues (if any)
neo run fixer \
  --prompt "Fix: missing email validation, SQL injection in search" \
  --branch feat/PROJ-50-invitations \
  --meta '{"ticketId":"PROJ-50","stage":"fix","prNumber":73,"cycle":1}'
```

### Example 2: Vague Ticket (Refine First)

```bash
# Ticket: "Make the app faster"

# 1. Refine to understand scope
neo run refiner \
  --prompt "Evaluate: Make the app faster. What specific areas? What metrics?" \
  --branch feat/PROJ-100-performance \
  --meta '{"ticketId":"PROJ-100","stage":"refine"}'

# Refiner output: 3 sub-tickets
# - T1: Optimize database queries (slow user list)
# - T2: Add caching to API responses
# - T3: Lazy load dashboard widgets

# 2. Feature workflow for each sub-ticket
neo run developer \
  --prompt "Optimize getUserList query - add index, limit results" \
  --branch feat/PROJ-100-T1-db-optimize \
  --meta '{"ticketId":"PROJ-100-T1","parentTicketId":"PROJ-100","stage":"develop"}'
```

### Example 3: Production Incident (Hotfix)

```bash
# Incident: Login broken for all users

# 1. Immediate fix
neo run developer \
  --prompt "Fix: login returns 500. Root cause: null user object. Add null check in src/auth/login.ts:42" \
  --branch fix/PROJ-URGENT-login-500 \
  --priority critical \
  --meta '{"ticketId":"PROJ-URGENT","stage":"develop"}'

# 2. Merge immediately after CI passes

# 3. Post-incident review
neo run reviewer \
  --prompt "Audit hotfix commit abc123. Check for edge cases, test coverage, potential regression." \
  --branch main \
  --meta '{"ticketId":"PROJ-URGENT","stage":"review"}'
```

### Example 4: External PR Review

```bash
# Community contribution arrived

neo run reviewer \
  --prompt "Review PR #150 from external contributor. Check code quality, security, and alignment with project patterns." \
  --branch feat/external-dark-mode \
  --meta '{"ticketId":"EXTERNAL-150","stage":"review","prNumber":150}'
```

## Summary

| Workflow | When | Agents | Duration |
|----------|------|--------|----------|
| `feature` | New features, refactors, multi-file changes | architect → developer → reviewer → fixer | Hours |
| `hotfix` | Urgent fixes, simple changes | developer | Minutes |
| `review` | PR validation, audits | reviewer | Minutes |
| `refine` | Backlog grooming, unclear tickets | refiner | Minutes |

Choose the right workflow based on urgency, complexity, and clarity. When in doubt, start with `refine` to clarify scope before committing to implementation.
