---
name: neo-run
description: "Run neo workflows — dispatch, step, resume, retry"
---

# neo run — Workflow Execution

## Quick Start

```bash
# Run a full workflow
neo run feature --repo . --prompt "Add OAuth2 login with Google"

# Run a single step (plan only, then stop)
neo run feature --step plan --repo . --prompt "Add OAuth2 login"

# Resume from a specific step
neo run feature --run-id <id> --from implement

# Retry a failed step
neo run feature --run-id <id> --retry implement
```

## Flags

| Flag | Description |
|------|-------------|
| `--repo <path>` | Target repository (default: `.`) |
| `--prompt <text>` | Task description for the agent |
| `--step <name>` | Run only this step, then persist and exit |
| `--from <name>` | Resume: run this step + all downstream |
| `--retry <name>` | Re-run a failed step with the same prompt |
| `--run-id <id>` | Continue an existing run |
| `--meta <key>=<value>` | Attach metadata (repeatable) |
| `--output json` | Machine-readable output |

## Typical Flow

1. `neo run feature --step plan --prompt "..."` → get run-id
2. `neo runs <run-id> --step plan` → inspect the plan
3. `neo gate approve <run-id> approve-plan` → approve
4. `neo run feature --run-id <run-id> --from implement` → continue
5. `neo runs <run-id>` → check final status
