import type { NeoConfig, RepoOverrideConfig } from "./schema";
import {
  budgetConfigSchema,
  concurrencyConfigSchema,
  journalConfigSchema,
  recoveryConfigSchema,
  sessionsConfigSchema,
} from "./schema";

// ─── Default configuration ─────────────────────────────────

/**
 * Default configuration values.
 * Used as base layer when merging configs.
 */
export const defaultConfig: NeoConfig = {
  repos: [],
  concurrency: concurrencyConfigSchema.parse(undefined),
  budget: budgetConfigSchema.parse(undefined),
  recovery: recoveryConfigSchema.parse(undefined),
  sessions: sessionsConfigSchema.parse(undefined),
  journal: journalConfigSchema.parse(undefined),
  webhooks: [],
  supervisor: {
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
  },
  memory: { embeddings: true },
  childSupervisors: [],
};

// ─── Deep merge utility ────────────────────────────────────

/**
 * Deep merges two objects, with source values taking precedence.
 * Arrays are replaced, not merged.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      // Recursively merge nested objects
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      // Replace primitive values and arrays
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

// ─── Deep freeze utility ────────────────────────────────────

/**
 * Recursively freezes an object and all nested objects.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // Freeze arrays and their elements
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item);
    }
    return Object.freeze(obj) as Readonly<T>;
  }

  // Freeze object properties recursively
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }

  return Object.freeze(obj) as Readonly<T>;
}

// ─── Config merging ────────────────────────────────────────

/**
 * Merges multiple config layers with precedence: repo > global > defaults.
 *
 * @param defaults - Base configuration defaults
 * @param globalConfig - Global config from ~/.neo/config.yml (optional)
 * @param repoConfig - Repo-level overrides from <repo>/.neo/config.yml (optional)
 * @returns Fully resolved, frozen NeoConfig
 *
 * @example
 * const config = mergeConfigs(defaultConfig, globalConfig, repoOverrides);
 */
export function mergeConfigs(
  defaults: NeoConfig,
  globalConfig?: Partial<NeoConfig> | null,
  repoConfig?: RepoOverrideConfig | null,
): Readonly<NeoConfig> {
  // Start with defaults
  let result = { ...defaults };

  // Merge global config (second priority)
  if (globalConfig) {
    result = deepMerge(result, globalConfig);
  }

  // Merge repo overrides (highest priority)
  if (repoConfig) {
    result = deepMerge(result, repoConfig as Partial<NeoConfig>);
  }

  return deepFreeze(result);
}
