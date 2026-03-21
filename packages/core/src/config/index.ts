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

// ─── Re-export warnings utilities ────────────────────────

export type { ConfigParseResult, ConfigWarning, ConfigWarningType } from "./warnings";
export {
  collectConfigWarnings,
  DEPRECATED_FIELDS,
  formatConfigWarnings,
  KNOWN_MCP_SERVER_FIELDS,
  KNOWN_NESTED_FIELDS,
  KNOWN_REPO_FIELDS,
  KNOWN_TOP_LEVEL_FIELDS,
  KNOWN_WEBHOOK_FIELDS,
} from "./warnings";
