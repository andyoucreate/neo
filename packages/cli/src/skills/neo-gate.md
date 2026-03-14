---
name: neo-gate
description: "Approve or reject workflow approval gates"
---

# neo gate — Approval Gates

## Approve a gate
```bash
neo gate approve <run-id> <gate-name>
neo gate approve run-abc123 approve-plan
```

## Reject a gate
```bash
neo gate reject <run-id> <gate-name> --reason "Plan is too complex, simplify"
```

## Check waiting gates
```bash
neo runs --status paused
```

## Gate behavior

- **In full-auto mode**: gate emits an event, waits for approve()/reject()
- **In step-by-step mode**: run persists and exits. Resume with:
  ```bash
  neo gate approve <run-id> <gate-name>
  neo run <workflow> --run-id <run-id> --from <next-step>
  ```

## Tips

- Always inspect the upstream step's output before approving
- Gates have optional timeouts — if not approved in time, they auto-reject
- Use `autoApprove: true` in workflow YAML for CI/testing environments
