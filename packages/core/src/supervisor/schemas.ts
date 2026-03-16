import { z } from "zod";

// ─── Wake reason (why daemon woke from idle) ─────────────

export const wakeReasonSchema = z.enum(["events", "timer", "active_runs", "forced"]);

export type WakeReason = z.infer<typeof wakeReasonSchema>;

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
  activeWorkSkipCount: z.number().default(0),
  status: z.enum(["running", "draining", "stopped"]).default("running"),
  lastConsolidationHeartbeat: z.number().default(0),
  lastCompactionHeartbeat: z.number().default(0),
  lastConsolidationTimestamp: z.string().optional(),
  wakeReason: wakeReasonSchema.optional(),
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
  from: z.enum(["tui", "api", "external", "agent"]),
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

// ─── Log buffer entry (written by neo log, read by heartbeat) ──

export const logBufferEntrySchema = z.object({
  id: z.string(),
  type: z.enum(["progress", "action", "decision", "blocker", "milestone", "discovery"]),
  message: z.string(),
  agent: z.string().optional(),
  runId: z.string().optional(),
  repo: z.string().optional(),
  target: z.enum(["memory", "knowledge", "digest"]),
  timestamp: z.string(),
  consolidatedAt: z.string().optional(),
});

export type LogBufferEntry = z.infer<typeof logBufferEntrySchema>;

// ─── Internal event kinds (timer-based, not external) ────

export const internalEventKindSchema = z.enum(["consolidation_timer", "active_run_check"]);

export type InternalEventKind = z.infer<typeof internalEventKindSchema>;

// ─── Queued event (union of all event sources) ──────────

export type QueuedEvent =
  | { kind: "webhook"; data: WebhookIncomingEvent }
  | { kind: "message"; data: InboxMessage }
  | { kind: "run_complete"; runId: string; timestamp: string }
  | { kind: "internal"; eventKind: InternalEventKind; timestamp: string };

// ─── Run notes (per-run narrative tracking) ──────────────

export const runNoteSchema = z.object({
  type: z.enum(["decision", "observation", "blocker", "outcome"]),
  text: z.string(),
  ts: z.string(), // ISO timestamp
});

export type RunNote = z.infer<typeof runNoteSchema>;
