---
name: neo-recover
description: Diagnose and recover from neo agent failures. Use when a run fails, an agent loops, budget is exceeded, or you need to understand what went wrong and how to fix it.
---

# Neo Recovery

Guide for diagnosing and recovering from agent failures.

## How Recovery Works

Neo uses a 3-level recovery strategy that escalates automatically:

| Level | Strategy | When |
|-------|----------|------|
| 1 | Normal execution | First attempt — create a new session |
| 2 | Resume session | Second attempt — preserve agent's context and partial work |
| 3 | Fresh session | Third attempt — abandon previous session, start clean |

Backoff between levels: 30s → 60s → 90s.

**Non-retryable errors** skip directly to failure:
- `error_max_turns` — agent hit its limit, retrying won't help
- `budget_exceeded` — no point retrying without more budget

## Diagnosis

Start with the failure details:

```bash
neo runs <run-id>                      # full run state
neo runs <run-id> --step <name>        # specific step output
neo logs <run-id>                      # full event log
neo logs <run-id> --step implement     # step-specific logs
```

## Common failures and fixes

### Agent looped (exceeded max turns)

The agent went in circles without producing output. The loop detection middleware caught repeated tool calls.

**Fix**: This error is **non-retryable** — the approach is wrong, not transient. Simplify the prompt, break the task into smaller pieces, or add explicit constraints:

```bash
neo run developer --prompt "ONLY modify src/auth/login.ts. Add rate limiting to the login endpoint. Do not refactor other files."
```

### Rate limited

Claude API returned 429 or overloaded errors.

**Fix**: Neo's 3-level recovery handles this automatically. If it still fails after all retries (3 attempts with increasing backoff), wait a few minutes and retry:

```bash
neo run feature --run-id <id> --retry implement
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

### Git clone conflict

Session clone already exists for this run.

**Fix**: Clean up orphaned session clones:

```bash
neo doctor
```

If `neo doctor` reports stale sessions, run `neo doctor --fix` to clean them up and retry.

### Agent produced invalid output

The step has an `outputSchema` and the agent's response didn't match the expected structure.

**Fix**: Retry — the agent may produce valid output on second attempt:

```bash
neo run feature --run-id <id> --retry plan
```

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
| Infrastructure (git, clone) | Run `neo doctor --fix`, clean up stale sessions if needed. |

## Prevention

- Keep prompts specific and scoped to 1-3 files
- Use `architect` to plan before dispatching large features
- Use `refiner` to validate ticket quality before implementation
- Monitor `neo cost --short` regularly to avoid budget surprises
- Use `--meta '{"ticket":"X-123"}'` to track which runs belong to which task

## Per-Step Recovery Configuration

Customize recovery per workflow step in your YAML:

```yaml
steps:
  plan:
    agent: architect
    recovery:
      maxRetries: 5       # readonly steps can retry more
  implement:
    agent: developer
    recovery:
      maxRetries: 2       # writable steps — fewer retries
      nonRetryable: [max_turns]
```

If omitted, global `recovery` config applies.

## Nuclear Option

If a run is completely stuck:

```bash
neo kill <session-id>                 # kill the active session
neo run feature --run-id <id> --retry implement  # then retry
```
