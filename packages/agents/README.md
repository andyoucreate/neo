# @neotx/agents

Built-in agent definitions for `@neotx/core`.

This package contains YAML configuration files and Markdown prompts that define the 4 built-in agents used by the Neo orchestrator. It's a data package — no TypeScript, no runtime code.

## Contents

```
packages/agents/
├── agents/           # Agent YAML definitions
│   ├── architect.yml
│   ├── developer.yml
│   └── reviewer.yml
└── prompts/          # Markdown system prompts
    ├── architect.md
    ├── developer.md
    └── reviewer.md
```

## Built-in Agents

| Agent | Model | Sandbox | Tools | Role |
|-------|-------|---------|-------|------|
| **architect** | opus | readonly | Read, Glob, Grep, WebSearch, WebFetch, Agent | Strategic planner. Triages requests, designs architecture, decomposes work into atomic tasks, and spawns subagents when needed. Never writes code. |
| **developer** | opus | writable | Read, Write, Edit, Bash, Glob, Grep, Agent | Implementation worker. Executes atomic tasks from specs in isolated clones. Performs self-review and spawns subagents for complex steps. |
| **reviewer** | sonnet | readonly | Read, Glob, Grep, Bash | Two-pass unified reviewer. Covers quality, security, performance, and test coverage. Challenges by default — blocks on critical issues. |

### Sandbox Modes

- **readonly**: Agent can read files but cannot write. Safe for analysis tasks.
- **writable**: Agent can read and write files. Used for implementation and fixes.

### Model Selection

- **opus**: Used for complex reasoning (architecture, security, implementation)
- **sonnet**: Used for focused review tasks (quality, performance, coverage)

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
- Execution protocol
- Output format expectations
- Hard rules and constraints
- Escalation conditions

### Prompt Structure

Prompts follow a consistent structure:

```markdown
# Agent Name

One-sentence role definition.

## Protocol
Step-by-step execution protocol.

## Output
Expected JSON structure for agent output.

## Escalation
When to stop and report to the dispatcher.

## Rules
Non-negotiable constraints.
```

Runtime metadata (hooks, skills, memory, isolation) are injected by `@neotx/core` — not written in the prompt.

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
Custom agents in `.neo/agents/` override or extend the built-ins from this package.

## License

MIT
