import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

// ─── RepoConfig schema ──────────────────────────────────

export const repoConfigSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  defaultBranch: z.string().default("main"),
  branchPrefix: z.string().default("feat"),
  pushRemote: z.string().default("origin"),
  autoCreatePr: z.boolean().default(false),
  prBaseBranch: z.string().optional(),
});

// ─── NeoConfig schema ───────────────────────────────────

export const neoConfigSchema = z.object({
  repos: z.array(repoConfigSchema).min(1, "At least one repo is required"),

  concurrency: z
    .object({
      maxSessions: z.number().default(5),
      maxPerRepo: z.number().default(2),
      queueMax: z.number().default(50),
    })
    .default({ maxSessions: 5, maxPerRepo: 2, queueMax: 50 }),

  budget: z
    .object({
      dailyCapUsd: z.number().default(500),
      alertThresholdPct: z.number().default(80),
    })
    .default({ dailyCapUsd: 500, alertThresholdPct: 80 }),

  recovery: z
    .object({
      maxRetries: z.number().default(3),
      backoffBaseMs: z.number().default(30_000),
    })
    .default({ maxRetries: 3, backoffBaseMs: 30_000 }),

  sessions: z
    .object({
      initTimeoutMs: z.number().default(120_000),
      maxDurationMs: z.number().default(3_600_000),
    })
    .default({ initTimeoutMs: 120_000, maxDurationMs: 3_600_000 }),

  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  claudeCodePath: z.string().optional(),

  idempotency: z
    .object({
      enabled: z.boolean().default(true),
      key: z.enum(["metadata", "prompt"]).default("metadata"),
      ttlMs: z.number().default(3_600_000),
    })
    .optional(),
});

// ─── Derived types ───────────────────────────────────────

export type NeoConfig = z.infer<typeof neoConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

// ─── Config loader ───────────────────────────────────────

export async function loadConfig(configPath: string): Promise<NeoConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `Config file not found: ${configPath}. Create a .neo/config.yml file to get started.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = neoConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }

  return result.data;
}
