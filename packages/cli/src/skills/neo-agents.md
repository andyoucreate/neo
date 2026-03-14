---
name: neo-agents
description: "List and inspect neo agent configurations"
---

# neo agents — Agent Management

## List available agents

```bash
neo agents                    # all resolved agents (built-in + custom)
neo agents --output json      # machine-readable
```

## Built-in agents

| Agent | Role | Sandbox |
|-------|------|---------|
| `architect` | Plans implementation, produces task breakdown | readonly |
| `developer` | Implements code changes | writable |
| `reviewer-quality` | Code quality review | readonly |
| `reviewer-security` | Security audit | readonly |
| `reviewer-perf` | Performance review | readonly |
| `reviewer-coverage` | Test coverage review | readonly |
| `fixer` | Fixes issues found by reviewers | writable |
| `refiner` | Evaluates and decomposes tickets | readonly |

## Extending a built-in agent

Create `.neo/agents/<name>.yml`:

```yaml
# .neo/agents/developer.yml — tweak the built-in developer
extends: developer
model: sonnet               # cheaper model
maxTurns: 50                # more turns
tools:
  - $inherited              # keep all built-in tools
  - WebSearch               # add web search
promptAppend: |
  Always write tests for new functions.
  Use Prisma for database access.
```

## Creating a new agent

```yaml
# .neo/agents/e2e-tester.yml
name: e2e-tester
description: "Runs and fixes e2e tests"
model: sonnet
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: e2e-tester.md        # prompt file in same directory
```

## Key concepts

- `extends`: inherit from a built-in, override only what you need
- `$inherited`: in tools array, means "keep parent's tools + add mine"
- `promptAppend`: add text to the end of the inherited prompt (don't replace it)
- `sandbox`: `writable` = agent can modify files, `readonly` = read-only access
- Same name as built-in without `extends:` = implicit extend
