---
name: neo-dispatch
description: Guide for dispatching neo agents. Use when you need to understand how to run agents, which flags to use, how to structure prompts, and what meta fields to include for traceability.
---

# Neo Dispatch

Complete guide to dispatching agents with `neo run`. Covers syntax, flags, meta conventions, branch naming, and examples for each agent type.

## Syntax

```bash
neo run <agent> --prompt "..." [options]
```

The prompt is the agent's only context. Make it self-contained with all relevant details.

## Required and Optional Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--prompt` | **yes** | Task description — the agent's sole context |
| `--repo` | context | Path to the repository (required if not in a repo) |
| `--branch` | **yes** | Target branch for the agent's work |
| `--priority` | no | `critical`, `high`, `medium` (default), `low` |
| `--meta` | recommended | JSON object for traceability (see below) |

### The `--branch` flag

Every agent runs in an isolated git clone on the specified branch.

- **Writable agents** (developer, fixer): create or modify the branch
- **Readonly agents** (architect, reviewer, refiner): inspect without modifying

Always pass `--branch` explicitly — it ensures predictable clone behavior and traceability.

## Meta Field Conventions

Use `--meta` for traceability and idempotency. Pass a JSON object:

```bash
--meta '{"ticketId":"PROJ-42","stage":"develop"}'
```

| Field | When | Description |
|-------|------|-------------|
| `ticketId` | always | Source ticket identifier for traceability |
| `stage` | always | Pipeline stage: `refine`, `develop`, `review`, `fix` |
| `prNumber` | if exists | GitHub PR number (after PR is created) |
| `cycle` | fix stage | Fix→review cycle count (anti-loop tracking, max 6) |
| `parentTicketId` | sub-tickets | Parent ticket ID when working on decomposed tasks |

These fields flow through the pipeline and appear in logs, making it easy to trace agent runs back to their source tickets.

## Branch Naming Conventions

Use descriptive branch names that include the ticket ID:

```
feat/PROJ-42-add-user-auth
fix/PROJ-123-login-crash
chore/PROJ-99-cleanup-deps
```

Pattern: `{type}/{ticket-id}-{short-description}`

- `feat/` — new features
- `fix/` — bug fixes
- `chore/` — maintenance, refactoring, dependencies

## Prompt Writing Guidelines

The prompt must be **self-contained** — include everything the agent needs:

- **What** to do (task description)
- **Where** (file paths, function names if known)
- **Acceptance criteria** (how to know it's done)
- **Constraints** (what NOT to do)

A specific prompt saves retry cycles. Vague prompts lead to wrong output or loops.

## Agent Dispatch Examples

### Developer

Use for: implementing code changes, bug fixes, new features.

**Simple feature:**

```bash
neo run developer \
  --prompt "Add a logout button to the navbar. It should call /api/auth/logout and redirect to the login page. Create a PR when done." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-logout \
  --meta '{"ticketId":"PROJ-42","stage":"develop"}'
```

**Bug fix:**

```bash
neo run developer \
  --prompt "Fix the null pointer exception in src/services/user.ts line 87. The getUserById function returns null for non-existent users but the handler expects an object. Throw NotFoundError instead. Create a PR when done." \
  --repo /path/to/repo \
  --branch fix/PROJ-123-user-null-check \
  --meta '{"ticketId":"PROJ-123","stage":"develop"}'
```

**With constraints:**

```bash
neo run developer \
  --prompt "Implement rate limiting on the login endpoint. Use the existing redis client in src/lib/redis.ts. Limit to 5 attempts per minute per IP. Do NOT add new dependencies. Create a PR when done." \
  --repo /path/to/repo \
  --branch feat/PROJ-50-rate-limiting \
  --meta '{"ticketId":"PROJ-50","stage":"develop"}'
```

### Reviewer

Use for: reviewing PRs for quality, security, performance, and test coverage.

The reviewer challenges by default — expect `CHANGES_REQUESTED` more often than `APPROVED`. It blocks on ≥1 CRITICAL issue or ≥3 WARNINGs.

```bash
neo run reviewer \
  --prompt "Review PR #73 on branch feat/PROJ-42-add-auth. Focus on security and input validation." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"review","prNumber":73}'
```

**Review with specific concerns:**

```bash
neo run reviewer \
  --prompt "Review PR #89 on branch feat/PROJ-55-payments. Pay special attention to PCI compliance, SQL injection, and error handling for payment failures." \
  --repo /path/to/repo \
  --branch feat/PROJ-55-payments \
  --meta '{"ticketId":"PROJ-55","stage":"review","prNumber":89}'
```

### Fixer

Use for: fixing issues found by the reviewer.

Always include the specific issues to fix and the cycle count for anti-loop tracking.

```bash
neo run fixer \
  --prompt "Fix issues from review on PR #73: 1) Missing input validation on email field in login endpoint 2) SQL injection risk in user search query. Push fixes to the existing branch." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"fix","prNumber":73,"cycle":1}'
```

**Second fix cycle:**

```bash
neo run fixer \
  --prompt "Fix remaining issue from review on PR #73: The rate limiter still allows bypass via X-Forwarded-For header manipulation. Use the client IP from the trusted proxy chain. Push fixes to the existing branch." \
  --repo /path/to/repo \
  --branch feat/PROJ-42-add-auth \
  --meta '{"ticketId":"PROJ-42","stage":"fix","prNumber":73,"cycle":2}'
```

### Architect

Use for: designing systems, planning features, decomposing large work into atomic tasks.

```bash
neo run architect \
  --prompt "Design decomposition for multi-tenant authentication. Requirements: tenant isolation, SSO support, role-based access per tenant. Output a list of atomic implementation tasks with dependencies." \
  --repo /path/to/repo \
  --branch feat/PROJ-99-multi-tenant-auth \
  --meta '{"ticketId":"PROJ-99","stage":"refine"}'
```

**Complex feature planning:**

```bash
neo run architect \
  --prompt "Plan the implementation of real-time notifications. Consider: WebSocket vs SSE, message persistence, delivery guarantees, offline handling. Output milestones with tasks that can be assigned to individual developers." \
  --repo /path/to/repo \
  --branch feat/PROJ-200-notifications \
  --meta '{"ticketId":"PROJ-200","stage":"refine"}'
```

### Refiner

Use for: evaluating ticket quality, enriching vague tickets, or decomposing oversized tickets.

```bash
neo run refiner \
  --prompt "Evaluate ticket PROJ-150: 'Make the app faster'. Determine if this is actionable as-is, needs decomposition into specific performance tasks, or should be escalated for clarification." \
  --repo /path/to/repo \
  --branch feat/PROJ-150-performance \
  --meta '{"ticketId":"PROJ-150","stage":"refine"}'
```

**Enrich a vague ticket:**

```bash
neo run refiner \
  --prompt "Evaluate and enrich: 'Add search to the dashboard'. What kind of search? Which entities? Fuzzy matching? Filters? Provide enriched context or decompose into specific tasks." \
  --repo /path/to/repo \
  --branch feat/PROJ-175-search \
  --meta '{"ticketId":"PROJ-175","stage":"refine"}'
```

## Common Pitfalls

### 1. Missing `--branch`

❌ Without a branch, the agent works on an ambiguous state.

```bash
# Bad — no branch specified
neo run developer --prompt "Add logout button"
```

✅ Always specify the branch:

```bash
# Good
neo run developer --prompt "Add logout button" --branch feat/PROJ-42-logout
```

### 2. Vague prompts

❌ Vague prompts cause loops or wrong output:

```bash
# Bad — too vague
neo run developer --prompt "Fix the bug"
```

✅ Be specific — include file paths, line numbers, expected behavior:

```bash
# Good
neo run developer --prompt "Fix the null check in src/api/users.ts:87. getUserById should throw NotFoundError instead of returning null."
```

### 3. Missing PR number for review/fix

❌ Without the PR number, reviewer/fixer can't link their work:

```bash
# Bad — no prNumber
neo run reviewer --prompt "Review the auth changes" --meta '{"ticketId":"PROJ-42","stage":"review"}'
```

✅ Include `prNumber` when reviewing existing PRs:

```bash
# Good
neo run reviewer --prompt "Review PR #73" --meta '{"ticketId":"PROJ-42","stage":"review","prNumber":73}'
```

### 4. Forgetting cycle count for fixer

❌ Without cycle tracking, anti-loop guard can't protect you:

```bash
# Bad — no cycle
neo run fixer --prompt "Fix review issues" --meta '{"ticketId":"PROJ-42","stage":"fix","prNumber":73}'
```

✅ Track cycles (max 6 before escalation):

```bash
# Good
neo run fixer --prompt "Fix review issues" --meta '{"ticketId":"PROJ-42","stage":"fix","prNumber":73,"cycle":2}'
```

### 5. Dispatching architect for simple tasks

❌ Over-engineering simple work:

```bash
# Bad — architect for a typo fix
neo run architect --prompt "Plan how to fix the typo in README"
```

✅ Use the right agent for the job:

```bash
# Good — developer for simple changes
neo run developer --prompt "Fix typo in README.md: 'teh' → 'the' on line 15"
```

## Best Practices

1. **One task per dispatch** — keep prompts focused on a single outcome
2. **Include acceptance criteria** — how will the agent know it's done?
3. **Add constraints when needed** — "do NOT add dependencies", "do NOT modify tests"
4. **Use meta for traceability** — every run should link back to its source ticket
5. **Check capacity before dispatch** — run `neo runs --short` and `neo cost --short`
6. **Route appropriately** — refiner for vague tickets, architect for complex features, developer for clear tasks
