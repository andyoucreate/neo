import { z } from "zod";

// ─── Supervisor started event ────────────────────────────

export const supervisorStartedEventSchema = z.object({
  type: z.literal("supervisor_started"),
  supervisorId: z.string(),
  startedAt: z.string().datetime(),
});

export type SupervisorStartedEvent = z.infer<typeof supervisorStartedEventSchema>;

// ─── Heartbeat event ─────────────────────────────────────

export const heartbeatEventSchema = z.object({
  type: z.literal("heartbeat"),
  supervisorId: z.string(),
  heartbeatNumber: z.number().int().min(0),
  timestamp: z.string().datetime(),
  runsActive: z.number().int().min(0),
  budget: z.object({
    todayUsd: z.number().min(0),
    limitUsd: z.number().min(0),
  }),
});

export type HeartbeatEvent = z.infer<typeof heartbeatEventSchema>;

// ─── Run dispatched event ────────────────────────────────

export const runDispatchedEventSchema = z.object({
  type: z.literal("run_dispatched"),
  supervisorId: z.string(),
  runId: z.string(),
  agent: z.string(),
  repo: z.string(),
  branch: z.string(),
  prompt: z.string().max(500), // truncated
});

export type RunDispatchedEvent = z.infer<typeof runDispatchedEventSchema>;

// ─── Run completed event ─────────────────────────────────

export const runCompletedEventSchema = z.object({
  type: z.literal("run_completed"),
  supervisorId: z.string(),
  runId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  output: z.string().max(1000).optional(), // truncated
  costUsd: z.number().min(0),
  durationMs: z.number().int().min(0),
});

export type RunCompletedEvent = z.infer<typeof runCompletedEventSchema>;

// ─── Heartbeat failure event ─────────────────────────────

export const heartbeatFailureEventSchema = z.object({
  type: z.literal("heartbeat_failure"),
  supervisorId: z.string(),
  heartbeatId: z.string(),
  timestamp: z.string().datetime(),
  error: z.string().max(1000),
  consecutiveFailures: z.number().int().min(1),
});

export type HeartbeatFailureEvent = z.infer<typeof heartbeatFailureEventSchema>;

// ─── Ghost run recovered event ────────────────────────────

export const ghostRunRecoveredEventSchema = z.object({
  type: z.literal("ghost_run_recovered"),
  supervisorId: z.string(),
  runId: z.string(),
  agent: z.string(),
  repo: z.string(),
  timestamp: z.string().datetime(),
  reason: z.literal("supervisor crashed"),
});

export type GhostRunRecoveredEvent = z.infer<typeof ghostRunRecoveredEventSchema>;

// ─── Supervisor stopped event ────────────────────────────

export const supervisorStoppedEventSchema = z.object({
  type: z.literal("supervisor_stopped"),
  supervisorId: z.string(),
  stoppedAt: z.string().datetime(),
  reason: z.enum(["shutdown", "budget_exceeded", "error", "manual"]),
});

export type SupervisorStoppedEvent = z.infer<typeof supervisorStoppedEventSchema>;

// ─── Union of all webhook events ─────────────────────────

export const supervisorWebhookEventSchema = z.discriminatedUnion("type", [
  supervisorStartedEventSchema,
  heartbeatEventSchema,
  heartbeatFailureEventSchema,
  runDispatchedEventSchema,
  runCompletedEventSchema,
  ghostRunRecoveredEventSchema,
  supervisorStoppedEventSchema,
]);

export type SupervisorWebhookEvent = z.infer<typeof supervisorWebhookEventSchema>;
