import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import type { SDKStreamMessage } from "@/sdk-types";
import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Provider type ──────────────────────────────────────

export type AIProvider = "claude" | "codex";

// ─── Session handles ──────────────────────────────────────

/**
 * Opaque session handle — each adapter stores what it needs.
 * Persisted via SupervisorStore so it survives process restart.
 */
export type SessionHandle =
  | { provider: "claude"; sessionId: string }
  | { provider: "codex"; threadId: string };

// ─── Messages ────────────────────────────────────────────

export type SupervisorMessageKind = "text" | "tool_use" | "end";

export interface SupervisorMessage {
  kind: SupervisorMessageKind;
  toolName?: string;
  toolInput?: unknown;
  text?: string;
  metadata?: { costUsd?: number; turnCount?: number };
}

// ─── Query options ────────────────────────────────────────

export interface AIQueryOptions {
  prompt: string;
  tools: ToolDefinition[];
  sessionHandle?: SessionHandle;
  systemPrompt?: string;
  model?: string;
}

// ─── Supervisor Adapter ──────────────────────────────────

/**
 * Adapter interface for AI providers.
 * ClaudeAdapter is the default implementation.
 * Future: CodexAdapter, OpenAIAdapter, GeminiAdapter.
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

// ─── Session Adapter (Runner) ────────────────────────────

/** Options passed to a session runner for each agent execution. */
export interface SessionRunOptions {
  prompt: string;
  cwd: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  maxTurns?: number;
  resumeSessionId?: string;
  model?: string;
  adapterOptions?: Record<string, unknown>;
}

/** Low-level runner interface for provider-specific session execution. */
export interface SessionAdapter {
  runSession(options: SessionRunOptions): AsyncIterable<SDKStreamMessage>;
}
