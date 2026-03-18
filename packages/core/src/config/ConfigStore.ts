import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getConfigValue } from "./dotNotation";
import { mergeConfigs } from "./merge";
import type { NeoConfig, RepoOverrideConfig } from "./schema";
import { neoConfigSchema, repoOverrideConfigSchema } from "./schema";

// ─── ConfigStore ───────────────────────────────────────────

/**
 * Configuration store that loads and merges config files.
 *
 * Config precedence (highest to lowest):
 * 1. Repo config: <repoPath>/.neo/config.yml
 * 2. Global config: ~/.neo/config.yml
 * 3. Default values (hardcoded)
 *
 * @example
 * const store = new ConfigStore('/path/to/repo');
 * await store.load();
 * const dailyCap = store.get<number>('budget.dailyCapUsd');
 */
export class ConfigStore {
  private repoPath: string | undefined;
  private config: NeoConfig | null = null;

  constructor(repoPath?: string) {
    this.repoPath = repoPath;
  }

  // ─── Public API ────────────────────────────────────────

  /**
   * Loads and merges config files from all locations.
   * Must be called before get() or getAll().
   */
  async load(): Promise<void> {
    const globalConfig = await this.loadGlobalConfig();
    const repoConfig = await this.loadRepoConfig();

    this.config = mergeConfigs(globalConfig, repoConfig);
  }

  /**
   * Gets a config value using dot notation.
   *
   * @param key - Dot-separated path (e.g., "budget.dailyCapUsd")
   * @returns The value at the path
   * @throws Error if load() has not been called
   *
   * @example
   * store.get<number>('budget.dailyCapUsd') // 500
   * store.get<string>('sessions.dir') // '/tmp/neo-sessions'
   */
  get<T>(key: string): T {
    if (this.config === null) {
      throw new Error("ConfigStore not loaded. Call load() first.");
    }

    return getConfigValue(this.config, key) as T;
  }

  /**
   * Returns the full merged configuration.
   *
   * @throws Error if load() has not been called
   */
  getAll(): NeoConfig {
    if (this.config === null) {
      throw new Error("ConfigStore not loaded. Call load() first.");
    }

    return this.config;
  }

  /**
   * Returns the repository path, if one was provided.
   * Used by ConfigWatcher to determine which files to watch.
   */
  getRepoPath(): string | undefined {
    return this.repoPath;
  }

  // ─── Private loaders ───────────────────────────────────

  /**
   * Loads global config from ~/.neo/config.yml
   */
  private async loadGlobalConfig(): Promise<NeoConfig | null> {
    const globalPath = join(homedir(), ".neo", "config.yml");
    const raw = await this.loadFile(globalPath);

    if (raw === null) {
      return null;
    }

    // Validate and parse with defaults
    const parsed = neoConfigSchema.safeParse(raw);
    if (!parsed.success) {
      // Invalid config files are silently ignored — defaults apply
      return null;
    }

    return parsed.data;
  }

  /**
   * Loads repo-level overrides from <repoPath>/.neo/config.yml
   */
  private async loadRepoConfig(): Promise<RepoOverrideConfig | null> {
    if (!this.repoPath) {
      return null;
    }

    const repoConfigPath = join(this.repoPath, ".neo", "config.yml");
    const raw = await this.loadFile(repoConfigPath);

    if (raw === null) {
      return null;
    }

    // Validate repo overrides (partial subset)
    const parsed = repoOverrideConfigSchema.safeParse(raw);
    if (!parsed.success) {
      // Invalid config files are silently ignored — defaults apply
      return null;
    }

    return parsed.data;
  }

  /**
   * Loads and parses a YAML config file.
   *
   * @param filePath - Absolute path to the config file
   * @returns Parsed YAML content or null if file doesn't exist
   */
  private async loadFile(filePath: string): Promise<Record<string, unknown> | null> {
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(content);

      if (parsed === null || typeof parsed !== "object") {
        return null;
      }

      return parsed as Record<string, unknown>;
    } catch {
      // Parse errors are silently ignored — missing/invalid files return null
      return null;
    }
  }
}
