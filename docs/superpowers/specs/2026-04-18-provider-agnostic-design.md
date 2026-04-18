# Provider-Agnostic Agent Architecture

**Date:** 2026-04-18
**Status:** Draft
**Goal:** Decouple neo from Anthropic-specific concepts so any CLI-based AI provider can run agents with zero YAML changes.

---

## 1. Problem Statement

Neo agents are tightly coupled to Claude Code:

- Agent YAML declares Claude-specific tools (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Agent`, etc.)
- Model enum is Anthropic-only (`opus | sonnet | haiku`)
- Subagents depend on Claude's native `Agent` tool
- Sandbox config filters Claude tool names (`WRITE_TOOLS`)
- `AIProvider` is a closed enum (`"claude" | "codex"`)
- `claudeCodePath` sits at config top level

The Codex adapter already proves these abstractions are unnecessary — it ignores `allowedTools` entirely and just passes `--sandbox` to the CLI.

## 2. Design Principles

1. **The CLI provider manages its own tools** — neo doesn't allowlist tools, the CLI does
2. **Agents declare intent, not implementation** — sandbox mode, not tool names
3. **One config block for provider** — adapter, models, args, env
4. **Subagents via neo CLI** — `neo run-agent` in Bash, works with any provider
5. **Registry over enum** — adding a provider = writing an `AgentRunner`, not modifying types

## 3. Agent YAML — Simplified Schema

### Before (Claude-coupled)

```yaml
name: developer
description: "Executes implementation plans..."
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
sandbox: writable
prompt: ../prompts/developer.md
agents:
  spec-reviewer:
    description: "Verify implementation matches spec"
    prompt: ../prompts/subagents/spec-reviewer.md
    tools: [Read, Grep, Glob]
    model: sonnet
  code-quality-reviewer:
    description: "Review code quality"
    prompt: ../prompts/subagents/code-quality-reviewer.md
    tools: [Read, Grep, Glob]
    model: sonnet
```

### After (provider-agnostic)

```yaml
name: developer
description: "Executes implementation plans step by step in an isolated git clone."
sandbox: writable
prompt: ../prompts/developer.md
# model: claude-opus-4-6    — optional, overrides provider.models.default
# maxTurns: 20              — optional
# maxCost: 5.0              — optional
```

### What's removed

| Field | Reason |
|-------|--------|
| `tools` | CLI provider manages its own tools. Sandbox mode is the only constraint neo needs. |
| `agents` | Subagents become standalone agent YAML files invoked via `neo run-agent`. |
| `model: sonnet` (enum) | Replaced by free string matching provider model IDs. |

### What remains

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent identifier |
| `description` | Yes | What the agent does |
| `sandbox` | Yes | `writable` or `readonly` |
| `prompt` | Yes | Path to prompt file |
| `model` | No | Model ID string, overrides `provider.models.default` |
| `maxTurns` | No | Max conversation turns |
| `maxCost` | No | Max session cost in USD |

### Zod Schema

```typescript
export const agentSandboxSchema = z.enum(["writable", "readonly"]);

export const agentConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  sandbox: agentSandboxSchema,
  prompt: z.string(),
  model: z.string().optional(),
  promptAppend: z.string().optional(),
  maxTurns: z.number().optional(),
  maxCost: z.number().min(0).optional(),
  mcpServers: z.array(z.string()).optional(),
  version: z.string().optional(),
});
```

**Deleted schemas:** `agentToolSchema`, `agentToolEntrySchema`, `agentModelSchema`, `subagentDefinitionSchema`.

## 4. Provider Configuration

### Config block

```yaml
# ~/.neo/config.yml
provider:
  adapter: claude                    # registered adapter name
  models:
    default: claude-sonnet-4-6       # used when agent has no model
    available:                       # whitelist, validated at boot
      - claude-sonnet-4-6
      - claude-opus-4-6
      - claude-haiku-4-5
  args: []                           # additional CLI flags per invocation
  env: {}                            # provider-specific env vars
```

### Switching provider

```yaml
provider:
  adapter: codex
  models:
    default: o3
    available: [o3, o4-mini]
  args: ["--full-auto"]
```

Agents without explicit `model` automatically use the new default. Agents with explicit model fail validation at boot — intentional, forces explicit review.

### Zod Schema

```typescript
const providerModelsSchema = z.object({
  default: z.string(),
  available: z.array(z.string()).min(1),
});

const providerConfigSchema = z.object({
  adapter: z.string(),
  models: providerModelsSchema.refine(
    (m) => m.available.includes(m.default),
    { message: "models.default must be in models.available" }
  ),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
```

### What moves from current config

| Current location | New location |
|-----------------|--------------|
| `supervisor.provider` | `provider.adapter` |
| `supervisor.model` | `provider.models.default` |
| `claudeCodePath` | `provider.adapter: /usr/local/bin/claude` or `provider.args` |

## 5. Adapter Registry

### Current: closed enum + factory switch

```typescript
// Current — must modify type + factory for each new provider
type AIProvider = "claude" | "codex";

function createAgentRunner(provider: AIProvider): AgentRunner {
  switch (provider) {
    case "claude": return new ClaudeAgentRunner();
    case "codex": return new CodexAgentRunner();
  }
}
```

### New: open registry

```typescript
const runners = new Map<string, AgentRunnerFactory>();

interface AgentRunnerFactory {
  create(config: ProviderConfig): AgentRunner;
  check?(): Promise<void>;  // optional: verify CLI is installed
}

// Built-in registrations
runners.set("claude", {
  create: (config) => new ClaudeAgentRunner(config),
  check: async () => { /* verify `claude` CLI exists */ },
});

runners.set("codex", {
  create: (config) => new CodexAgentRunner(config),
  check: async () => { /* verify `codex` CLI exists */ },
});

// Resolution
function createAgentRunner(config: ProviderConfig): AgentRunner {
  const factory = runners.get(config.adapter);
  if (!factory) {
    throw new Error(
      `Unknown adapter "${config.adapter}". Available: ${[...runners.keys()].join(", ")}`
    );
  }
  return factory.create(config);
}
```

### Adding a new provider

1. Write an `AgentRunner` implementation
2. Register it: `runners.set("gemini", { create: ... })`
3. No type changes, no factory changes

### AgentRunner interface (unchanged)

```typescript
interface AgentRunner {
  run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage>;
}
```

## 6. Sandbox Simplification

### Current: tool-based filtering

```typescript
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

interface SandboxConfig {
  allowedTools: string[];    // Claude tool names
  readablePaths: string[];
  writablePaths: string[];
  writable: boolean;
}
```

### New: boolean + paths

```typescript
interface SandboxConfig {
  writable: boolean;
  paths: {
    readable: string[];
    writable: string[];      // empty when writable === false
  };
}
```

Each adapter translates `writable` into its CLI's sandbox mechanism:

- **Claude:** `permissionMode: "bypassPermissions"` (filesystem isolation via cwd)
- **Codex:** `--sandbox read-only` or `--sandbox workspace-write`
- **Future:** whatever the CLI supports

**Deleted:** `allowedTools`, `WRITE_TOOLS` constant, tool filtering in `buildSandboxConfig()`.

## 7. Standalone Subagents

### Current: inline subagent definitions

Developer YAML embeds `spec-reviewer` and `code-quality-reviewer` definitions.
Architect YAML embeds `plan-reviewer`.
Requires Claude's native `Agent` tool.

### New: independent agent YAML files

```yaml
# packages/agents/agents/spec-reviewer.yml
name: spec-reviewer
description: "Verify implementation matches task specification exactly."
sandbox: readonly
prompt: ../prompts/subagents/spec-reviewer.md
```

```yaml
# packages/agents/agents/code-quality-reviewer.yml
name: code-quality-reviewer
description: "Review code quality, patterns, and test coverage."
sandbox: readonly
prompt: ../prompts/subagents/code-quality-reviewer.md
```

```yaml
# packages/agents/agents/plan-reviewer.yml
name: plan-reviewer
description: "Review implementation plan for completeness and feasibility."
sandbox: readonly
prompt: ../prompts/subagents/plan-reviewer.md
```

### Invocation via `neo run-agent`

The parent agent's prompt instructs it to call subagents via CLI:

```markdown
## Subagent workflow

After completing implementation, run reviews in sequence:

1. `neo run-agent spec-reviewer --task-file -` (pipe task via stdin)
2. Only if spec-reviewer passes: `neo run-agent code-quality-reviewer --task-file -`

Wait for each to complete. Check exit code: 0 = pass, 1 = fail.
```

### `neo run-agent` contract

**Input:**
- `--task-file -` reads task from stdin (avoids shell injection)
- `--task-file /path/to/file.md` reads from file
- Task as positional arg is NOT supported (shell injection risk)

**Output:**
- **stdout:** free-text output from the subagent (the parent reads this)
- **exit code:** `0` = success, `1` = failure, `2` = budget exceeded

**Subagent prompt convention:** subagent prompts end with:
```
End your response with PASS or FAIL on the last line to indicate your verdict.
```

### What's deleted

- `SubagentDefinition` type
- `subagentDefinitionSchema`
- `agents` field in `AgentConfig` and `AgentDefinition`
- `adapterOptions.agents` passthrough in `ClaudeAgentRunner`

## 8. Supervisor Adapter

### Separation from agent provider

The supervisor has different needs (multi-turn conversation, internal tools) than agents (task execution). It can use a different adapter and model:

```yaml
provider:
  adapter: codex
  models:
    default: o3
    available: [o3, o4-mini]

supervisor:
  adapter: claude              # optional, falls back to provider.adapter
  model: claude-opus-4-6       # optional, falls back to provider.models.default
  # ... operational params unchanged
```

**Resolution order:**
- `supervisor.adapter` → `provider.adapter` (fallback)
- `supervisor.model` → `provider.models.default` (fallback)

### SessionHandle — typed discriminated union

```typescript
interface ClaudeSessionHandle {
  adapter: "claude";
  sessionId: string;
}

interface CodexSessionHandle {
  adapter: "codex";
  threadId: string;
}

type SessionHandle = ClaudeSessionHandle | CodexSessionHandle;
```

Each adapter defines its own handle variant. Narrowing works via `handle.adapter`. Adding an adapter = adding a type to the union.

**Deleted:** `AIProvider` type (replaced by `provider.adapter` string).

## 9. Model Validation

Agent model validation happens at supervisor boot, not at agent resolution time (the resolver doesn't know the provider config).

```typescript
function validateAgentModels(
  agents: ResolvedAgent[],
  provider: ProviderConfig
): void {
  for (const agent of agents) {
    if (agent.model && !provider.models.available.includes(agent.model)) {
      throw new Error(
        `Agent "${agent.name}" specifies model "${agent.model}" ` +
        `which is not in provider.models.available: ` +
        `[${provider.models.available.join(", ")}]`
      );
    }
  }
}
```

Called once at boot before first dispatch.

## 10. Migration

### Agent YAML files

| File | Changes |
|------|---------|
| `architect.yml` | Remove `tools`, `model: opus` → optional `model: claude-opus-4-6`, remove `agents` block |
| `developer.yml` | Remove `tools`, `model: sonnet` → remove (use default), remove `agents` block |
| `reviewer.yml` | Remove `tools`, `model: sonnet` → remove (use default) |
| `scout.yml` | Remove `tools`, `model: opus` → optional `model: claude-opus-4-6` |

### New standalone agent files

| File | Source |
|------|--------|
| `spec-reviewer.yml` | Extracted from `developer.yml` agents block |
| `code-quality-reviewer.yml` | Extracted from `developer.yml` agents block |
| `plan-reviewer.yml` | Extracted from `architect.yml` agents block |

### Config migration

Old `config.yml` with `supervisor.provider: claude` and `supervisor.model` continues to work with a deprecation warning. A migration function maps:

- `supervisor.provider` → `provider.adapter`
- `supervisor.model` → `provider.models.default` + `provider.models.available`
- `claudeCodePath` → removed (use `provider.adapter` value or PATH)

### Code files impacted

| File | Action |
|------|--------|
| `packages/core/src/agents/schema.ts` | Remove tool/model enums, simplify schema |
| `packages/core/src/agents/resolver.ts` | Remove tools/agents requirements |
| `packages/core/src/config/schema.ts` | Add `providerConfigSchema`, clean supervisor config |
| `packages/core/src/isolation/sandbox.ts` | Remove `allowedTools`, simplify to writable + paths |
| `packages/core/src/supervisor/ai-adapter.ts` | Remove `AIProvider`, update `AgentRunOptions`, update `SessionHandle` |
| `packages/core/src/runner/adapters/index.ts` | Factory → registry |
| `packages/core/src/runner/adapters/claude-session.ts` | Remove `allowedTools`/`agents`, receive `ProviderConfig` |
| `packages/core/src/runner/adapters/codex-session.ts` | Receive `ProviderConfig` for args/env |
| `packages/core/src/supervisor/adapters/index.ts` | Same registry pattern |
| `packages/core/src/supervisor/daemon.ts` | Use `config.provider.adapter` |
| `packages/core/src/runner/session-executor.ts` | Remove `agents` passthrough, simplify sandbox |

### What does NOT change

- `AgentRunner` interface (`run(options) → AsyncIterable<SDKStreamMessage>`)
- Recovery system (`runWithRecovery`)
- Event system and middleware
- JSONL journals
- Concurrency / budget / session configs
- Prompt files (except adding subagent CLI instructions)
