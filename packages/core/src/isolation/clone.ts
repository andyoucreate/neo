import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

export interface SessionCloneInfo {
  path: string;
  branch: string;
  repoPath: string;
}

/**
 * Create an isolated git clone for an agent session.
 * Uses `git clone --local` to hardlink objects (fast, no network).
 * Then checks out the target branch (existing or new).
 */
export async function createSessionClone(options: {
  repoPath: string;
  branch: string;
  baseBranch: string;
  sessionDir: string;
}): Promise<SessionCloneInfo> {
  const repoPath = resolve(options.repoPath);
  const sessionDir = resolve(options.sessionDir);

  await mkdir(dirname(sessionDir), { recursive: true });

  // Clone the repo locally, starting from baseBranch.
  // --local uses hardlinks for .git/objects — fast and space-efficient.
  await execFileAsync(
    "git",
    ["clone", "--local", "--branch", options.baseBranch, repoPath, sessionDir],
    { timeout: GIT_TIMEOUT },
  );

  // After --local clone, origin points to the local repo path.
  // Re-point origin to the real upstream remote so pushes go to GitHub, not the user's repo.
  const realRemoteUrl = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoPath,
    timeout: GIT_TIMEOUT,
  })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");

  if (realRemoteUrl) {
    await execFileAsync("git", ["remote", "set-url", "origin", realRemoteUrl], {
      cwd: sessionDir,
      timeout: GIT_TIMEOUT,
    });
  }

  // Check if the target branch already exists on the remote (e.g. fixer on existing PR)
  const branchExists = await execFileAsync(
    "git",
    ["ls-remote", "--heads", "origin", options.branch],
    { cwd: sessionDir, timeout: GIT_TIMEOUT },
  )
    .then(({ stdout }) => stdout.trim().length > 0)
    .catch(() => false);

  if (branchExists) {
    // Fetch and checkout the existing branch
    await execFileAsync("git", ["fetch", "origin", options.branch], {
      cwd: sessionDir,
      timeout: GIT_TIMEOUT,
    });
    await execFileAsync("git", ["checkout", "-b", options.branch, `origin/${options.branch}`], {
      cwd: sessionDir,
      timeout: GIT_TIMEOUT,
    });
  } else if (options.branch !== options.baseBranch) {
    // Create a new branch from baseBranch
    await execFileAsync("git", ["checkout", "-b", options.branch], {
      cwd: sessionDir,
      timeout: GIT_TIMEOUT,
    });
  }

  return { path: sessionDir, branch: options.branch, repoPath };
}

/**
 * Remove a session clone directory.
 * Idempotent — does not throw if the directory is already gone.
 */
export async function removeSessionClone(sessionPath: string): Promise<void> {
  const absPath = resolve(sessionPath);

  if (!existsSync(absPath)) {
    return;
  }

  await rm(absPath, { recursive: true, force: true });
}

/**
 * List all session clones under a base directory.
 */
export async function listSessionClones(sessionsBaseDir: string): Promise<SessionCloneInfo[]> {
  const absBase = resolve(sessionsBaseDir);

  if (!existsSync(absBase)) {
    return [];
  }

  const entries = await readdir(absBase, { withFileTypes: true });
  const clones: SessionCloneInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const clonePath = resolve(absBase, entry.name);

    try {
      const { stdout: branchOut } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd: clonePath,
          timeout: GIT_TIMEOUT,
        },
      );
      let repoPath = clonePath;
      try {
        const { stdout: originUrl } = await execFileAsync(
          "git",
          ["config", "--get", "remote.origin.url"],
          { cwd: clonePath, timeout: GIT_TIMEOUT },
        );
        const url = originUrl.trim();
        if (url) repoPath = resolve(clonePath, url);
      } catch {
        // No origin or not a clone — keep clonePath as fallback
      }
      clones.push({
        path: clonePath,
        branch: branchOut.trim(),
        repoPath,
      });
    } catch {
      // Not a git repo — skip
    }
  }

  return clones;
}

/**
 * Clean up session clone directories under sessionsBaseDir.
 * Removes any subdirectory found (best-effort orphan cleanup).
 */
export async function cleanupOrphanedSessions(sessionsBaseDir: string): Promise<void> {
  const absBase = resolve(sessionsBaseDir);

  if (!existsSync(absBase)) {
    return;
  }

  const entries = await readdir(absBase, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = resolve(absBase, entry.name);
    await removeSessionClone(sessionPath);
  }
}
