import { z } from "zod";

/**
 * Built-in child supervisor types.
 * - cleanup: maintenance tasks (lint, tests, dead code removal)
 * - custom: user-defined supervisor with custom instructions
 */
export const childSupervisorTypeSchema = z.enum(["cleanup", "custom"]);

export type ChildSupervisorType = z.infer<typeof childSupervisorTypeSchema>;

/**
 * Budget configuration for a child supervisor.
 */
export const childSupervisorBudgetSchema = z
  .object({
    /** Daily spending cap in USD */
    dailyCapUsd: z.number().min(0).default(10),
    /** Max cost per individual task in USD */
    maxCostPerTaskUsd: z.number().min(0).default(1),
  })
  .default({ dailyCapUsd: 10, maxCostPerTaskUsd: 1 });

export type ChildSupervisorBudget = z.infer<typeof childSupervisorBudgetSchema>;

/**
 * Configuration for a child supervisor instance.
 * Stored in ~/.neo/config.yml under childSupervisors array.
 */
export const childSupervisorConfigSchema = z.object({
  /** Unique name for this supervisor instance */
  name: z.string().min(1),
  /** Type of supervisor (determines instructions and behavior) */
  type: childSupervisorTypeSchema,
  /** Repository path this supervisor operates on */
  repo: z.string().min(1),
  /** Whether the supervisor is enabled */
  enabled: z.boolean().default(true),
  /** Budget configuration */
  budget: childSupervisorBudgetSchema,
  /** How often the child reports health to parent (ms) */
  heartbeatIntervalMs: z.number().min(10_000).default(60_000),
  /** Whether to start this supervisor automatically with the main supervisor */
  autoStart: z.boolean().default(true),
  /** Custom objective (overrides type default) */
  objective: z.string().optional(),
  /** Custom acceptance criteria (overrides type default) */
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Custom instructions path (overrides type default) */
  instructionsPath: z.string().optional(),
});

export type ChildSupervisorConfig = z.infer<typeof childSupervisorConfigSchema>;
