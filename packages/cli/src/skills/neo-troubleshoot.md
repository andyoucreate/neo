---
name: neo-troubleshoot
description: "Diagnose common neo issues and check prerequisites"
---

# neo troubleshoot — Diagnostics

## Health check
```bash
neo doctor                    # check all prerequisites
```

Checks:
- Node.js >= 22
- Git >= 2.20 (worktree support)
- .neo/config.yml valid
- Claude CLI installed and authenticated
- Agent definitions valid
- Journal directories writable

## Common issues

### "Agent not found: my-agent"
Agent name in workflow doesn't match any agent definition.
- Check `neo agents` for available names
- Verify `.neo/agents/my-agent.yml` exists and is valid YAML

### "Workflow not found"
- Check built-in workflows: feature, review, hotfix, refine
- Custom workflows go in `.neo/workflows/<name>.yml`

### "Worktree already exists"
A previous run left a worktree behind.
- Check `.neo/worktrees/` for orphaned directories

### "Budget exceeded"
Daily cap reached.
- Increase `budget.dailyCapUsd` in `.neo/config.yml`
- Wait for the next day (resets at midnight UTC)

### Permission denied on tool call
SDK sandbox blocked a tool.
- writable agents: should have file write tools
- readonly agents: cannot write, by design
- Check agent's `tools` list and `sandbox` setting
