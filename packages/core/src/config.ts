import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { getDataDir } from "@/paths";

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

export const repoConfigSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  defaultBranch: z.string().default("main"),
  branchPrefix: z.string().default("feat"),
  pushRemote: z.string().default("origin"),
  autoCreatePr: z.boolean().default(false),
  prBaseBranch: z.string().optional(),
});

// ─── Global config schema (~/.neo/config.yml) ───────────

export const globalConfigSchema = z.object({
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

// ─── Repo project config schema (.neo/config.yml) ───────

export const repoProjectConfigSchema = z.object({
  repos: z.array(repoConfigSchema).min(1, "At least one repo is required"),
});

// ─── Combined NeoConfig (what the Orchestrator receives) ─

export const neoConfigSchema = globalConfigSchema.merge(repoProjectConfigSchema);

// ─── Derived types ───────────────────────────────────────

export type NeoConfig = z.infer<typeof neoConfigSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type RepoProjectConfig = z.infer<typeof repoProjectConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

// ─── Default global config ──────────────────────────────

const DEFAULT_GLOBAL_CONFIG = {
  concurrency: {
    maxSessions: 5,
    maxPerRepo: 2,
    queueMax: 50,
  },
  budget: {
    dailyCapUsd: 500,
    alertThresholdPct: 80,
  },
};

// ─── YAML loader helper ─────────────────────────────────

function parseYamlFile(raw: string, filePath: string): unknown {
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}. Check YAML syntax at the indicated line.`,
    );
  }
}

function formatZodErrors(issues: z.ZodIssue[], filePath: string): string {
  const formatted = issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  return `Invalid config in ${filePath}:\n${formatted}`;
}

// ─── Config loaders ─────────────────────────────────────

/**
 * Load the combined NeoConfig from a single file (legacy).
 * Kept for backward compatibility — prefer loadGlobalConfig + loadRepoProjectConfig.
 */
export async function loadConfig(configPath: string): Promise<NeoConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `Config file not found: ${configPath}. Create a .neo/config.yml file to get started.`,
    );
  }

  const parsed = parseYamlFile(raw, configPath);

  const result = neoConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodErrors(result.error.issues, configPath));
  }

  return result.data;
}

/**
 * Load the global config from ~/.neo/config.yml.
 * Creates the file with defaults if it does not exist.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const configPath = path.join(getDataDir(), "config.yml");

  if (!existsSync(configPath)) {
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(configPath, stringifyYaml(DEFAULT_GLOBAL_CONFIG), "utf-8");
    return globalConfigSchema.parse(DEFAULT_GLOBAL_CONFIG);
  }

  const raw = await readFile(configPath, "utf-8");
  const parsed = parseYamlFile(raw, configPath);

  const result = globalConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodErrors(result.error.issues, configPath));
  }

  return result.data;
}

/**
 * Load the repo project config from .neo/config.yml (in the repo).
 */
export async function loadRepoProjectConfig(configPath: string): Promise<RepoProjectConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `Repo config not found: ${configPath}. Run 'neo init' to create .neo/config.yml.`,
    );
  }

  const parsed = parseYamlFile(raw, configPath);

  const result = repoProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodErrors(result.error.issues, configPath));
  }

  return result.data;
}
