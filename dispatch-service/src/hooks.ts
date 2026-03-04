import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { appendEvent } from "./event-journal.js";
import { forwardAgentNotification } from "./callback.js";
import { LOOP_DETECTION_THRESHOLD } from "./config.js";
import { logger } from "./logger.js";

// ─── Audit logger (async, non-blocking) ────────────────────────
const auditLogger: HookCallback = async (input): Promise<HookJSONOutput> => {
  const toolName =
    "tool_name" in input ? input.tool_name : undefined;

  appendEvent("tool.invoked", {
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

// ─── Loop detector ───────────────────────────────────────────────
// Tracks repeated Bash commands per session. If an identical command
// is executed LOOP_DETECTION_THRESHOLD+ times, blocks it and tells
// the agent to escalate.
const commandHistory = new Map<string, Map<string, number>>();

const loopDetector: HookCallback = async (input): Promise<HookJSONOutput> => {
  const toolName =
    "tool_name" in input ? input.tool_name : undefined;
  if (toolName !== "Bash") return {};

  const sessionId = input.session_id;
  const command =
    "tool_input" in input && input.tool_input && typeof input.tool_input === "object" && "command" in input.tool_input
      ? String(input.tool_input.command)
      : "";
  if (!command) return {};

  if (!commandHistory.has(sessionId)) {
    commandHistory.set(sessionId, new Map());
  }
  const sessionHistory = commandHistory.get(sessionId) ?? new Map<string, number>();
  const count = (sessionHistory.get(command) ?? 0) + 1;
  sessionHistory.set(command, count);

  if (count >= LOOP_DETECTION_THRESHOLD) {
    logger.warn(
      `[loop-guard] Session ${sessionId} repeated command ${String(count)}x: ${command.slice(0, 120)}`,
    );
    return {
      decision: "block",
      reason: `Loop detected: you have run this exact command ${String(count)} times. STOP and escalate — do not retry the same approach.`,
    };
  }

  return {};
};

/**
 * Clear loop history for a session (called on cleanup).
 */
export function clearLoopHistory(sessionId: string): void {
  commandHistory.delete(sessionId);
}

// ─── Export hook configuration ─────────────────────────────────
export const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
  PreToolUse: [
    { hooks: [auditLogger] },
    { matcher: "Bash", hooks: [loopDetector] },
  ],
  PostToolUse: [{ hooks: [auditLogger] }],
  Notification: [{ hooks: [notificationForwarder] }],
};

// Re-export individual hooks for testing
export { auditLogger, loopDetector, notificationForwarder };
