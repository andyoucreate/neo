---
name: neo-recover
description: Diagnose and recover from neo agent failures. Use when a run fails, an agent loops, budget is exceeded, or you need to understand what went wrong and how to fix it.
---

# Neo Recovery

Guide for diagnosing and recovering from agent failures.

## Diagnosis

Start with the failure details:

```bash
neo logs --type session:fail --last 5
neo runs --status failed --last 3
neo runs <runId>                       # full error context
```

## Common failures and fixes

### Agent looped (exceeded max turns)

The agent went in circles without producing output.

**Fix**: Simplify the prompt. Break the task into smaller pieces. Add explicit constraints:

```bash
neo run developer --prompt "ONLY modify src/auth/login.ts. Add rate limiting to the login endpoint. Do not refactor other files."
```

### Rate limited

Claude API returned 429 or overloaded errors.

**Fix**: Neo has built-in 3-level recovery (retry, resume session, fresh session with backoff). If it still fails after all retries, wait a few minutes and re-dispatch:

```bash
neo run developer --prompt "..." --priority low
```

### Budget exceeded

Daily budget cap reached.

**Fix**: Check current spend:

```bash
neo cost --short
```

Options:
- Wait until tomorrow (budget resets daily)
- Increase the budget in `.neo/config.yml` under `budget.dailyCapUsd`

### Git worktree conflict

Worktree already exists for this branch.

**Fix**: Clean up orphaned worktrees:

```bash
neo doctor
```

If `neo doctor` reports worktree issues, manually clean `.neo/worktrees/` and retry.

### Agent produced wrong output

The agent completed but the result isn't what was expected.

**Fix**: The prompt was likely too vague. Re-dispatch with:
- More specific file paths and function names
- Example of expected behavior
- Explicit "do not" constraints for things to avoid

```bash
neo run developer --prompt "In src/api/users.ts, the getUserById function (line ~45) should return 404 when the user is not found. Currently it returns null which causes a 500 in the handler. Add a proper NotFoundError throw. Do not change the handler, only the service function."
```

### Step timeout

Agent exceeded `maxDurationMs`.

**Fix**: The task is too large for a single agent session. Break it up:

```bash
neo run architect --prompt "Decompose this into 3-5 atomic tasks: <original prompt>"
```

Then dispatch each sub-task separately.

## Recovery strategies by severity

| Severity | Action |
|----------|--------|
| Transient (rate limit, timeout) | Neo auto-retries with 3-level recovery. Usually resolves itself. |
| Prompt issue (loop, wrong output) | Refine the prompt and re-dispatch. Be more specific. |
| Budget | Wait or increase cap. Check `neo cost` to understand spend. |
| Infrastructure (git, worktree) | Run `neo doctor`, clean up manually if needed. |

## Prevention

- Keep prompts specific and scoped to 1-3 files
- Use `architect` to plan before dispatching large features
- Use `refiner` to validate ticket quality before implementation
- Monitor `neo cost --short` regularly to avoid budget surprises
- Use `--meta '{"ticket":"X-123"}'` to track which runs belong to which task
