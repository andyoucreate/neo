import { z } from "zod";
import type { ToolDefinition } from "./supervisor-tools.js";

// ─── Schema ──────────────────────────────────────────────

export const spawnChildSupervisorInputSchema = z.object({
  objective: z.string().min(1, "Objective is required"),
  acceptanceCriteria: z.array(z.string()).min(1, "At least one acceptance criterion required"),
  maxCostUsd: z.number().positive().optional(),
});

export type SpawnChildSupervisorInput = z.infer<typeof spawnChildSupervisorInputSchema>;

// ─── Tool Definition ─────────────────────────────────────

export const SPAWN_CHILD_SUPERVISOR_TOOL: ToolDefinition = {
  name: "spawn_child_supervisor",
  description:
    "Spawn a focused child supervisor to handle a specific objective autonomously. " +
    "Use this when a task is complex enough to warrant independent orchestration. " +
    "The child runs until all acceptance criteria are met or it gets blocked.",
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "The specific goal for the child supervisor to achieve",
      },
      acceptanceCriteria: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Measurable criteria that define completion",
      },
      maxCostUsd: {
        type: "number",
        description: "Optional budget cap in USD. Child is stopped if exceeded.",
      },
    },
    required: ["objective", "acceptanceCriteria"],
  },
};
