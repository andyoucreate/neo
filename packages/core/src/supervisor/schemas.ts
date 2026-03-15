import { z } from "zod";

// ─── Daemon state (persisted in state.json) ──────────────

export const supervisorDaemonStateSchema = z.object({
  pid: z.number(),
  sessionId: z.string(),
  port: z.number(),
  cwd: z.string(),
  startedAt: z.string(),
  lastHeartbeat: z.string().optional(),
  heartbeatCount: z.number().default(0),
  totalCostUsd: z.number().default(0),
  todayCostUsd: z.number().default(0),
  costResetDate: z.string().optional(),
  idleSkipCount: z.number().default(0),
  status: z.enum(["running", "draining", "stopped"]).default("running"),
});

export type SupervisorDaemonState = z.infer<typeof supervisorDaemonStateSchema>;

// ─── Incoming webhook event ──────────────────────────────

export const webhookIncomingEventSchema = z.object({
  id: z.string().optional(),
  source: z.string().optional(),
  event: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  receivedAt: z.string(),
  processedAt: z.string().optional(),
});

export type WebhookIncomingEvent = z.infer<typeof webhookIncomingEventSchema>;

// ─── TUI / external inbox message ───────────────────────

export const inboxMessageSchema = z.object({
  id: z.string(),
  from: z.enum(["tui", "api", "external"]),
  text: z.string(),
  timestamp: z.string(),
  processedAt: z.string().optional(),
});

export type InboxMessage = z.infer<typeof inboxMessageSchema>;

// ─── Activity log entry ─────────────────────────────────

export const activityEntrySchema = z.object({
  id: z.string(),
  type: z.enum([
    "heartbeat",
    "decision",
    "action",
    "error",
    "event",
    "message",
    "thinking",
    "plan",
    "dispatch",
    "tool_use",
  ]),
  summary: z.string(),
  detail: z.unknown().optional(),
  timestamp: z.string(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

// ─── Queued event (union of all event sources) ──────────

export type QueuedEvent =
  | { kind: "webhook"; data: WebhookIncomingEvent }
  | { kind: "message"; data: InboxMessage }
  | { kind: "run_complete"; runId: string; timestamp: string };
