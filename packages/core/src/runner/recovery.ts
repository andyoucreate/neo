import {
  runSession,
  SessionError,
  type SessionOptions,
  type SessionResult,
} from "./session.js";

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
export async function runWithRecovery(
  options: RecoveryOptions,
): Promise<SessionResult> {
  const {
    maxRetries,
    backoffBaseMs,
    nonRetryable = DEFAULT_NON_RETRYABLE,
    onAttempt,
    ...sessionOptions
  } = options;

  let lastSessionId: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const strategy = getStrategy(attempt);
    onAttempt?.(attempt, strategy);

    try {
      const attemptOptions: SessionOptions = {
        ...sessionOptions,
        resumeSessionId: strategy === "resume" ? lastSessionId : undefined,
      };

      const result = await runSession(attemptOptions);
      lastSessionId = result.sessionId;
      return result;
    } catch (error) {
      if (error instanceof SessionError) {
        lastSessionId =
          error.sessionId !== "unknown" ? error.sessionId : lastSessionId;

        if (nonRetryable.includes(error.errorType)) {
          throw error;
        }
      }

      if (attempt === maxRetries) {
        throw error instanceof Error
          ? new Error(
              `Recovery failed after ${maxRetries} attempts. Last error: ${error.message}`,
              { cause: error },
            )
          : new Error(`Recovery failed after ${maxRetries} attempts`);
      }

      if (attempt >= 2) {
        lastSessionId = undefined;
      }

      const backoffMs = backoffBaseMs * attempt;
      await sleep(backoffMs);
    }
  }

  throw new Error("Recovery failed: unreachable");
}
