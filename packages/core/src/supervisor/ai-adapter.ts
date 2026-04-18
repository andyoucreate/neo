import type { McpServerConfig, ProviderConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import type { SDKStreamMessage } from "@/sdk-types";

// ─── Session Handles ─────────────────────────────────────

export interface ClaudeSessionHandle {
  adapter: "claude";
  sessionId: string;
}

export interface CodexSessionHandle {
  adapter: "codex";
  threadId: string;
}

export type SessionHandle = ClaudeSessionHandle | CodexSessionHandle;

// ─── Agent Runner ───────────────────────────────────────

/** Options passed to an agent runner for each execution (runner or supervisor). */
export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  maxTurns?: number;
  resumeSessionId?: string;
  model?: string;
  providerConfig?: ProviderConfig;
}

/** Provider-specific agent runner. Spawns a CLI agent and streams results. */
export interface AgentRunner {
  run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage>;
}
