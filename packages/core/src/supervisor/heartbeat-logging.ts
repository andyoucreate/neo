import {
  isAssistantMessage,
  isToolResultMessage,
  isToolUseMessage,
  type SDKStreamMessage,
} from "@/sdk-types";
import type { ActivityLog } from "./activity-log.js";
import {
  type HeartbeatEvent,
  heartbeatEventSchema,
  type RunCompletedEvent,
  type RunDispatchedEvent,
  runCompletedEventSchema,
  runDispatchedEventSchema,
  type SupervisorStartedEvent,
  type SupervisorStoppedEvent,
  type SupervisorWebhookEvent,
  supervisorStartedEventSchema,
  supervisorStoppedEventSchema,
} from "./webhookEvents.js";

/** Callback for emitting webhook events */
export type WebhookEventEmitter = (event: SupervisorWebhookEvent) => void | Promise<void>;

/**
 * Route a single SDK stream message to the appropriate log handler.
 */
export async function logStreamMessage(
  msg: SDKStreamMessage,
  heartbeatId: string,
  activityLog: ActivityLog,
  emitRunDispatched: (opts: {
    runId: string;
    agent: string;
    repo: string;
    branch: string;
    prompt: string;
  }) => Promise<void>,
): Promise<void> {
  if (isAssistantMessage(msg)) {
    await logContentBlocks(msg, heartbeatId, activityLog);
  } else if (isToolUseMessage(msg)) {
    await logToolUse(msg, heartbeatId, activityLog);
  } else if (isToolResultMessage(msg)) {
    await logToolResult(msg, heartbeatId, activityLog, emitRunDispatched);
  }
}

/**
 * Log thinking and plan blocks from assistant content — no truncation.
 */
async function logContentBlocks(
  msg: SDKStreamMessage,
  heartbeatId: string,
  activityLog: ActivityLog,
): Promise<void> {
  if (!isAssistantMessage(msg)) return;
  const content = msg.message?.content;
  if (!content) return;

  for (const block of content) {
    if (block.type === "thinking" && block.thinking) {
      await activityLog.log("thinking", block.thinking, { heartbeatId });
    }
    if (block.type === "text" && block.text) {
      await activityLog.log("plan", block.text, { heartbeatId });
      break; // Only log first text block per message
    }
  }
}

/**
 * Log tool use events — distinguish MCP tools from built-in tools.
 */
async function logToolUse(
  msg: SDKStreamMessage,
  heartbeatId: string,
  activityLog: ActivityLog,
): Promise<void> {
  if (!isToolUseMessage(msg)) return;
  const toolName = msg.tool;
  const isMcp = toolName.startsWith("mcp__");
  await activityLog.log(isMcp ? "tool_use" : "action", isMcp ? toolName : `Tool use: ${toolName}`, {
    heartbeatId,
    tool: toolName,
    input: msg.input,
  });
}

/**
 * Detect agent dispatches from bash tool results.
 */
async function logToolResult(
  msg: SDKStreamMessage,
  heartbeatId: string,
  activityLog: ActivityLog,
  emitRunDispatched: (opts: {
    runId: string;
    agent: string;
    repo: string;
    branch: string;
    prompt: string;
  }) => Promise<void>,
): Promise<void> {
  if (!isToolResultMessage(msg)) return;
  const result = msg.result ?? "";
  const runMatch = /Run\s+(\S+)\s+dispatched/i.exec(result);
  const runId = runMatch?.[1];
  if (runId) {
    await activityLog.log("dispatch", `Agent dispatched: ${runId}`, {
      heartbeatId,
      runId,
    });

    // Emit run dispatched webhook event
    // Extract additional info from the result if available.
    //
    // Expected tool result formats from `neo run` command output:
    //   - "Run <runId> dispatched"
    //   - "agent: <name>" or "Agent: <name>" or "agent <name>"
    //   - "repo: <path>" or "Repo: <path>" or "repo <path>"
    //   - "branch: <name>" or "Branch: <name>" or "branch <name>"
    //
    // These patterns are best-effort extraction. If the format changes,
    // values will default to "unknown" without breaking the event emission.
    const agentMatch = /agent[:\s]+(\S+)/i.exec(result);
    const repoMatch = /repo[:\s]+(\S+)/i.exec(result);
    const branchMatch = /branch[:\s]+(\S+)/i.exec(result);

    const agent = agentMatch?.[1] ?? "unknown";
    const repo = repoMatch?.[1] ?? "unknown";
    const branch = branchMatch?.[1] ?? "unknown";

    await emitRunDispatched({
      runId,
      agent,
      repo,
      branch,
      prompt: result.slice(0, 500),
    });
  }
}

// ─── Webhook event emission ───────────────────────────────

/**
 * Emit a webhook event if a callback is configured.
 * Validates the event against its schema before emission.
 */
export async function emitWebhookEvent(
  event: SupervisorWebhookEvent,
  onWebhookEvent: WebhookEventEmitter | undefined,
  activityLog: ActivityLog,
): Promise<void> {
  if (!onWebhookEvent) return;

  try {
    // Validate event against schema before emission
    switch (event.type) {
      case "supervisor_started":
        supervisorStartedEventSchema.parse(event);
        break;
      case "heartbeat":
        heartbeatEventSchema.parse(event);
        break;
      case "run_dispatched":
        runDispatchedEventSchema.parse(event);
        break;
      case "run_completed":
        runCompletedEventSchema.parse(event);
        break;
      case "supervisor_stopped":
        supervisorStoppedEventSchema.parse(event);
        break;
    }

    await onWebhookEvent(event);
  } catch (error) {
    // Log validation/emission errors but don't fail the heartbeat
    const msg = error instanceof Error ? error.message : String(error);
    await activityLog.log("error", `Webhook event emission failed: ${msg}`, {
      eventType: event.type,
    });
  }
}

/**
 * Emit SupervisorStartedEvent
 */
export async function emitSupervisorStarted(
  sessionId: string,
  onWebhookEvent: WebhookEventEmitter | undefined,
  activityLog: ActivityLog,
): Promise<void> {
  const event: SupervisorStartedEvent = {
    type: "supervisor_started",
    supervisorId: sessionId,
    startedAt: new Date().toISOString(),
  };
  await emitWebhookEvent(event, onWebhookEvent, activityLog);
}

/**
 * Emit SupervisorStoppedEvent
 */
export async function emitSupervisorStopped(
  sessionId: string,
  reason: "shutdown" | "budget_exceeded" | "error" | "manual",
  onWebhookEvent: WebhookEventEmitter | undefined,
  activityLog: ActivityLog,
): Promise<void> {
  const event: SupervisorStoppedEvent = {
    type: "supervisor_stopped",
    supervisorId: sessionId,
    stoppedAt: new Date().toISOString(),
    reason,
  };
  await emitWebhookEvent(event, onWebhookEvent, activityLog);
}

/**
 * Emit HeartbeatEvent
 */
export async function emitHeartbeatCompleted(
  sessionId: string,
  opts: {
    heartbeatNumber: number;
    runsActive: number;
    todayUsd: number;
    limitUsd: number;
  },
  onWebhookEvent: WebhookEventEmitter | undefined,
  activityLog: ActivityLog,
): Promise<void> {
  const event: HeartbeatEvent = {
    type: "heartbeat",
    supervisorId: sessionId,
    heartbeatNumber: opts.heartbeatNumber,
    timestamp: new Date().toISOString(),
    runsActive: opts.runsActive,
    budget: {
      todayUsd: opts.todayUsd,
      limitUsd: opts.limitUsd,
    },
  };
  await emitWebhookEvent(event, onWebhookEvent, activityLog);
}

/**
 * Emit RunDispatchedEvent from tool result detection
 */
export async function emitRunDispatchedEvent(
  sessionId: string,
  opts: {
    runId: string;
    agent: string;
    repo: string;
    branch: string;
    prompt: string;
  },
  onWebhookEvent: WebhookEventEmitter | undefined,
  activityLog: ActivityLog,
): Promise<void> {
  const event: RunDispatchedEvent = {
    type: "run_dispatched",
    supervisorId: sessionId,
    runId: opts.runId,
    agent: opts.agent,
    repo: opts.repo,
    branch: opts.branch,
    prompt: opts.prompt.slice(0, 500), // Truncate to schema max
  };
  await emitWebhookEvent(event, onWebhookEvent, activityLog);
}

/**
 * Emit RunCompletedEvent when processing run_complete events
 */
export async function emitRunCompletedEvent(
  sessionId: string,
  opts: {
    runId: string;
    status: "completed" | "failed" | "cancelled";
    output?: string;
    costUsd: number;
    durationMs: number;
  },
  onWebhookEvent: WebhookEventEmitter | undefined,
  activityLog: ActivityLog,
): Promise<void> {
  const event: RunCompletedEvent = {
    type: "run_completed",
    supervisorId: sessionId,
    runId: opts.runId,
    status: opts.status,
    output: opts.output?.slice(0, 1000), // Truncate to schema max
    costUsd: opts.costUsd,
    durationMs: opts.durationMs,
  };
  await emitWebhookEvent(event, onWebhookEvent, activityLog);
}
