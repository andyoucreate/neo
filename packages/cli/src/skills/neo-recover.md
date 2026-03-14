---
name: neo-recover
description: "Resume or retry failed neo runs"
---

# neo recover — Recovery Strategies

## Diagnosis

```bash
# Check what failed
neo runs <run-id>
neo logs <run-id>                     # full event log
neo logs <run-id> --step implement    # step-specific logs
```

## Common failures and fixes

### Agent looped (repeated same command)
The loop detection middleware caught a repeated tool call.
- **Fix**: Retry with a more specific prompt
  `neo run feature --run-id <id> --retry implement`

### Rate limited
Claude API rate limit hit. The recovery system retried but exhausted attempts.
- **Fix**: Wait a few minutes, then retry
  `neo run feature --run-id <id> --retry implement`

### Budget exceeded
Daily budget cap reached.
- **Fix**: Wait for the next day, or increase the budget in .neo/config.yml
  ```yaml
  budget:
    dailyCapUsd: 200   # was 100
  ```

### Agent produced invalid output
The step has an outputSchema and the agent's response didn't match.
- **Fix**: Retry (the agent may produce valid output on second attempt)
  `neo run feature --run-id <id> --retry plan`

### Git conflict in worktree
The worktree branch diverged from the base branch.
- **Fix**: Clean up and retry
  `neo run feature --run-id <id> --retry implement`

### Step timed out
Agent exceeded maxDuration.
- **Fix**: Retry the step (consider adjusting maxTurns or narrowing the prompt)
  `neo run feature --run-id <id> --retry implement`

## Nuclear option

If a run is completely stuck:
```bash
neo kill <session-id>                 # kill the active session
# Then retry the stuck step
```
