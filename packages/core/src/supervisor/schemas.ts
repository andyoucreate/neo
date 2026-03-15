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
  lastConsolidationHeartbeat: z.number().default(0),
  lastCompactionHeartbeat: z.number().default(0),
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

// ─── Memory delta operations ────────────────────────────

export const memoryOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("append"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string(), index: z.number() }),
]);

export type MemoryOp = z.infer<typeof memoryOpSchema>;

// ─── Knowledge delta operations ─────────────────────────

export const knowledgeOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("append"),
    section: z.string(),
    fact: z.string(),
    source: z.string().optional(),
    date: z.string().optional(),
  }),
  z.object({ op: z.literal("remove"), section: z.string(), index: z.number() }),
]);

export type KnowledgeOp = z.infer<typeof knowledgeOpSchema>;

// ─── Run note (persisted in per-run JSONL files) ────────

export const runNoteSchema = z.object({
  type: z.enum(["blocker", "decision", "observation", "progress"]),
  content: z.string(),
  timestamp: z.string(), // ISO8601
  metadata: z
    .object({
      ticketId: z.string().optional(),
      prNumber: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

export type RunNote = z.infer<typeof runNoteSchema>;

// ─── Queued event (union of all event sources) ──────────

export type QueuedEvent =
  | { kind: "webhook"; data: WebhookIncomingEvent }
  | { kind: "message"; data: InboxMessage }
  | { kind: "run_complete"; runId: string; timestamp: string };
