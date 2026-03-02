import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { appendEvent } from "./event-journal.js";
import { forwardAgentNotification } from "./callback.js";
import { logger } from "./logger.js";

// ─── Audit logger (async, non-blocking) ────────────────────────
const auditLogger: HookCallback = async (input): Promise<HookJSONOutput> => {
  const toolName =
    "tool_name" in input ? (input.tool_name as string) : undefined;

  appendEvent("dispatch.started", {
    sessionId: input.session_id,
    metadata: {
      hookEvent: input.hook_event_name,
      ...(toolName && { toolName }),
    },
  }).catch((err: unknown) =>
    logger.error("Failed to write audit event", err),
  );

  return { async: true as const, asyncTimeout: 5_000 };
};

// ─── Notification forwarder (→ OpenClaw via callback) ─────────
const notificationForwarder: HookCallback = async (input): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "Notification") return {};
  logger.info(`Agent notification: ${input.message}`);
  forwardAgentNotification(input.session_id, input.message);
  return { async: true as const, asyncTimeout: 10_000 };
};

// ─── Export hook configuration ─────────────────────────────────
export const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
  PreToolUse: [{ hooks: [auditLogger] }],
  PostToolUse: [{ hooks: [auditLogger] }],
  Notification: [{ hooks: [notificationForwarder] }],
};

// Re-export individual hooks for testing
export { auditLogger, notificationForwarder };
