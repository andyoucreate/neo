import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { getDataDir, toRepoSlug } from "@/paths";

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

// ─── Global config schema (~/.neo/config.yml) ───────────
// This is now the single source of truth — repos are registered here.

export const globalConfigSchema = z.object({
  repos: z.array(repoConfigSchema).default([]),

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
      dir: z.string().default("/tmp/neo-sessions"),
    })
    .default({ initTimeoutMs: 120_000, maxDurationMs: 3_600_000, dir: "/tmp/neo-sessions" }),

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

  supervisor: z
    .object({
      port: z.number().default(7777),
      secret: z.string().optional(),
      idleIntervalMs: z.number().default(60_000),
      idleSkipMax: z.number().default(20),
      heartbeatTimeoutMs: z.number().default(300_000),
      maxConsecutiveFailures: z.number().default(3),
      maxEventsPerSec: z.number().default(10),
      dailyCapUsd: z.number().default(50),
      consolidationInterval: z.number().default(5),
      instructions: z.string().optional(),
    })
    .default({
      port: 7777,
      idleIntervalMs: 60_000,
      idleSkipMax: 20,
      heartbeatTimeoutMs: 300_000,
      maxConsecutiveFailures: 3,
      maxEventsPerSec: 10,
      dailyCapUsd: 50,
      consolidationInterval: 5,
    }),

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

// ─── NeoConfig = GlobalConfig (single schema now) ────────

export const neoConfigSchema = globalConfigSchema;

// ─── Derived types ───────────────────────────────────────

export type NeoConfig = z.infer<typeof neoConfigSchema>;
export type GlobalConfig = NeoConfig;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type RepoConfigInput = z.input<typeof repoConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

// ─── Default global config ──────────────────────────────

const DEFAULT_GLOBAL_CONFIG = {
  repos: [],
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
 * Load NeoConfig from a single file (legacy compatibility).
 */
export async function loadConfig(configPath: string): Promise<NeoConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${configPath}. Run 'neo init' to get started.`);
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
export async function loadGlobalConfig(): Promise<NeoConfig> {
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

// ─── Repo CRUD operations ───────────────────────────────

/**
 * Add a repo to ~/.neo/config.yml. Deduplicates by resolved path.
 */
export async function addRepoToGlobalConfig(repo: RepoConfigInput): Promise<void> {
  const config = await loadGlobalConfig();
  const resolvedPath = path.resolve(repo.path);
  const parsed = repoConfigSchema.parse({ ...repo, path: resolvedPath });

  const existing = config.repos.findIndex((r) => path.resolve(r.path) === resolvedPath);
  if (existing >= 0) {
    config.repos[existing] = parsed;
  } else {
    config.repos.push(parsed);
  }

  const configPath = path.join(getDataDir(), "config.yml");
  await writeFile(configPath, stringifyYaml(config), "utf-8");
}

/**
 * Remove a repo from ~/.neo/config.yml by path, name, or slug.
 */
export async function removeRepoFromGlobalConfig(pathOrName: string): Promise<boolean> {
  const config = await loadGlobalConfig();
  const resolvedPath = path.resolve(pathOrName);
  const initialLength = config.repos.length;

  config.repos = config.repos.filter(
    (r) =>
      path.resolve(r.path) !== resolvedPath &&
      r.name !== pathOrName &&
      toRepoSlug(r) !== pathOrName,
  );

  if (config.repos.length === initialLength) return false;

  const configPath = path.join(getDataDir(), "config.yml");
  await writeFile(configPath, stringifyYaml(config), "utf-8");
  return true;
}

/**
 * List all registered repos from ~/.neo/config.yml.
 */
export async function listReposFromGlobalConfig(): Promise<RepoConfig[]> {
  const config = await loadGlobalConfig();
  return config.repos;
}
