import {
  runSession,
  SessionError,
  type SessionOptions,
  type SessionResult,
} from "@/runner/session";
import { sleep } from "@/shared/time";

// ─── Types ──────────────────────────────────────────────

export interface RecoveryOptions extends SessionOptions {
  maxRetries: number;
  backoffBaseMs: number;
  nonRetryable?: string[];
  onAttempt?: (attempt: number, strategy: string) => void;
}

// ─── Failure Context ────────────────────────────────────

interface FailureContext {
  errorMessage: string;
  errorType: string;
  attempt: number;
  strategy: string;
}

/**
 * Build a prompt prefix that injects the previous failure context.
 * This gives the agent information to try a different approach.
 */
function buildFailureContextPrefix(ctx: FailureContext): string {
  return `## PREVIOUS ATTEMPT FAILED

Your previous attempt (attempt ${ctx.attempt}, strategy: ${ctx.strategy}) failed with:
- **Error type:** ${ctx.errorType}
- **Error message:** ${ctx.errorMessage}

Please try a different approach to complete this task. Consider what caused the failure and how to avoid it.

---

`;
}

/**
 * Inject failure context into the prompt for retry attempts.
 */
function injectFailureContext(originalPrompt: string, ctx: FailureContext): string {
  return buildFailureContextPrefix(ctx) + originalPrompt;
}

/**
 * Extract error information from an unknown error.
 */
function extractErrorInfo(error: unknown): { message: string; type: string } {
  if (error instanceof SessionError) {
    return { message: error.message, type: error.errorType };
  }
  if (error instanceof Error) {
    return { message: error.message, type: "unknown" };
  }
  return { message: String(error), type: "unknown" };
}

// ─── Default non-retryable errors ───────────────────────

const DEFAULT_NON_RETRYABLE = ["budget_exceeded"];

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
 *
 * On retry, the prompt is enriched with failure context from the previous
 * attempt, giving the agent information to try a different approach.
 */
export async function runWithRecovery(options: RecoveryOptions): Promise<SessionResult> {
  const {
    maxRetries,
    backoffBaseMs,
    nonRetryable = DEFAULT_NON_RETRYABLE,
    onAttempt,
    prompt: originalPrompt,
    ...rest
  } = options;

  let lastSessionId: string | undefined;
  let lastFailureContext: FailureContext | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const strategy = getStrategy(attempt);
    onAttempt?.(attempt, strategy);

    // Inject failure context on retry attempts
    const prompt = lastFailureContext
      ? injectFailureContext(originalPrompt, lastFailureContext)
      : originalPrompt;

    try {
      const result = await runSession({
        ...rest,
        prompt,
        resumeSessionId: strategy === "resume" ? lastSessionId : undefined,
      });
      return result;
    } catch (error) {
      lastSessionId = updateSessionId(error, lastSessionId);

      if (isNonRetryable(error, nonRetryable)) throw error;
      if (attempt === maxRetries) throw buildFinalError(error, maxRetries);

      // Capture failure context for next attempt
      const errorInfo = extractErrorInfo(error);
      lastFailureContext = {
        errorMessage: errorInfo.message,
        errorType: errorInfo.type,
        attempt,
        strategy,
      };

      // Next attempt will be "fresh" — clear session to start clean
      if (getStrategy(attempt + 1) === "fresh") {
        lastSessionId = undefined;
      }

      await sleep(backoffBaseMs * attempt);
    }
  }

  throw new Error("Recovery failed: unreachable");
}
