import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const WORKTREE_BASE = process.env.WORKTREE_BASE || "/tmp/voltaire-worktrees";
const GIT_TIMEOUT = 60_000;

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
    // Fetch latest from remote
    await execFileAsync("git", ["fetch", "origin"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT,
    });

    // Create worktree with a new branch from develop (or main)
    const baseBranch = await getDefaultBranch(repoDir);
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
      { cwd: repoDir, timeout: GIT_TIMEOUT },
    );

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

async function getDefaultBranch(repoDir: string): Promise<string> {
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
