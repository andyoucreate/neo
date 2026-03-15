import type { PersistedRun } from "@neotx/core";
import {
  getRunsDir,
  listReposFromGlobalConfig,
  removeWorktree,
  toRepoSlug,
} from "@neotx/core";
import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { printError, printJson, printSuccess } from "../output.js";

const WORKTREES_DIR = ".neo/worktrees";

interface CleanupStats {
  runsRemoved: number;
  worktreesRemoved: number;
  bytesFreed: number;
  errors: string[];
}

interface CleanupTarget {
  runId: string;
  repoSlug: string;
  runFilePath: string;
  worktreePath: string | null;
  status: string;
  reason: string;
}

/**
 * Check if a process is alive by sending signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively calculate directory size.
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stats = await stat(fullPath);
        totalSize += stats.size;
      }
    }
  } catch {
    // Directory may not exist or be inaccessible
  }

  return totalSize;
}

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Load a run file and parse it.
 */
async function loadRunFile(filePath: string): Promise<PersistedRun | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as PersistedRun;
  } catch {
    return null;
  }
}

/**
 * Build a map of repo paths by slug.
 */
async function buildRepoPathMap(): Promise<Map<string, string>> {
  const repos = await listReposFromGlobalConfig();
  const repoPathBySlug = new Map<string, string>();
  for (const repo of repos) {
    repoPathBySlug.set(toRepoSlug(repo), repo.path);
  }
  return repoPathBySlug;
}

/**
 * Scan a slug directory for run files and evaluate them.
 */
async function scanSlugDirectory(
  slugDir: string,
  repoSlug: string,
  repoPathBySlug: Map<string, string>,
): Promise<CleanupTarget[]> {
  const targets: CleanupTarget[] = [];
  const files = await readdir(slugDir).catch(() => []);

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".dispatch.json")) continue;

    const runFilePath = path.join(slugDir, file);
    const target = await evaluateRunFile(runFilePath, repoSlug, repoPathBySlug);
    if (target) targets.push(target);
  }

  return targets;
}

/**
 * Find all dead runs that should be cleaned up.
 */
async function findDeadRuns(): Promise<CleanupTarget[]> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return [];

  const targets: CleanupTarget[] = [];
  const repoPathBySlug = await buildRepoPathMap();
  const entries = await readdir(runsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const slugDir = path.join(runsDir, entry.name);
      const slugTargets = await scanSlugDirectory(slugDir, entry.name, repoPathBySlug);
      targets.push(...slugTargets);
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dispatch.json")) {
      const runFilePath = path.join(runsDir, entry.name);
      const target = await evaluateRunFile(runFilePath, "unknown", repoPathBySlug);
      if (target) targets.push(target);
    }
  }

  return targets;
}

/**
 * Evaluate a single run file to determine if it should be cleaned up.
 */
async function evaluateRunFile(
  runFilePath: string,
  repoSlug: string,
  repoPathBySlug: Map<string, string>,
): Promise<CleanupTarget | null> {
  const run = await loadRunFile(runFilePath);
  if (!run) {
    return {
      runId: path.basename(runFilePath, ".json"),
      repoSlug,
      runFilePath,
      worktreePath: null,
      status: "corrupt",
      reason: "corrupt or unreadable run file",
    };
  }

  if (run.status === "running") {
    if (run.pid && isProcessAlive(run.pid)) {
      return null;
    }
    return createTarget(run, repoSlug, runFilePath, repoPathBySlug, "orphaned (process dead)");
  }

  if (run.status === "completed" || run.status === "failed") {
    return createTarget(run, repoSlug, runFilePath, repoPathBySlug, run.status);
  }

  return null;
}

/**
 * Create a cleanup target for a run.
 */
function createTarget(
  run: PersistedRun,
  repoSlug: string,
  runFilePath: string,
  repoPathBySlug: Map<string, string>,
  reason: string,
): CleanupTarget {
  const worktreePath = findWorktreePath(run, repoPathBySlug);
  return {
    runId: run.runId,
    repoSlug,
    runFilePath,
    worktreePath,
    status: run.status,
    reason,
  };
}

/**
 * Find the worktree path for a run.
 */
function findWorktreePath(
  run: PersistedRun,
  repoPathBySlug: Map<string, string>,
): string | null {
  if (run.worktreePath && existsSync(run.worktreePath)) {
    return run.worktreePath;
  }

  const slug = toRepoSlug({ path: run.repo });
  const repoPath = repoPathBySlug.get(slug) ?? run.repo;
  const expectedPath = path.join(repoPath, WORKTREES_DIR, run.runId);
  return existsSync(expectedPath) ? expectedPath : null;
}

/**
 * Find orphaned worktrees that don't have matching run files.
 */
async function findOrphanedWorktrees(
  knownRunIds: Set<string>,
): Promise<{ path: string; runId: string; repoPath: string }[]> {
  const orphaned: { path: string; runId: string; repoPath: string }[] = [];
  const repos = await listReposFromGlobalConfig();

  for (const repo of repos) {
    const worktreeBase = path.join(repo.path, WORKTREES_DIR);
    if (!existsSync(worktreeBase)) continue;

    const repoOrphans = await findOrphanedInRepo(worktreeBase, repo.path, knownRunIds);
    orphaned.push(...repoOrphans);
  }

  return orphaned;
}

/**
 * Find orphaned worktrees in a single repo.
 */
async function findOrphanedInRepo(
  worktreeBase: string,
  repoPath: string,
  knownRunIds: Set<string>,
): Promise<{ path: string; runId: string; repoPath: string }[]> {
  const orphaned: { path: string; runId: string; repoPath: string }[] = [];

  try {
    const entries = await readdir(worktreeBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const runId = entry.name;
      if (knownRunIds.has(runId)) continue;

      const hasRunFile = await runFileExists(runId);
      if (!hasRunFile) {
        orphaned.push({
          path: path.join(worktreeBase, entry.name),
          runId,
          repoPath,
        });
      }
    }
  } catch {
    // Directory not accessible
  }

  return orphaned;
}

/**
 * Check if a run file exists for a given runId.
 */
async function runFileExists(runId: string): Promise<boolean> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return false;

  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runFile = path.join(runsDir, entry.name, `${runId}.json`);
        if (existsSync(runFile)) return true;
      } else if (entry.name === `${runId}.json`) {
        return true;
      }
    }
  } catch {
    // Ignore errors
  }

  return false;
}

/**
 * Remove worktree and update stats.
 */
async function removeWorktreeWithStats(
  worktreePath: string,
  worktreeSize: number,
  stats: CleanupStats,
): Promise<void> {
  try {
    await removeWorktree(worktreePath);
    stats.worktreesRemoved++;
    stats.bytesFreed += worktreeSize;
  } catch (error) {
    stats.errors.push(
      `Failed to remove worktree ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Remove run file and associated files, update stats.
 */
async function removeRunFiles(runFilePath: string, stats: CleanupStats): Promise<void> {
  try {
    await unlink(runFilePath);
    stats.runsRemoved++;

    const dispatchPath = runFilePath.replace(".json", ".dispatch.json");
    if (existsSync(dispatchPath)) {
      await unlink(dispatchPath);
    }

    const logPath = runFilePath.replace(".json", ".log");
    if (existsSync(logPath)) {
      const logStats = await stat(logPath).catch(() => null);
      if (logStats) stats.bytesFreed += logStats.size;
      await unlink(logPath);
    }
  } catch (error) {
    stats.errors.push(
      `Failed to remove run file ${runFilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Clean up a single target.
 */
async function cleanupTarget(
  target: CleanupTarget,
  dryRun: boolean,
  stats: CleanupStats,
): Promise<void> {
  let worktreeSize = 0;
  if (target.worktreePath) {
    worktreeSize = await getDirectorySize(target.worktreePath);
  }

  if (dryRun) {
    if (target.worktreePath) {
      stats.worktreesRemoved++;
      stats.bytesFreed += worktreeSize;
    }
    stats.runsRemoved++;
    return;
  }

  if (target.worktreePath) {
    await removeWorktreeWithStats(target.worktreePath, worktreeSize, stats);
  }
  await removeRunFiles(target.runFilePath, stats);
}

/**
 * Clean up an orphaned worktree.
 */
async function cleanupOrphanedWorktree(
  worktreePath: string,
  dryRun: boolean,
  stats: CleanupStats,
): Promise<void> {
  const size = await getDirectorySize(worktreePath);

  if (dryRun) {
    stats.worktreesRemoved++;
    stats.bytesFreed += size;
    return;
  }

  try {
    await removeWorktree(worktreePath);
    stats.worktreesRemoved++;
    stats.bytesFreed += size;
  } catch {
    try {
      await rm(worktreePath, { recursive: true, force: true });
      stats.worktreesRemoved++;
      stats.bytesFreed += size;
    } catch (rmError) {
      stats.errors.push(
        `Failed to remove orphaned worktree ${worktreePath}: ${rmError instanceof Error ? rmError.message : String(rmError)}`,
      );
    }
  }
}

/**
 * Print cleanup summary.
 */
function printSummary(stats: CleanupStats, dryRun: boolean): void {
  console.log("");
  if (dryRun) {
    console.log("Dry run complete. The following would be removed:");
  } else {
    printSuccess("Cleanup complete!");
  }
  console.log(`  Runs:       ${stats.runsRemoved}`);
  console.log(`  Worktrees:  ${stats.worktreesRemoved}`);
  console.log(`  Space:      ${formatBytes(stats.bytesFreed)}`);

  if (stats.errors.length > 0) {
    console.log("");
    printError(`${stats.errors.length} error(s) occurred:`);
    for (const error of stats.errors) {
      console.log(`  - ${error}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Execute the cleanup process.
 */
async function executeCleanup(
  targets: CleanupTarget[],
  orphanedWorktrees: { path: string; runId: string; repoPath: string }[],
  dryRun: boolean,
  jsonOutput: boolean,
): Promise<CleanupStats> {
  const stats: CleanupStats = {
    runsRemoved: 0,
    worktreesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  for (const target of targets) {
    if (!jsonOutput && !dryRun) {
      console.log(`Cleaning up: ${target.runId} (${target.reason})`);
    }
    await cleanupTarget(target, dryRun, stats);
  }

  for (const orphan of orphanedWorktrees) {
    if (!jsonOutput && !dryRun) {
      console.log(`Cleaning up orphaned worktree: ${orphan.runId}`);
    }
    await cleanupOrphanedWorktree(orphan.path, dryRun, stats);
  }

  return stats;
}

export default defineCommand({
  meta: {
    name: "cleanup",
    description: "Remove dead runs and their associated worktrees",
  },
  args: {
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview what would be deleted without actually deleting",
      default: false,
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const dryRun = args.dryRun;

    const targets = await findDeadRuns();
    const knownRunIds = new Set(targets.map((t) => t.runId));
    const orphanedWorktrees = await findOrphanedWorktrees(knownRunIds);

    if (targets.length === 0 && orphanedWorktrees.length === 0) {
      if (jsonOutput) {
        printJson({ dryRun, runsRemoved: 0, worktreesRemoved: 0, bytesFreed: 0, errors: [] });
      } else {
        console.log("Nothing to clean up. All runs are active or already cleaned.");
      }
      return;
    }

    const stats = await executeCleanup(targets, orphanedWorktrees, dryRun, jsonOutput);

    if (jsonOutput) {
      printJson({
        dryRun,
        runsRemoved: stats.runsRemoved,
        worktreesRemoved: stats.worktreesRemoved,
        bytesFreed: stats.bytesFreed,
        bytesFreedFormatted: formatBytes(stats.bytesFreed),
        errors: stats.errors,
      });
    } else {
      printSummary(stats, dryRun);
    }
  },
});
