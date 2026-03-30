import { z } from "zod";

// ─── Mission priority ───────────────────────────────────

export const missionPrioritySchema = z.enum(["low", "normal", "high", "critical"]);

export type MissionPriority = z.infer<typeof missionPrioritySchema>;

// ─── Mission status ─────────────────────────────────────

export const missionStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export type MissionStatus = z.infer<typeof missionStatusSchema>;

// ─── Mission request (input from user or API) ──────────

export const missionRequestSchema = z.object({
  id: z.string(),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  maxCostUsd: z.number().min(0).optional(),
  priority: missionPrioritySchema.default("normal"),
  createdAt: z.string(),
  /** Optional target supervisor profile (default: "default") */
  targetProfile: z.string().optional(),
  /** Optional context from parent mission */
  parentMissionId: z.string().optional(),
});

export type MissionRequest = z.infer<typeof missionRequestSchema>;

// ─── Mission run (execution state) ─────────────────────

export const missionRunSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  status: missionStatusSchema,
  supervisorProfile: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  costUsd: z.number().default(0),
  /** IDs of agent runs dispatched by this mission */
  runIds: z.array(z.string()).default([]),
  /** Evidence of completion (for verification) */
  evidence: z.array(z.string()).optional(),
  /** Reason for failure or block */
  failureReason: z.string().optional(),
  /** Last activity timestamp */
  lastActivityAt: z.string().optional(),
});

export type MissionRun = z.infer<typeof missionRunSchema>;

// ─── Supervisor profile (runtime personality) ──────────

export const supervisorProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** When true, supervisor answers decisions autonomously */
  autoDecide: z.boolean().default(false),
  /** Max concurrent agent runs */
  maxConcurrentRuns: z.number().int().min(1).default(3),
  /** Budget cap per mission (overrides mission.maxCostUsd if lower) */
  budgetCapUsd: z.number().min(0).optional(),
  /** Custom instructions appended to supervisor prompt */
  customInstructions: z.string().optional(),
});

export type SupervisorProfile = z.infer<typeof supervisorProfileSchema>;
