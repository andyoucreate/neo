import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { withGitLock } from "./git-mutex.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoPath: string;
}

/**
 * Create a new git worktree with an associated branch.
 * Creates the branch from baseBranch, then adds the worktree at worktreeDir.
 */
export async function createWorktree(options: {
  repoPath: string;
  branch: string;
  baseBranch: string;
  worktreeDir: string;
}): Promise<WorktreeInfo> {
  const repoPath = resolve(options.repoPath);
  const worktreeDir = resolve(options.worktreeDir);

  await withGitLock(repoPath, async () => {
    await execFileAsync(
      "git",
      [
        "worktree",
        "add",
        "-b",
        options.branch,
        worktreeDir,
        options.baseBranch,
      ],
      { cwd: repoPath, timeout: GIT_TIMEOUT },
    );
  });

  return { path: worktreeDir, branch: options.branch, repoPath };
}

/**
 * Remove a worktree. Does NOT delete the branch (branch stays for the PR).
 * Idempotent — does not throw if the worktree is already gone.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  const absPath = resolve(worktreePath);

  if (!existsSync(absPath)) {
    return;
  }

  // We need the repo path to acquire the lock.
  // Read the .git file in the worktree to find the main repo.
  const repoPath = await findRepoForWorktree(absPath);

  if (repoPath) {
    await withGitLock(repoPath, async () => {
      try {
        await execFileAsync("git", ["worktree", "remove", absPath, "--force"], {
          cwd: repoPath,
          timeout: GIT_TIMEOUT,
        });
      } catch {
        // Worktree reference may be broken — force cleanup
        await rm(absPath, { recursive: true, force: true });
        await execFileAsync("git", ["worktree", "prune"], {
          cwd: repoPath,
          timeout: GIT_TIMEOUT,
        }).catch(() => {});
      }
    });
  } else {
    // No repo found — just remove the directory
    await rm(absPath, { recursive: true, force: true });
  }
}

/**
 * List all worktrees for a repository.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const absRepoPath = resolve(repoPath);

  return withGitLock(absRepoPath, async () => {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: absRepoPath, timeout: GIT_TIMEOUT },
    );

    const worktrees: WorktreeInfo[] = [];
    let current: { path: string; branch: string } | undefined;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) {
          worktrees.push({ ...current, repoPath: absRepoPath });
        }
        current = { path: line.slice(9), branch: "" };
      } else if (line.startsWith("branch ") && current) {
        // "branch refs/heads/feat/run-abc" → "feat/run-abc"
        current.branch = line.slice(7).replace("refs/heads/", "");
      }
    }
    if (current) {
      worktrees.push({ ...current, repoPath: absRepoPath });
    }

    return worktrees;
  });
}

/**
 * Clean up worktrees under worktreeBaseDir that no longer have a matching run.
 * Removes any subdirectory that is a git worktree.
 */
export async function cleanupOrphanedWorktrees(
  worktreeBaseDir: string,
): Promise<void> {
  const absBase = resolve(worktreeBaseDir);

  if (!existsSync(absBase)) {
    return;
  }

  const entries = await readdir(absBase, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = resolve(absBase, entry.name);
    await removeWorktree(worktreePath);
  }
}

/**
 * Find the main repository path for a worktree by reading its .git file.
 * Worktrees have a .git *file* (not directory) that points to the main repo.
 */
async function findRepoForWorktree(
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: worktreePath, timeout: GIT_TIMEOUT },
    );
    // Returns something like "/path/to/repo/.git" — we want the parent
    const gitCommonDir = resolve(worktreePath, stdout.trim());
    return resolve(gitCommonDir, "..");
  } catch {
    return undefined;
  }
}
