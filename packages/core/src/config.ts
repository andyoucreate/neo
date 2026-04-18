import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import { getDataDir, toRepoSlug } from "@/paths";

// ─── Re-export all schemas and types from config module ──

export type {
  GitStrategy,
  GlobalConfig,
  McpServerConfig,
  NeoConfig,
  ProviderConfig,
  RepoConfig,
  RepoConfigInput,
  RepoOverrideConfig,
} from "@/config/index";
export {
  budgetConfigSchema,
  ConfigStore,
  ConfigWatcher,
  concurrencyConfigSchema,
  gitStrategySchema,
  globalConfigSchema,
  journalConfigSchema,
  mcpServerConfigSchema,
  neoConfigSchema,
  providerConfigSchema,
  recoveryConfigSchema,
  repoConfigSchema,
  repoOverrideConfigSchema,
  sessionsConfigSchema,
  supervisorConfigSchema,
} from "@/config/index";

// ─── Import schemas for internal use ─────────────────────

import type { NeoConfig, RepoConfig, RepoConfigInput } from "@/config/index";
import { globalConfigSchema, neoConfigSchema, repoConfigSchema } from "@/config/index";

// ─── Default global config ──────────────────────────────

const DEFAULT_GLOBAL_CONFIG = {
  repos: [],
  concurrency: {
    maxSessions: 5,
    maxPerRepo: 4,
    queueMax: 50,
  },
  budget: {
    dailyCapUsd: 500,
    alertThresholdPct: 80,
  },
  provider: {
    adapter: "claude",
    models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
    args: [],
    env: {},
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
  } catch (err) {
    // Expected error: config file not found
    throw new Error(
      `Config file not found: ${configPath}. Run 'neo init' to get started. (${err instanceof Error ? err.message : String(err)})`,
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
