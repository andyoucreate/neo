import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withGitLock } from "./git-lock.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const WORKTREE_BASE = process.env.WORKTREE_BASE || "/tmp/voltaire-worktrees";
const GIT_TIMEOUT = 60_000;

/**
 * Proactively clean up a worktree path if it already exists on disk.
 * Handles orphaned worktrees left behind by crashed/timed-out sessions.
 */
async function cleanupStaleWorktree(
  repoDir: string,
  worktreePath: string,
): Promise<void> {
  if (!existsSync(worktreePath)) return;

  logger.warn(`Stale worktree found at ${worktreePath}, cleaning up proactively`);
  try {
    await execFileAsync("git", ["worktree", "remove", worktreePath, "--force"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT,
    });
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT,
    }).catch(() => {});
  }
}

/**
 * Force-remove a worktree lock on a branch so it can be reused.
 * Extracts the stale worktree path from the error message and removes it.
 */
async function unlockBranchWorktree(
  repoDir: string,
  errorMessage: string,
): Promise<void> {
  // Extract path from: "already used by worktree at '/tmp/voltaire-worktrees/dispatch-xxx'"
  const match = errorMessage.match(/already used by worktree at '([^']+)'/);
  if (!match) return;

  const stalePath = match[1];
  logger.warn(`Removing stale worktree lock at ${stalePath}`);
  try {
    await execFileAsync("git", ["worktree", "remove", stalePath, "--force"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT,
    });
  } catch {
    await rm(stalePath, { recursive: true, force: true }).catch(() => {});
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT,
    }).catch(() => {});
  }
}

/**
 * Create an isolated git worktree for an agent session.
 * Returns the path to the new worktree directory.
 */
export async function createWorktree(
  repoDir: string,
  sessionId: string,
  branch?: string,
): Promise<string> {
  const worktreePath = join(WORKTREE_BASE, sessionId);
  const branchName = branch ?? `voltaire/${sessionId}`;

  try {
    // Clean up any stale worktree at this path
    await cleanupStaleWorktree(repoDir, worktreePath);

    // Fetch latest from remote (serialised per repo)
    await withGitLock(repoDir, () =>
      execFileAsync("git", ["fetch", "origin"], {
        cwd: repoDir,
        timeout: GIT_TIMEOUT,
      }),
    );

    // Create worktree with a new branch from develop (or main)
    const baseBranch = await getDefaultBranch(repoDir);
    try {
      await execFileAsync(
        "git",
        ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
        { cwd: repoDir, timeout: GIT_TIMEOUT },
      );
    } catch (branchError: unknown) {
      const msg = branchError instanceof Error ? branchError.message : "";
      if (msg.includes("already used by worktree")) {
        // Branch is locked by an orphaned worktree — clean it up and retry
        await unlockBranchWorktree(repoDir, msg);
        await execFileAsync(
          "git",
          ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
          { cwd: repoDir, timeout: GIT_TIMEOUT },
        ).catch(async () => {
          // Branch may still exist without worktree lock — delete and retry
          await execFileAsync("git", ["branch", "-D", branchName], {
            cwd: repoDir,
            timeout: GIT_TIMEOUT,
          }).catch(() => {});
          await execFileAsync(
            "git",
            ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
            { cwd: repoDir, timeout: GIT_TIMEOUT },
          );
        });
      } else if (msg.includes("already exists")) {
        // Branch exists from a previous failed run — delete it and retry
        logger.warn(`Branch ${branchName} already exists, cleaning up and retrying`);
        await execFileAsync("git", ["branch", "-D", branchName], {
          cwd: repoDir,
          timeout: GIT_TIMEOUT,
        }).catch((err: unknown) => logger.warn("Failed to delete branch during cleanup", err));
        await execFileAsync(
          "git",
          ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
          { cwd: repoDir, timeout: GIT_TIMEOUT },
        );
      } else {
        throw branchError;
      }
    }

    logger.info(`Created worktree at ${worktreePath} (branch: ${branchName})`);
    return worktreePath;
  } catch (error) {
    logger.error(`Failed to create worktree for ${sessionId}`, error);
    throw error;
  }
}

/**
 * Remove a worktree after session completion.
 */
export async function removeWorktree(
  repoDir: string,
  sessionId: string,
): Promise<void> {
  const worktreePath = join(WORKTREE_BASE, sessionId);

  try {
    // Remove the git worktree reference
    await execFileAsync("git", ["worktree", "remove", worktreePath, "--force"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT,
    });

    logger.info(`Removed worktree ${worktreePath}`);
  } catch {
    // Worktree reference may already be gone — force cleanup
    try {
      await rm(worktreePath, { recursive: true, force: true });
      await execFileAsync("git", ["worktree", "prune"], {
        cwd: repoDir,
        timeout: GIT_TIMEOUT,
      });
      logger.info(`Force-cleaned worktree ${worktreePath}`);
    } catch (cleanupError) {
      logger.warn(`Could not clean up worktree ${worktreePath}`, cleanupError);
    }
  }
}

/**
 * List all active worktrees for a repository.
 */
export async function listWorktrees(
  repoDir: string,
): Promise<Array<{ path: string; branch: string; head: string }>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoDir, timeout: GIT_TIMEOUT },
    );

    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    let current: { path: string; branch: string; head: string } | null = null;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) worktrees.push(current);
        current = { path: line.slice(9), branch: "", head: "" };
      } else if (line.startsWith("HEAD ") && current) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice(7);
      }
    }
    if (current) worktrees.push(current);

    // Filter to only voltaire worktrees
    return worktrees.filter((w) => w.path.startsWith(WORKTREE_BASE));
  } catch {
    return [];
  }
}

/**
 * Clean up all stale worktrees (orphaned from crashed sessions).
 */
export async function pruneWorktrees(repoDir: string): Promise<number> {
  const worktrees = await listWorktrees(repoDir);
  let pruned = 0;

  for (const wt of worktrees) {
    try {
      await removeWorktree(repoDir, wt.path.split("/").pop()!);
      pruned++;
    } catch {
      // best effort
    }
  }

  if (pruned > 0) {
    logger.info(`Pruned ${pruned} stale worktree(s)`);
  }

  return pruned;
}

/**
 * Build a human-readable branch name from a pipeline type and ticket ID.
 */
export function buildBranchName(
  pipeline: "feature" | "hotfix",
  ticketId: string,
): string {
  const prefix = pipeline === "hotfix" ? "fix" : "feat";
  const sanitized = ticketId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${prefix}/${sanitized}`;
}

/**
 * Create a worktree that checks out an existing remote branch (e.g. a PR branch).
 * Does NOT create a new branch — checks out the existing one.
 */
export async function createWorktreeForBranch(
  repoDir: string,
  sessionId: string,
  branch: string,
): Promise<string> {
  const worktreePath = join(WORKTREE_BASE, sessionId);

  try {
    // Clean up any stale worktree at this path
    await cleanupStaleWorktree(repoDir, worktreePath);

    await withGitLock(repoDir, () =>
      execFileAsync("git", ["fetch", "origin", branch], {
        cwd: repoDir,
        timeout: GIT_TIMEOUT,
      }),
    );

    await execFileAsync(
      "git",
      ["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`],
      { cwd: repoDir, timeout: GIT_TIMEOUT },
    ).catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("already used by worktree")) {
        // Branch locked by orphaned worktree — clean up and retry
        await unlockBranchWorktree(repoDir, msg);
        await execFileAsync(
          "git",
          ["worktree", "add", worktreePath, branch],
          { cwd: repoDir, timeout: GIT_TIMEOUT },
        );
      } else if (msg.includes("already exists")) {
        await execFileAsync(
          "git",
          ["worktree", "add", worktreePath, branch],
          { cwd: repoDir, timeout: GIT_TIMEOUT },
        );
      } else {
        throw err;
      }
    });

    logger.info(`Created worktree at ${worktreePath} (existing branch: ${branch})`);
    return worktreePath;
  } catch (error) {
    logger.error(`Failed to create worktree for branch ${branch} / session ${sessionId}`, error);
    throw error;
  }
}

export async function getDefaultBranch(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      { cwd: repoDir, timeout: GIT_TIMEOUT },
    );
    // Returns "origin/main" or "origin/develop" — strip "origin/"
    return stdout.trim().replace("origin/", "");
  } catch {
    return "develop"; // default for Voltaire projects
  }
}
