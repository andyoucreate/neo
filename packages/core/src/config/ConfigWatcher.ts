import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { ConfigStore } from "./ConfigStore";

// ─── ConfigWatcher ─────────────────────────────────────────

/**
 * Watches config files and reloads the store on changes.
 *
 * Emits 'change' event after successful reload.
 * Uses debouncing to handle rapid saves (e.g., editor auto-save).
 *
 * @example
 * const store = new ConfigStore('/path/to/repo');
 * await store.load();
 *
 * const watcher = new ConfigWatcher(store, { debounceMs: 300 });
 * watcher.on('change', () => console.log('Config reloaded'));
 * watcher.start();
 *
 * // Later: stop watching
 * watcher.stop();
 */
export class ConfigWatcher extends EventEmitter {
  private readonly store: ConfigStore;
  private readonly debounceMs: number;
  private readonly repoPath: string | undefined;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: ConfigStore, options?: { debounceMs?: number }) {
    super();
    this.store = store;
    this.debounceMs = options?.debounceMs ?? 500;
    this.repoPath = store.getRepoPath();
  }

  /**
   * Starts watching config files for changes.
   * Watches both global (~/.neo/config.yml) and repo config files.
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    const paths = this.getConfigPaths();

    this.watcher = watch(paths, {
      ignoreInitial: true,
      // Don't error if files don't exist — they may be created later
      ignorePermissionErrors: true,
    });

    this.watcher.on("change", () => this.handleChange());
    this.watcher.on("add", () => this.handleChange());
    this.watcher.on("unlink", () => this.handleChange());
  }

  /**
   * Stops watching config files.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ─── Private ─────────────────────────────────────────────

  /**
   * Returns the list of config file paths to watch.
   */
  private getConfigPaths(): string[] {
    const globalPath = join(homedir(), ".neo", "config.yml");
    const paths = [globalPath];

    if (this.repoPath) {
      const repoConfigPath = join(this.repoPath, ".neo", "config.yml");
      paths.push(repoConfigPath);
    }

    return paths;
  }

  /**
   * Handles file change events with debouncing.
   */
  private handleChange(): void {
    // Clear existing timer to debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reloadConfig();
    }, this.debounceMs);
    // Unref so it doesn't keep the process alive
    this.debounceTimer.unref();
  }

  /**
   * Reloads the config and emits 'change' event.
   */
  private async reloadConfig(): Promise<void> {
    try {
      await this.store.load();
      this.emit("change");
    } catch {
      // Silently ignore reload errors — file may be temporarily invalid
      // ConfigStore.load() already handles missing/invalid files gracefully
    }
  }
}
