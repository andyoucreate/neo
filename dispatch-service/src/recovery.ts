import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_RECOVERY_RETRIES, RECOVERY_BACKOFF_BASE_MS } from "./config.js";
import { logger } from "./logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a query() with automatic session recovery.
 * On failure: resume the same session (attempt 2), then fresh session (attempt 3).
 * After maxRetries, throws and escalates.
 */
export async function runWithRecovery(
  pipeline: string,
  prompt: string,
  options: Options,
  callbacks?: {
    onSessionId?: (sessionId: string) => void;
    onMessage?: (message: SDKMessage) => void;
    onCostRecord?: (result: SDKResultMessage) => void;
  },
  maxRetries = MAX_RECOVERY_RETRIES,
): Promise<SDKResultMessage> {
  let lastSessionId: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const queryOptions: Options = lastSessionId
        ? { ...options, resume: lastSessionId }
        : options;

      logger.info(
        `Starting ${pipeline} (attempt ${attempt}/${maxRetries})${lastSessionId ? ` resuming ${lastSessionId}` : ""}`,
      );

      for await (const message of query({ prompt, options: queryOptions })) {
        // Capture session ID for recovery
        if (message.type === "system" && message.subtype === "init") {
          lastSessionId = message.session_id;
          callbacks?.onSessionId?.(message.session_id);
        }

        // Forward all messages to caller
        callbacks?.onMessage?.(message);

        // Success — return the result
        if (message.type === "result") {
          callbacks?.onCostRecord?.(message);
          return message;
        }
      }

      // If we get here, the stream ended without a result
      throw new Error(`${pipeline} stream ended without result message`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        `${pipeline} attempt ${attempt} failed: ${errMsg}`,
      );

      if (attempt === maxRetries) {
        throw new Error(
          `${pipeline} failed after ${maxRetries} attempts. Last error: ${errMsg}`,
          { cause: error },
        );
      }

      // On attempt 3+, use fresh session to avoid corrupted state
      if (attempt >= 2) {
        logger.info("Switching to fresh session (avoiding corrupted state)");
        lastSessionId = undefined;
      }

      const backoffMs = attempt * RECOVERY_BACKOFF_BASE_MS;
      logger.info(`Backing off ${backoffMs}ms before retry`);
      await sleep(backoffMs);
    }
  }

  // TypeScript: unreachable but needed for type checking
  throw new Error(`${pipeline} failed: unreachable`);
}
