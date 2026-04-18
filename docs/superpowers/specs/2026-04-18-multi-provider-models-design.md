# Multi-Provider Model Catalog

**Date:** 2026-04-18
**Status:** Draft
**Goal:** Replace the provider config block with a built-in model catalog that auto-resolves adapters from model strings.

---

## 1. Problem Statement

The current `provider` config block forces a single active provider. Switching between Claude and Codex requires editing the config. Running agents on different providers simultaneously is impossible.

## 2. Design

### Model catalog — single source of truth

A TypeScript file lists every supported model and its adapter:

```typescript
// packages/core/src/models.ts

export const SUPPORTED_MODELS: Record<string, string> = {
  // Anthropic — via claude CLI
  "claude-opus-4-7": "claude",
  "claude-opus-4-6": "claude",
  "claude-sonnet-4-6": "claude",
  "claude-haiku-4-5": "claude",

  // OpenAI — via codex CLI
  "gpt-5.4": "codex",
  "gpt-5.4-mini": "codex",
};

export function getAdapter(model: string): string {
  const adapter = SUPPORTED_MODELS[model];
  if (!adapter) {
    throw new Error(
      `Unknown model "${model}". Supported: ${Object.keys(SUPPORTED_MODELS).join(", ")}`,
    );
  }
  return adapter;
}

export function listModels(): string[] {
  return Object.keys(SUPPORTED_MODELS);
}
```

Adding a model = adding one line. Adding a provider = writing an `AgentRunner` + adding models to the catalog.

### Config — reduced to one field

```yaml
# ~/.neo/config.yml
models:
  default: claude-sonnet-4-6
```

That's it. No `provider` block, no `adapter`, no `available`, no `args`, no `env`.

Schema:

```typescript
const modelsConfigSchema = z.object({
  default: z.string(),
});
```

Validation at config load: `models.default` must be in `SUPPORTED_MODELS`.

### Agent YAML — unchanged

```yaml
name: reviewer
sandbox: readonly
prompt: ../prompts/reviewer.md
# no model → uses models.default

name: scout
sandbox: readonly
model: o3          # uses codex adapter
prompt: ../prompts/scout.md
```

Validation at agent resolution: if `model` is set, it must be in `SUPPORTED_MODELS`.

### Adapter resolution flow

1. Determine model: `agent.definition.model ?? config.models.default`
2. Look up adapter: `getAdapter(model)` → `"claude"` or `"codex"`
3. Get runner: `registry.get(adapter)` → `ClaudeAgentRunner` or `CodexAgentRunner`
4. Pass model to runner: `options.model = model`

### Supervisor

The supervisor also uses the catalog. `supervisor.model` determines which adapter runs heartbeats:

```yaml
supervisor:
  model: claude-opus-4-6    # → claude adapter for heartbeats
```

If not set, falls back to `models.default`.

## 3. What Changes

### Deleted

| Item | Reason |
|------|--------|
| `providerConfigSchema` | Replaced by `modelsConfigSchema` |
| `ProviderConfig` type | No longer needed |
| `provider` block in config | Replaced by `models.default` |
| `provider.adapter` | Auto-resolved from model string |
| `provider.models.available` | All models in `SUPPORTED_MODELS` are available |
| `provider.args` | Adapter-specific, hardcoded in adapter |
| `provider.env` | Use system env vars |
| `AgentRunOptions.providerConfig` | Replaced by `AgentRunOptions.model` (already exists) |
| `validateAgentModels()` | Replaced by `getAdapter()` which throws on unknown |
| `agents/validation.ts` | Deleted |

### Created

| Item | Purpose |
|------|---------|
| `packages/core/src/models.ts` | Model catalog with `SUPPORTED_MODELS`, `getAdapter()`, `listModels()` |

### Modified

| File | Change |
|------|--------|
| `config/schema.ts` | Replace `providerConfigSchema` with `modelsConfigSchema` |
| `config/merge.ts` | Update `defaultConfig` |
| `runner/adapters/index.ts` | `createAgentRunner(adapter: string)` instead of `createAgentRunner(config: ProviderConfig)` |
| `runner/adapters/claude-session.ts` | Remove `providerConfig` from options |
| `runner/adapters/codex-session.ts` | Hardcode `--full-auto` in adapter, remove `providerConfig` |
| `runner/session.ts` | Remove `providerConfig` from `SessionOptions` |
| `supervisor/ai-adapter.ts` | Remove `providerConfig` from `AgentRunOptions` |
| `supervisor/daemon.ts` | Use `getAdapter(config.supervisor.model)` |
| `supervisor/heartbeat.ts` | Resolve adapter from model |
| `index.ts` | Export `SUPPORTED_MODELS`, `getAdapter`, `listModels`. Remove `ProviderConfig`, `providerConfigSchema` |
| `cli/src/commands/agents.ts` | No change needed |

### Config migration

Old:
```yaml
provider:
  adapter: claude
  models:
    default: claude-sonnet-4-6
    available: [claude-sonnet-4-6, claude-opus-4-6]
```

New:
```yaml
models:
  default: claude-sonnet-4-6
```

## 4. Examples

### All agents on Claude (default)

```yaml
# config
models:
  default: claude-sonnet-4-6
```

Every agent uses `claude-sonnet-4-6` unless overridden.

### Mix Claude and Codex

```yaml
# config
models:
  default: claude-sonnet-4-6

# architect.yml — Claude Opus for complex reasoning
model: claude-opus-4-6

# scout.yml — Codex o3 for fast exploration
model: o3

# reviewer.yml — no model, uses default (Claude Sonnet)
```

### All agents on Codex

```yaml
# config
models:
  default: o3
```

Agents with `model: claude-opus-4-6` still use Claude. The default just changes.
