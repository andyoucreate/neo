import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import { getAdapter, resolveModel } from "@/models";
import { createAgentRunner } from "@/runner/adapters/index";
import { isInitMessage, isResultMessage, type SDKStreamMessage } from "@/sdk-types";
import type { AgentRunner, AgentRunOptions } from "@/supervisor/ai-adapter";
import type { ResolvedAgent } from "@/types";

// ─── Types ──────────────────────────────────────────────

export interface SessionOptions {
  agent: ResolvedAgent;
  prompt: string;
  repoPath?: string;
  sessionPath?: string;
  sandboxConfig: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  initTimeoutMs: number;
  maxDurationMs: number;
  maxTurns?: number | undefined;
  resumeSessionId?: string | undefined;
  onEvent?: ((event: SessionEvent) => void) | undefined;
  /** Default model from config (models.default) — used when agent has no model */
  defaultModel?: string | undefined;
  adapter?: AgentRunner | undefined;
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

function buildRunOptions(options: SessionOptions): AgentRunOptions {
  const model = resolveModel(
    options.agent.definition.model ?? options.defaultModel ?? "claude-sonnet-4-6",
  );

  const runOptions: AgentRunOptions = {
    prompt: options.prompt,
    cwd: options.sessionPath ?? options.repoPath ?? process.cwd(),
    sandboxConfig: options.sandboxConfig,
    model,
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

  // Resolve adapter from agent model → catalog → registry
  let adapter: AgentRunner;
  if (options.adapter) {
    adapter = options.adapter;
  } else {
    const model = resolveModel(
      options.agent.definition.model ?? options.defaultModel ?? "claude-sonnet-4-6",
    );
    const adapterName = getAdapter(model);
    adapter = createAgentRunner(adapterName);
  }

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

    const stream = adapter.run(runOptions);

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
