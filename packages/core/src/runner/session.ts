import type { McpServerConfig } from "@/config";
import type { SandboxConfig } from "@/isolation/sandbox";
import { isInitMessage, isResultMessage, type SDKStreamMessage } from "@/sdk-types";
import type { ResolvedAgent } from "@/types";

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

// ─── Query Options Builder ──────────────────────────────

function buildQueryOptions(options: SessionOptions): Record<string, unknown> {
  const { sessionPath, sandboxConfig } = options;

  const queryOptions: Record<string, unknown> = {
    // Always pass cwd: session clone for writable agents, repo root for readonly.
    // Without this, readonly agents default to process.cwd() and may write to main tree.
    cwd: sessionPath ?? options.repoPath,
    // maxTurns: agent.maxTurns,
    allowedTools: sandboxConfig.allowedTools,
    // Workers run detached without a TTY — bypass interactive permission prompts.
    // Required pair: permissionMode alone is not enough, SDK also needs the flag.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Load project-level CLAUDE.md so agents inherit project rules and conventions.
    settingSources: ["user", "project", "local"],
    // Don't persist agent sessions — they are ephemeral clones.
    persistSession: false,
  };

  if (options.resumeSessionId) {
    queryOptions.resume = options.resumeSessionId;
  }

  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    queryOptions.mcpServers = options.mcpServers;
  }

  // SECURITY: Whitelist safe environment variables to prevent secret exposure.
  // Agents can read env via Bash tool — only pass essential system vars.
  const safeEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
  };

  if (options.env && Object.keys(options.env).length > 0) {
    // Merge custom vars with whitelisted system vars.
    // Custom vars override whitelisted vars if there's a conflict.
    queryOptions.env = { ...safeEnv, ...options.env };
  } else {
    // Even without custom env, pass whitelisted vars for proper shell operation.
    queryOptions.env = safeEnv;
  }

  return queryOptions;
}

// ─── Session Runner ─────────────────────────────────────

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { prompt, initTimeoutMs, maxDurationMs, onEvent } = options;

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
    const queryOptions = buildQueryOptions(options);

    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    // The prompt is already assembled by the orchestrator (agent prompt +
    // repo instructions + git strategy context + task). Session just passes it through.
    const stream = sdk.query({ prompt, options: queryOptions as never });

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
