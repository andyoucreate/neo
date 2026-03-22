import {
  runSession,
  SessionError,
  type SessionOptions,
  type SessionResult,
} from "@/runner/session";

// ─── Types ──────────────────────────────────────────────

export interface RecoveryOptions extends SessionOptions {
  maxRetries: number;
  backoffBaseMs: number;
  nonRetryable?: string[];
  onAttempt?: (attempt: number, strategy: string) => void;
}

// ─── Default non-retryable errors ───────────────────────

const DEFAULT_NON_RETRYABLE = ["error_max_turns", "budget_exceeded"];

// ─── Recovery strategy names ────────────────────────────

function getStrategy(attempt: number): string {
  switch (attempt) {
    case 1:
      return "normal";
    case 2:
      return "resume";
    default:
      return "fresh";
  }
}

// ─── Sleep utility ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error handling ─────────────────────────────────────

function isNonRetryable(error: unknown, nonRetryable: string[]): boolean {
  return error instanceof SessionError && nonRetryable.includes(error.errorType);
}

function updateSessionId(error: unknown, current: string | undefined): string | undefined {
  if (error instanceof SessionError && error.sessionId !== "unknown") {
    return error.sessionId;
  }
  return current;
}

function buildFinalError(error: unknown, maxRetries: number): Error {
  if (error instanceof Error) {
    return new Error(`Recovery failed after ${maxRetries} attempts. Last error: ${error.message}`, {
      cause: error,
    });
  }
  return new Error(`Recovery failed after ${maxRetries} attempts`);
}

/**
 * Run a session with 3-level recovery escalation (ADR-020).
 *
 * Level 1 (attempt 1): Normal execution — new session
 * Level 2 (attempt 2): Resume session — pass resumeSessionId from level 1
 * Level 3 (attempt 3): Fresh session — abandon previous, start clean
 *
 * Non-retryable errors skip to immediate failure.
 * Backoff: backoffBaseMs * attempt between levels.
 */
export async function runWithRecovery(options: RecoveryOptions): Promise<SessionResult> {
  const {
    maxRetries,
    backoffBaseMs,
    nonRetryable = DEFAULT_NON_RETRYABLE,
    onAttempt,
    ...rest
  } = options;

  let lastSessionId: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const strategy = getStrategy(attempt);
    onAttempt?.(attempt, strategy);

    // Fresh strategy starts clean — no session inheritance
    if (strategy === "fresh") {
      lastSessionId = undefined;
    }

    try {
      const result = await runSession({
        ...rest,
        resumeSessionId: strategy === "resume" ? lastSessionId : undefined,
      });
      return result;
    } catch (error) {
      lastSessionId = updateSessionId(error, lastSessionId);

      if (isNonRetryable(error, nonRetryable)) throw error;
      if (attempt === maxRetries) throw buildFinalError(error, maxRetries);

      await sleep(backoffBaseMs * attempt);
    }
  }

  throw new Error("Recovery failed: unreachable");
}
