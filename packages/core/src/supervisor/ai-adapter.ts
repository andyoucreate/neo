import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Session handles ──────────────────────────────────────

/**
 * Opaque session handle — each adapter stores what it needs.
 * Persisted via SupervisorStore so it survives process restart.
 * Only "claude" is implemented now — others are reserved for future providers.
 */
export type SessionHandle = { provider: "claude"; sessionId: string };
// Future: | { provider: "openai"; threadId: string }
// Future: | { provider: "gemini"; conversationId: string }

// ─── Messages ────────────────────────────────────────────

export type SupervisorMessageKind = "text" | "tool_use" | "end";

export interface SupervisorMessage {
  kind: SupervisorMessageKind;
  toolName?: string;
  toolInput?: unknown;
  text?: string;
}

// ─── Query options ────────────────────────────────────────

export interface AIQueryOptions {
  prompt: string;
  tools: ToolDefinition[];
  sessionHandle?: SessionHandle;
  systemPrompt?: string;
  model?: string;
}

// ─── Interface ────────────────────────────────────────────

/**
 * Adapter interface for AI providers.
 * ClaudeAdapter is the default implementation.
 * Future: OpenAIAdapter, GeminiAdapter, OllamaAdapter.
 */
export interface AIAdapter {
  /**
   * Execute one turn of the supervisor conversation.
   * Returns an async iterable of structured messages.
   */
  query(options: AIQueryOptions): AsyncIterable<SupervisorMessage>;

  /** Returns the current session handle (undefined before first turn). */
  getSessionHandle(): SessionHandle | undefined;

  /** Restore a previously persisted session handle. */
  restoreSession(handle: SessionHandle): void;
}
