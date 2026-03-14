import type { McpServerConfig } from "../config.js";
import type { SandboxConfig } from "../isolation/sandbox.js";
import type { ResolvedAgent } from "../types.js";

// ─── Types ──────────────────────────────────────────────

export interface SessionOptions {
  agent: ResolvedAgent;
  prompt: string;
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

// ─── Session Runner ─────────────────────────────────────

export async function runSession(
  options: SessionOptions,
): Promise<SessionResult> {
  const {
    agent,
    prompt,
    worktreePath,
    sandboxConfig,
    initTimeoutMs,
    maxDurationMs,
    resumeSessionId,
    onEvent,
  } = options;

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
      cwd: worktreePath,
      maxTurns: agent.maxTurns,
      allowedTools: sandboxConfig.allowedTools,
    };

    if (resumeSessionId) {
      queryOptions.resume = resumeSessionId;
    }

    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    const stream = sdk.query({
      prompt,
      options: queryOptions as never,
    });

    for await (const message of stream) {
      if (abortController.signal.aborted) {
        const reason = abortController.signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }

      if (message.type === "system" && message.subtype === "init") {
        sessionId = (message as Record<string, unknown>).session_id as string;
        clearTimeout(initTimer);
        onEvent?.({ type: "session:start", sessionId });
      }

      if (message.type === "result") {
        const result = message as Record<string, unknown>;
        output = (result.result as string) ?? "";
        costUsd = (result.total_cost_usd as number) ?? 0;
        turnCount = (result.num_turns as number) ?? 0;
        sessionId = (result.session_id as string) ?? sessionId;

        if (result.subtype !== "success") {
          const errorType = result.subtype as string;
          throw new SessionError(
            `Session ended with error: ${errorType}`,
            errorType,
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorSessionId = sessionId || "unknown";
    onEvent?.({
      type: "session:fail",
      sessionId: errorSessionId,
      error: errorMessage,
    });

    if (error instanceof SessionError) {
      throw error;
    }

    throw new SessionError(
      errorMessage,
      abortController.signal.aborted ? "timeout" : "unknown",
      errorSessionId,
    );
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
