# @neotx/agents

Built-in agent definitions and workflow templates for `@neotx/core`.

This package contains YAML configuration files and Markdown prompts that define the 8 built-in agents and 4 workflows used by the Neo orchestrator. It's a data package — no TypeScript, no runtime code.

## Contents

```
packages/agents/
├── agents/           # Agent YAML definitions
│   ├── architect.yml
│   ├── developer.yml
│   ├── fixer.yml
│   ├── refiner.yml
│   ├── reviewer-coverage.yml
│   ├── reviewer-perf.yml
│   ├── reviewer-quality.yml
│   └── reviewer-security.yml
├── prompts/          # Markdown system prompts
│   └── *.md
└── workflows/        # Workflow YAML definitions
    ├── feature.yml
    ├── hotfix.yml
    ├── refine.yml
    └── review.yml
```

## Built-in Agents

| Agent | Model | Sandbox | Tools | Role |
|-------|-------|---------|-------|------|
| **architect** | opus | readonly | Read, Glob, Grep, WebSearch, WebFetch | Strategic planner. Analyzes features, designs architecture, decomposes work into atomic tasks. Never writes code. |
| **developer** | opus | writable | Read, Write, Edit, Bash, Glob, Grep | Implementation worker. Executes atomic tasks from specs in isolated worktrees. |
| **fixer** | opus | writable | Read, Write, Edit, Bash, Glob, Grep | Auto-correction agent. Fixes issues found by reviewers. Targets root causes, not symptoms. |
| **refiner** | opus | readonly | Read, Glob, Grep, WebSearch, WebFetch | Ticket quality evaluator. Assesses clarity and splits vague tickets into precise sub-tickets. |
| **reviewer-quality** | sonnet | readonly | Read, Glob, Grep, Bash | Code quality reviewer. Catches bugs and DRY violations. Approves by default. |
| **reviewer-security** | opus | readonly | Read, Glob, Grep, Bash | Security auditor. Flags directly exploitable vulnerabilities. Approves by default. |
| **reviewer-perf** | sonnet | readonly | Read, Glob, Grep, Bash | Performance reviewer. Flags N+1 queries and O(n²) on unbounded data. Approves by default. |
| **reviewer-coverage** | sonnet | readonly | Read, Glob, Grep, Bash | Test coverage reviewer. Recommends missing tests. Never blocks merge. |

### Sandbox Modes

- **readonly**: Agent can read files but cannot write. Safe for analysis tasks.
- **writable**: Agent can read and write files. Used for implementation and fixes.

### Model Selection

- **opus**: Used for complex reasoning (architecture, security, implementation)
- **sonnet**: Used for focused review tasks (quality, performance, coverage)

## Built-in Workflows

### feature

Full development cycle: plan, implement, review, and fix.

```yaml
steps:
  plan:
    agent: architect
    sandbox: readonly
  implement:
    agent: developer
    dependsOn: [plan]
  review:
    agent: reviewer-quality
    dependsOn: [implement]
    sandbox: readonly
  fix:
    agent: fixer
    dependsOn: [review]
    condition: "output(review).hasIssues == true"
```

### review

Parallel 4-lens code review. All reviewers run concurrently.

```yaml
steps:
  quality:
    agent: reviewer-quality
    sandbox: readonly
  security:
    agent: reviewer-security
    sandbox: readonly
  perf:
    agent: reviewer-perf
    sandbox: readonly
  coverage:
    agent: reviewer-coverage
    sandbox: readonly
```

### hotfix

Fast-track single-agent implementation. Skips planning for urgent fixes.

```yaml
steps:
  implement:
    agent: developer
```

### refine

Ticket evaluation and decomposition for backlog grooming.

```yaml
steps:
  evaluate:
    agent: refiner
    sandbox: readonly
```

## Creating Custom Agents

Custom agents are defined in `.neo/agents/` in your project. You can create entirely new agents or extend built-in ones.

### Agent YAML Schema

```yaml
name: my-agent                    # Required: unique identifier
description: "What this agent does"  # Required for custom agents
model: opus | sonnet | haiku      # Required for custom agents
tools:                            # Required for custom agents
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebSearch
  - WebFetch
sandbox: writable | readonly      # Required for custom agents
prompt: ../prompts/my-agent.md    # Path to system prompt (relative to YAML)
```

### Extending Built-in Agents

Use `extends` to inherit from a built-in agent and override specific fields:

```yaml
name: my-developer
extends: developer
model: sonnet                     # Override: use sonnet instead of opus
promptAppend: |
  ## Additional Instructions
  Always write tests before implementation.
```

When extending:
- Unspecified fields inherit from the base agent
- `prompt` replaces the base prompt entirely
- `promptAppend` appends to the inherited prompt

### The `$inherited` Token

When extending an agent, you can add tools while keeping the inherited ones:

```yaml
name: research-developer
extends: developer
tools:
  - $inherited      # Keep all tools from developer
  - WebSearch       # Add web search capability
  - WebFetch        # Add web fetch capability
```

Without `$inherited`, the tools list replaces the base entirely:

```yaml
name: minimal-developer
extends: developer
tools:
  - Read            # Only these tools, not the inherited ones
  - Edit
```

### Implicit Extension

If your custom agent has the same name as a built-in, it implicitly extends it:

```yaml
# .neo/agents/developer.yml
# No "extends:" needed — same name implies extends: developer
name: developer
model: sonnet                     # Override model
promptAppend: |
  Use the project's existing patterns.
```

## Prompts

Each agent has a corresponding Markdown prompt in `prompts/`. The prompt defines:

- The agent's role and responsibilities
- Workflow and execution protocol
- Output format expectations
- Hard rules and constraints
- Escalation conditions

### Prompt Structure

Prompts follow a consistent structure:

```markdown
# Agent Name — Voltaire Network

## Memory
This agent uses project-scoped memory.

## Isolation
(For writable agents) Works in isolated git worktrees.

## Skills
Recommended slash commands for the agent.

## Role
What this agent does and its constraints.

## Workflow
Step-by-step execution protocol.

## Output Format
Expected JSON structure for agent output.

## Error Handling
How to handle failures.

## Escalation
When to stop and report to the dispatcher.

## Hard Rules
Non-negotiable constraints.
```

### Referencing Prompts

In agent YAML, reference prompts with a relative path:

```yaml
prompt: ../prompts/architect.md
```

The path is resolved relative to the YAML file's directory.

## How @neotx/core Uses This Package

The `@neotx/core` orchestrator:

1. Loads all YAML files from `packages/agents/agents/` as built-in agents
2. Loads all YAML files from `.neo/agents/` as custom agents
3. Resolves extensions and merges configurations
4. Reads and injects prompts into agent sessions
5. Loads workflows from `packages/agents/workflows/` and `.neo/workflows/`

Custom agents in `.neo/agents/` override or extend the built-ins from this package.

## License

MIT
