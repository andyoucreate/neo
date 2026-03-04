import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MAX_RECOVERY_RETRIES, RECOVERY_BACKOFF_BASE_MS } from "./config.js";
import { logger } from "./logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log important SDK messages for debugging.
 * Only logs lifecycle, error, and rate limit events — not every message.
 */
function logSdkMessage(pipeline: string, sessionId: string, message: SDKMessage): void {
  try {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          logger.info(`[${pipeline}] Session ${message.session_id} initialized`, {
            model: message.model,
            tools: message.tools,
            agents: message.agents,
            permissionMode: message.permissionMode,
          });
        } else if (message.subtype === "status" && "status" in message && message.status) {
          logger.info(`[${pipeline}] Session ${sessionId} status: ${message.status}`);
        }
        break;

      case "result":
        if (message.subtype === "success") {
          logger.info(`[${pipeline}] Session ${sessionId} completed`, {
            turns: message.num_turns,
            cost: message.total_cost_usd,
            durationMs: message.duration_ms,
            durationApiMs: message.duration_api_ms,
            modelUsage: message.modelUsage,
          });
        } else {
          logger.error(`[${pipeline}] Session ${sessionId} error: ${message.subtype}`, {
            turns: message.num_turns,
            cost: message.total_cost_usd,
            errors: "errors" in message ? message.errors : undefined,
            permissionDenials: message.permission_denials.length,
          });
        }
        break;

      case "rate_limit_event":
        if ("rate_limit_info" in message) {
          const info = message.rate_limit_info;
          logger.warn(`[${pipeline}] Session ${sessionId} rate limit: ${info.status}`, {
            utilization: info.utilization,
            resetsAt: info.resetsAt ? new Date(info.resetsAt).toISOString() : undefined,
          });
        }
        break;

      case "tool_use_summary":
        if ("summary" in message) {
          logger.debug(`[${pipeline}] Session ${sessionId} tool summary: ${message.summary}`);
        }
        break;
    }
  } catch {
    // Never let logging crash the pipeline
  }
}

/**
 * Log prompt and options for dry-run mode, return a mock result.
 */
function dryRunResult(pipeline: string, prompt: string, options: Options): SDKResultMessage {
  console.log("\n" + "=".repeat(70));
  console.log(`DRY RUN — ${pipeline} pipeline`);
  console.log("=".repeat(70));
  console.log("\n--- PROMPT ---\n");
  console.log(prompt);
  console.log("\n--- OPTIONS ---\n");
  console.log(JSON.stringify({
    cwd: options.cwd,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    agents: options.agents ? Object.keys(options.agents) : [],
    sandbox: options.sandbox?.enabled ? "(enabled)" : "(disabled)",
  }, null, 2));
  console.log("\n" + "=".repeat(70) + "\n");

  return {
    type: "result",
    subtype: "success",
    result: JSON.stringify({ status: "DRY_RUN", message: "No SDK call made." }),
    total_cost_usd: 0,
    session_id: `dry-run-${Date.now()}`,
    is_error: false,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    modelUsage: {},
    permission_denials: [],
    stop_reason: "end_turn",
    usage: {},
    uuid: "dry-run",
  } as unknown as SDKResultMessage;
}

/**
 * Run a query() with automatic session recovery.
 * On failure: resume the same session (attempt 2), then fresh session (attempt 3).
 * After maxRetries, throws and escalates.
 *
 * Set DRY_RUN=true to log prompt/options without calling the SDK.
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
  if (process.env.DRY_RUN === "true") {
    const mock = dryRunResult(pipeline, prompt, options);
    callbacks?.onSessionId?.(mock.session_id);
    callbacks?.onCostRecord?.(mock);
    return mock;
  }

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

        // Log important SDK events for debugging
        if (lastSessionId) {
          logSdkMessage(pipeline, lastSessionId, message);
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
