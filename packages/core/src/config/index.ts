// ─── Re-export all schemas and types ─────────────────────

export type {
  GitStrategy,
  GlobalConfig,
  McpServerConfig,
  NeoConfig,
  RepoConfig,
  RepoConfigInput,
  RepoOverrideConfig,
} from "./schema";
export {
  budgetConfigSchema,
  concurrencyConfigSchema,
  gitStrategySchema,
  globalConfigSchema,
  mcpServerConfigSchema,
  neoConfigSchema,
  recoveryConfigSchema,
  repoConfigSchema,
  repoOverrideConfigSchema,
  sessionsConfigSchema,
  supervisorConfigSchema,
} from "./schema";

// ─── Re-export dot-notation utilities ────────────────────

export { getConfigValue, setConfigValue } from "./dotNotation";

// ─── Re-export merge utilities ───────────────────────────

export { defaultConfig, mergeConfigs } from "./merge";

// ─── Re-export ConfigStore ───────────────────────────────

export { ConfigStore } from "./ConfigStore";

// ─── Re-export ConfigWatcher ─────────────────────────────

export { ConfigWatcher } from "./ConfigWatcher";
