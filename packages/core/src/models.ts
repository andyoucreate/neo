// ─── Supported models ───────────────────────────────────
// Single source of truth: model ID → adapter name.
// Adding a model = adding one line here.

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

// ─── Aliases ────────────────────────────────────────────
// Short names → canonical model ID.

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

// ─── Functions ──────────────────────────────────────────

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export function getAdapter(model: string): string {
  const resolved = resolveModel(model);
  const adapter = SUPPORTED_MODELS[resolved];
  if (!adapter) {
    throw new Error(
      `Unknown model "${model}". Supported: ${[...Object.keys(SUPPORTED_MODELS), ...Object.keys(MODEL_ALIASES)].join(", ")}`,
    );
  }
  return adapter;
}

export function listModels(): string[] {
  return Object.keys(SUPPORTED_MODELS);
}
