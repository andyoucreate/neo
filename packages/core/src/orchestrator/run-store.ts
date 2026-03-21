import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRunsDir, getRunsDir, toRepoSlug } from "@/paths";
import { isProcessAlive } from "@/shared/process";
import type { PersistedRun } from "@/types";

export interface RunStoreOptions {
  runsDir?: string | undefined;
}

/** Grace period before a run without PID can be considered orphaned (ms). */
const ORPHAN_GRACE_PERIOD_MS = 30_000;

/**
 * Handles persistence and recovery of workflow runs.
 *
 * Runs are stored as JSON files in: ~/.neo/runs/<repo-slug>/<runId>.json
 * This enables cross-process resume and status queries via `neo runs`.
 */
export class RunStore {
  private readonly runsDir: string;
  private readonly createdDirs = new Set<string>();
  private _activeRunCount = 0;

  constructor(options: RunStoreOptions = {}) {
    this.runsDir = options.runsDir ?? getRunsDir();
  }

  /**
   * Number of currently active (running) runs tracked by this store instance.
   * Increment via `incrementActiveRuns()`, decrement via `decrementActiveRuns()`.
   *
   * Note: JavaScript is single-threaded, so this counter is inherently thread-safe
   * within a single Node.js process. Each RunStore instance maintains its own count.
   */
  get activeRunCount(): number {
    return this._activeRunCount;
  }

  /**
   * Increment the active run counter. Call when a run starts.
   * Returns the new count.
   */
  incrementActiveRuns(): number {
    this._activeRunCount++;
    return this._activeRunCount;
  }

  /**
   * Decrement the active run counter. Call when a run completes or fails.
   * Returns the new count. Will not go below 0.
   */
  decrementActiveRuns(): number {
    if (this._activeRunCount > 0) {
      this._activeRunCount--;
    }
    return this._activeRunCount;
  }

  /**
   * Reset the active run counter to 0.
   * Useful for testing or recovery scenarios.
   */
  resetActiveRuns(): void {
    this._activeRunCount = 0;
  }

  /**
   * Persist a run to disk. Creates the repo subdirectory if needed.
   * Fails silently — run persistence is non-critical.
   */
  async persistRun(run: PersistedRun): Promise<void> {
    try {
      const slug = toRepoSlug({ path: run.repo });
      const repoDir = getRepoRunsDir(slug);
      if (!this.createdDirs.has(repoDir)) {
        await mkdir(repoDir, { recursive: true });
        this.createdDirs.add(repoDir);
      }
      const filePath = path.join(repoDir, `${run.runId}.json`);
      await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
    } catch {
      // Non-critical — don't fail the dispatch if persistence fails
    }
  }

  /**
   * Find all runs that were left in "running" state but whose process died.
   * Returns them so the caller can emit failure events and update status.
   */
  async recoverOrphanedRuns(): Promise<PersistedRun[]> {
    if (!existsSync(this.runsDir)) return [];

    const orphaned: PersistedRun[] = [];

    try {
      const jsonFiles = await this.collectRunFiles();
      for (const filePath of jsonFiles) {
        const run = await this.recoverRunIfOrphaned(filePath);
        if (run) orphaned.push(run);
      }
    } catch {
      // Non-critical
    }

    return orphaned;
  }

  /**
   * Collect all .json run files from the runs directory tree.
   * Searches both top-level and repo subdirectories.
   */
  async collectRunFiles(): Promise<string[]> {
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const jsonFiles: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(this.runsDir, entry.name);
        const subFiles = await readdir(subDir);
        for (const f of subFiles) {
          if (f.endsWith(".json")) jsonFiles.push(path.join(subDir, f));
        }
      } else if (entry.name.endsWith(".json")) {
        jsonFiles.push(path.join(this.runsDir, entry.name));
      }
    }

    return jsonFiles;
  }

  /**
   * Check if a run file represents an orphaned run.
   * If so, update its status to "failed" and return it.
   */
  private async recoverRunIfOrphaned(filePath: string): Promise<PersistedRun | null> {
    const content = await readFile(filePath, "utf-8");
    const run = JSON.parse(content) as PersistedRun;

    if (run.status !== "running") return null;

    // Never mark our own process's runs as orphaned
    if (run.pid && run.pid === process.pid) return null;

    // If the run has a PID and the process is still alive, skip it
    if (run.pid && isProcessAlive(run.pid)) return null;

    // Don't mark recently created runs as orphaned — the worker process
    // may not have written its PID yet (race condition on concurrent launches)
    const ageMs = Date.now() - new Date(run.createdAt).getTime();
    if (ageMs < ORPHAN_GRACE_PERIOD_MS) return null;

    run.status = "failed";
    run.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");

    return run;
  }
}
