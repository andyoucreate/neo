---
name: neo-inspect
description: "Inspect neo run status and step outputs"
---

# neo inspect — Run Inspection

## List all runs

```bash
neo runs
neo runs --status paused          # filter by status
neo runs --workflow feature       # filter by workflow
neo runs --filter ticket=NEO-42   # filter by metadata
```

## Inspect a specific run

```bash
neo runs <run-id>                 # full run state
neo runs <run-id> --step plan     # step output only
neo runs <run-id> --output json   # machine-readable
```

## Run states

| Status | Meaning |
|--------|---------|
| `running` | Steps are actively executing |
| `paused` | Stopped at a gate or after --step |
| `completed` | All steps finished successfully |
| `failed` | A step failed and retries exhausted |

## Step states

| Status | Meaning |
|--------|---------|
| `pending` | Not yet executed |
| `running` | Currently executing |
| `success` | Completed successfully |
| `failure` | Failed (check error output) |
| `skipped` | Skipped (condition not met or upstream rejected) |
| `waiting` | Gate waiting for approval |

## Reading step output

The step output depends on the agent:
- **architect**: structured plan with tasks array
- **developer**: raw text (commit summary, files changed)
- **reviewer-***: findings with severity and suggestions
- **fixer**: raw text (what was fixed)

If the step has an `outputSchema`, the output is parsed and validated JSON.
