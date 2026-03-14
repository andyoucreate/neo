import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import type { ResolvedAgent } from "@/types";

// ─── Types ──────────────────────────────────────────────

export interface SessionOptions {
  agent: ResolvedAgent;
  prompt: string;
  repoPath?: string;
  worktreePath?: string;
  sandboxConfig: SandboxConfig;
  hooks?: Record<string, unknown>;
  mcpServers?: McpServerConfig[];
  initTimeoutMs: number;
  maxDurationMs: number;
  resumeSessionId?: string | undefined;
  onEvent?: ((event: SessionEvent) => void) | undefined;
}

export interface SessionResult {
  sessionId: string;
  output: string;
  costUsd: number;
  durationMs: number;
  turnCount: number;
}

export type SessionEvent =
  | { type: "session:start"; sessionId: string }
  | { type: "session:complete"; sessionId: string; result: SessionResult }
  | { type: "session:fail"; sessionId: string; error: string };

// ─── SDK stream message shapes ──────────────────────────

interface SDKInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
}

interface SDKResultMessage {
  type: "result";
  subtype: "success" | string;
  session_id: string;
  result: string;
  total_cost_usd: number;
  num_turns: number;
}

interface SDKStreamMessage {
  type: string;
  subtype?: string;
}

function isInitMessage(msg: SDKStreamMessage): msg is SDKInitMessage {
  return msg.type === "system" && msg.subtype === "init";
}

function isResultMessage(msg: SDKStreamMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

// ─── Helpers ────────────────────────────────────────────

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

function toSessionError(error: unknown, isTimeout: boolean, sessionId: string): SessionError {
  if (error instanceof SessionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SessionError(message, isTimeout ? "timeout" : "unknown", sessionId);
}

// ─── Session Runner ─────────────────────────────────────

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { agent, prompt, worktreePath, sandboxConfig, initTimeoutMs, maxDurationMs, onEvent } =
    options;

  const startTime = Date.now();
  let sessionId = "";

  const abortController = new AbortController();
  const initTimer = setTimeout(() => {
    abortController.abort(new Error("Session init timeout exceeded"));
  }, initTimeoutMs);
  const maxDurationTimer = setTimeout(() => {
    abortController.abort(new Error("Session max duration exceeded"));
  }, maxDurationMs);

  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const queryOptions: Record<string, unknown> = {
      // Always pass cwd: worktree for writable agents, repo root for readonly.
      // Without this, readonly agents default to process.cwd() and may write to main tree.
      cwd: worktreePath ?? options.repoPath,
      maxTurns: agent.maxTurns,
      allowedTools: sandboxConfig.allowedTools,
    };

    if (options.resumeSessionId) {
      queryOptions.resume = options.resumeSessionId;
    }

    if (options.mcpServers?.length) {
      queryOptions.mcpServers = options.mcpServers;
    }

    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    // Combine agent system prompt with task prompt so the agent
    // receives its full instructions (commit, push, etc.)
    const fullPrompt = agent.definition.prompt
      ? `${agent.definition.prompt}\n\n---\n\n## Task\n\n${prompt}`
      : prompt;

    const stream = sdk.query({ prompt: fullPrompt, options: queryOptions as never });

    for await (const message of stream) {
      checkAborted(abortController.signal);

      const msg = message as SDKStreamMessage;

      if (isInitMessage(msg)) {
        sessionId = msg.session_id;
        clearTimeout(initTimer);
        onEvent?.({ type: "session:start", sessionId });
      }

      if (isResultMessage(msg)) {
        output = msg.result ?? "";
        costUsd = msg.total_cost_usd ?? 0;
        turnCount = msg.num_turns ?? 0;
        sessionId = msg.session_id ?? sessionId;

        if (msg.subtype !== "success") {
          throw new SessionError(
            `Session ended with error: ${msg.subtype}`,
            msg.subtype,
            sessionId,
          );
        }
      }
    }

    const sessionResult: SessionResult = {
      sessionId,
      output,
      costUsd,
      durationMs: Date.now() - startTime,
      turnCount,
    };

    onEvent?.({ type: "session:complete", sessionId, result: sessionResult });
    return sessionResult;
  } catch (error) {
    const errorSessionId = sessionId || "unknown";
    const sessionError = toSessionError(error, abortController.signal.aborted, errorSessionId);

    onEvent?.({ type: "session:fail", sessionId: errorSessionId, error: sessionError.message });
    throw sessionError;
  } finally {
    clearTimeout(initTimer);
    clearTimeout(maxDurationTimer);
  }
}

// ─── Error class ────────────────────────────────────────

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly errorType: string,
    public readonly sessionId: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
