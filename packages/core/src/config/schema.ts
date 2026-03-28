import { z } from "zod";
import { childSupervisorConfigSchema } from "./child-supervisor-schema.js";

// ─── McpServerConfig schemas ─────────────────────────────

const httpMcpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const stdioMcpServerSchema = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const mcpServerConfigSchema = z.discriminatedUnion("type", [
  httpMcpServerSchema,
  stdioMcpServerSchema,
]);

// ─── RepoConfig schema (single repo entry) ──────────────

export const gitStrategySchema = z.enum(["pr", "branch"]).default("branch");

export type GitStrategy = z.infer<typeof gitStrategySchema>;

export const repoConfigSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  defaultBranch: z.string().default("main"),
  branchPrefix: z.string().default("feat"),
  pushRemote: z.string().default("origin"),
  gitStrategy: gitStrategySchema,
});

// ─── Concurrency config schema ───────────────────────────

export const concurrencyConfigSchema = z
  .object({
    maxSessions: z.number().default(5),
    maxPerRepo: z.number().default(4),
    queueMax: z.number().default(50),
  })
  .default({ maxSessions: 5, maxPerRepo: 4, queueMax: 50 });

// ─── Budget config schema ────────────────────────────────

export const budgetConfigSchema = z
  .object({
    dailyCapUsd: z.number().default(500),
    alertThresholdPct: z.number().default(80),
  })
  .default({ dailyCapUsd: 500, alertThresholdPct: 80 });

// ─── Recovery config schema ──────────────────────────────

export const recoveryConfigSchema = z
  .object({
    maxRetries: z.number().default(3),
    backoffBaseMs: z.number().default(30_000),
  })
  .default({ maxRetries: 3, backoffBaseMs: 30_000 });

// ─── Sessions config schema ──────────────────────────────

export const sessionsConfigSchema = z
  .object({
    initTimeoutMs: z.number().default(120_000),
    maxDurationMs: z.number().default(3_600_000),
    dir: z.string().default("/tmp/neo-sessions"),
  })
  .default({ initTimeoutMs: 120_000, maxDurationMs: 3_600_000, dir: "/tmp/neo-sessions" });

// ─── Journal config schema ───────────────────────────────

export const journalConfigSchema = z
  .object({
    maxCostJournalSizeBytes: z.number().default(100 * 1024 * 1024), // 100MB
    maxEventJournalSizeBytes: z.number().default(500 * 1024 * 1024), // 500MB
  })
  .default({
    maxCostJournalSizeBytes: 100 * 1024 * 1024,
    maxEventJournalSizeBytes: 500 * 1024 * 1024,
  });

// ─── Supervisor config schema ────────────────────────────

export const supervisorConfigSchema = z
  .object({
    port: z.number().default(7777),
    secret: z.string().optional(),
    heartbeatTimeoutMs: z.number().default(300_000),
    maxConsecutiveFailures: z.number().default(3),
    maxEventsPerSec: z.number().default(10),
    dailyCapUsd: z.number().default(50),
    /** How often consolidation runs (ms) */
    consolidationIntervalMs: z.number().default(300_000),
    /** How often compaction runs (ms) */
    compactionIntervalMs: z.number().default(3_600_000),
    /** Safety timeout for waitForWork (ms) */
    eventTimeoutMs: z.number().default(300_000),
    instructions: z.string().optional(),
    /** Max consecutive idle loop iterations before supervisor pauses polling */
    idleSkipMax: z.number().default(20),
    /** Max consecutive active-work loop iterations before supervisor yields */
    activeWorkSkipMax: z.number().default(3),
    /** When true, supervisor answers pending decisions autonomously instead of waiting for human input */
    autoDecide: z.boolean().default(false),
  })
  .default({
    port: 7777,
    heartbeatTimeoutMs: 300_000,
    maxConsecutiveFailures: 3,
    maxEventsPerSec: 10,
    dailyCapUsd: 50,
    consolidationIntervalMs: 300_000,
    compactionIntervalMs: 3_600_000,
    eventTimeoutMs: 300_000,
    idleSkipMax: 20,
    activeWorkSkipMax: 3,
    autoDecide: false,
  });

// ─── Global config schema (~/.neo/config.yml) ───────────
// This is now the single source of truth — repos are registered here.

export const globalConfigSchema = z.object({
  repos: z.array(repoConfigSchema).default([]),

  concurrency: concurrencyConfigSchema,

  budget: budgetConfigSchema,

  recovery: recoveryConfigSchema,

  sessions: sessionsConfigSchema,

  journal: journalConfigSchema.optional(),

  webhooks: z
    .array(
      z.object({
        url: z.string().url(),
        events: z.array(z.string()).optional(),
        secret: z.string().optional(),
        timeoutMs: z.number().default(5000),
      }),
    )
    .default([]),

  supervisor: supervisorConfigSchema,

  memory: z
    .object({
      embeddings: z.boolean().default(true),
    })
    .default({ embeddings: true }),

  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  claudeCodePath: z.string().optional(),

  childSupervisors: z.array(childSupervisorConfigSchema).default([]),

  idempotency: z
    .object({
      enabled: z.boolean().default(true),
      key: z.enum(["metadata", "prompt"]).default("metadata"),
      ttlMs: z.number().default(3_600_000),
    })
    .optional(),
});

// ─── NeoConfig = GlobalConfig (single schema now) ────────

export const neoConfigSchema = globalConfigSchema;

// ─── Repo override config schema ─────────────────────────
// Partial subset for repo-level overrides.
// Only allows: concurrency, budget, recovery, sessions keys.

export const repoOverrideConfigSchema = z
  .object({
    concurrency: concurrencyConfigSchema.unwrap().partial().optional(),
    budget: budgetConfigSchema.unwrap().partial().optional(),
    recovery: recoveryConfigSchema.unwrap().partial().optional(),
    sessions: sessionsConfigSchema.unwrap().partial().optional(),
  })
  .partial();

// ─── Derived types ───────────────────────────────────────

export type NeoConfig = z.infer<typeof neoConfigSchema>;
export type GlobalConfig = NeoConfig;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type RepoConfigInput = z.input<typeof repoConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type RepoOverrideConfig = z.infer<typeof repoOverrideConfigSchema>;
