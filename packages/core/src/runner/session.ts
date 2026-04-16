import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import { isInitMessage, isResultMessage, type SDKStreamMessage } from "@/sdk-types";
import type { SessionAdapter, SessionRunOptions } from "@/supervisor/ai-adapter";
import type { ResolvedAgent } from "@/types";
import { ClaudeSessionAdapter } from "./adapters/claude-session.js";

// ─── Types ──────────────────────────────────────────────

export interface SessionOptions {
  agent: ResolvedAgent;
  prompt: string;
  repoPath?: string;
  sessionPath?: string;
  sandboxConfig: SandboxConfig;
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  initTimeoutMs: number;
  maxDurationMs: number;
  maxTurns?: number | undefined;
  resumeSessionId?: string | undefined;
  agents?: Record<string, unknown> | undefined;
  onEvent?: ((event: SessionEvent) => void) | undefined;
  claudeCodePath?: string | undefined;
  adapter?: SessionAdapter | undefined;
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

function buildRunOptions(options: SessionOptions): SessionRunOptions {
  const runOptions: SessionRunOptions = {
    prompt: options.prompt,
    cwd: options.sessionPath ?? options.repoPath ?? process.cwd(),
    sandboxConfig: options.sandboxConfig,
    adapterOptions: {
      ...(options.agents ? { agents: options.agents } : {}),
      ...(options.claudeCodePath ? { claudeCodePath: options.claudeCodePath } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
    },
  };

  if (options.mcpServers) runOptions.mcpServers = options.mcpServers;
  if (options.env) runOptions.env = options.env;
  if (options.maxTurns !== undefined) runOptions.maxTurns = options.maxTurns;
  if (options.resumeSessionId !== undefined) runOptions.resumeSessionId = options.resumeSessionId;

  return runOptions;
}

// ─── Session Runner ─────────────────────────────────────

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { initTimeoutMs, maxDurationMs, onEvent } = options;
  const adapter = options.adapter ?? new ClaudeSessionAdapter();
  const runOptions = buildRunOptions(options);

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
    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    const stream = adapter.runSession(runOptions);

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
