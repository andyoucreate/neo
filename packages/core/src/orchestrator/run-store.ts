import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRunsDir, toRepoSlug } from "@/paths";
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

  constructor(options: RunStoreOptions = {}) {
    this.runsDir = options.runsDir ?? getRunsDir();
  }

  /**
   * Persist a run to disk. Creates the repo subdirectory if needed.
   * Fails silently — run persistence is non-critical.
   */
  async persistRun(run: PersistedRun): Promise<void> {
    try {
      const slug = toRepoSlug({ path: run.repo });
      // Use custom runsDir if provided, otherwise fall back to global path
      const repoDir = path.join(this.runsDir, slug);
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
   * Get all persisted runs from the runs directory.
   */
  async getAllRuns(): Promise<PersistedRun[]> {
    if (!existsSync(this.runsDir)) return [];

    const runs: PersistedRun[] = [];
    try {
      const jsonFiles = await this.collectRunFiles();
      for (const filePath of jsonFiles) {
        try {
          const content = await readFile(filePath, "utf-8");
          const run = JSON.parse(content) as PersistedRun;
          runs.push(run);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Non-critical
    }
    return runs;
  }

  /**
   * Get a specific run by ID.
   * Returns null if not found.
   */
  async getRunById(runId: string): Promise<PersistedRun | null> {
    if (!existsSync(this.runsDir)) return null;

    try {
      const jsonFiles = await this.collectRunFiles();
      for (const filePath of jsonFiles) {
        if (path.basename(filePath) === `${runId}.json`) {
          const content = await readFile(filePath, "utf-8");
          return JSON.parse(content) as PersistedRun;
        }
      }
    } catch {
      // Non-critical
    }
    return null;
  }

  /**
   * Scan for stale (ghost) runs on startup.
   * For each run with status='running', check if the PID is alive.
   * If dead, mark as 'failed' with blockedReason explaining the crash.
   * Returns the list of recovered ghost runs for event emission.
   */
  async scanForStaleRuns(): Promise<PersistedRun[]> {
    if (!existsSync(this.runsDir)) return [];

    const recovered: PersistedRun[] = [];

    try {
      const jsonFiles = await this.collectRunFiles();
      for (const filePath of jsonFiles) {
        const run = await this.recoverGhostRun(filePath);
        if (run) recovered.push(run);
      }
    } catch {
      // Non-critical — best effort recovery
    }

    return recovered;
  }

  /**
   * Check if a run file represents a ghost run (crashed supervisor).
   * Unlike recoverRunIfOrphaned, this method:
   * - Does NOT skip runs from the current process (we're a new process)
   * - Marks with blockedReason to indicate supervisor crash
   * If the run is a ghost, update its status to "failed" and return it.
   */
  private async recoverGhostRun(filePath: string): Promise<PersistedRun | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      const run = JSON.parse(content) as PersistedRun;

      if (run.status !== "running") return null;

      // If the run has a PID and the process is still alive, skip it
      if (run.pid && isProcessAlive(run.pid)) return null;

      // Don't mark recently created runs as ghost — the worker process
      // may not have written its PID yet (race condition on concurrent launches)
      const ageMs = Date.now() - new Date(run.createdAt).getTime();
      if (ageMs < ORPHAN_GRACE_PERIOD_MS) return null;

      run.status = "failed";
      run.blockedReason = "supervisor crashed";
      run.updatedAt = new Date().toISOString();
      await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");

      return run;
    } catch {
      // Non-critical — file may be corrupt or locked
      return null;
    }
  }

  /**
   * Mark a run as blocked after all retries have been exhausted.
   * Blocked runs are visible to the supervisor but don't halt other work.
   */
  async markBlocked(runId: string, reason: string): Promise<void> {
    const run = await this.getRunById(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    run.status = "blocked";
    run.blockedReason = reason;
    run.blockedAt = new Date().toISOString();
    run.updatedAt = new Date().toISOString();

    await this.persistRun(run);
  }

  /**
   * Get all blocked runs that need attention.
   */
  async getBlockedRuns(): Promise<PersistedRun[]> {
    const allRuns = await this.getAllRuns();
    return allRuns.filter((run) => run.status === "blocked");
  }

  /**
   * Unblock a run, setting it back to 'running' status.
   * Call this when the blocker has been resolved.
   */
  async unblock(runId: string): Promise<void> {
    const run = await this.getRunById(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== "blocked") {
      throw new Error(`Run ${runId} is not blocked (status: ${run.status})`);
    }

    run.status = "running";
    run.blockedReason = undefined;
    run.blockedAt = undefined;
    run.updatedAt = new Date().toISOString();

    await this.persistRun(run);
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
