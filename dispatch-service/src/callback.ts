import { logger } from "./logger.js";
import type {
  CallbackPayload,
  PipelineResult,
  ServiceEventData,
  SubTicket,
} from "./types.js";

const CALLBACK_URL =
  process.env.CALLBACK_URL ||
  "http://127.0.0.1:18789/hooks/dispatch-result";
const CALLBACK_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN_DISPATCH || "";
const CALLBACK_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRIES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a callback event to OpenClaw.
 * Non-blocking — errors are logged but never thrown.
 * Retries once after 5s on failure.
 */
export async function sendCallback(
  payload: CallbackPayload,
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (CALLBACK_TOKEN) {
        headers["Authorization"] = `Bearer ${CALLBACK_TOKEN}`;
      }

      const response = await fetch(CALLBACK_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });

      if (response.ok) {
        return true;
      }

      logger.warn(
        `Callback failed: HTTP ${String(response.status)} (attempt ${String(attempt + 1)})`,
      );
    } catch (error) {
      logger.warn(`Callback failed (attempt ${String(attempt + 1)})`, {
        error,
      });
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  logger.error(
    `Callback to ${CALLBACK_URL} failed after ${String(MAX_RETRIES + 1)} attempts`,
  );
  return false;
}

/**
 * Notify OpenClaw that a pipeline completed or failed.
 * Non-blocking wrapper around sendCallback.
 */
export function notifyPipelineResult(result: PipelineResult): void {
  const event =
    result.status === "success" ? "pipeline.completed" : "pipeline.failed";
  sendCallback({
    event,
    timestamp: new Date().toISOString(),
    data: result,
  }).catch((err: unknown) => logger.error("Failed to notify pipeline result", err));
}

/**
 * Notify OpenClaw of a service lifecycle event.
 * Non-blocking wrapper around sendCallback.
 */
export function notifyServiceLifecycle(
  action: "started" | "stopped",
  details: Omit<ServiceEventData, "action">,
): void {
  sendCallback({
    event: action === "started" ? "service.started" : "service.stopped",
    timestamp: new Date().toISOString(),
    data: { action, ...details },
  }).catch((err: unknown) => logger.error("Failed to notify service lifecycle", err));
}

/**
 * Notify OpenClaw of sub-tickets produced by the refine pipeline.
 * Sends a dedicated callback so OpenClaw can create them as real entries.
 */
export function notifySubTickets(
  ticketId: string,
  subTickets: SubTicket[],
): void {
  sendCallback({
    event: "refine.subtasks",
    timestamp: new Date().toISOString(),
    data: { ticketId, subTickets },
  }).catch((err: unknown) => logger.error("Failed to notify sub-tickets", err));
}

/**
 * Forward an agent notification to OpenClaw.
 * Used by the notification forwarder hook.
 */
export function forwardAgentNotification(
  sessionId: string,
  message: string,
): void {
  sendCallback({
    event: "agent.notification",
    timestamp: new Date().toISOString(),
    data: { sessionId, message },
  }).catch((err: unknown) => logger.error("Failed to forward agent notification", err));
}
