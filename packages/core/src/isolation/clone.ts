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
 * Validates that a branch name is safe for use in git commands.
 * Prevents command injection by rejecting shell metacharacters and directory traversal.
 *
 * @param branchName - The branch name to validate
 * @throws Error if the branch name contains invalid characters
 */
export function validateBranchName(branchName: string): void {
  // Allow alphanumeric, forward slash, underscore, dot, and hyphen
  // This covers standard git branch naming conventions including:
  // - feature/my-branch
  // - fix/issue-123
  // - release/v1.2.3
  const validBranchPattern = /^[a-zA-Z0-9/_.-]+$/;

  if (!validBranchPattern.test(branchName)) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names must contain only alphanumeric characters, forward slashes, underscores, dots, and hyphens.`,
    );
  }

  // Additional check: prevent directory traversal patterns
  if (branchName.includes("..")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot contain directory traversal patterns (..).`,
    );
  }
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
  // Validate branch names before using in git commands
  validateBranchName(options.branch);
  validateBranchName(options.baseBranch);

  const repoPath = resolve(options.repoPath);
  const sessionDir = resolve(options.sessionDir);

  await mkdir(dirname(sessionDir), { recursive: true });

  // Resolve the real upstream remote URL so the clone is completely
  // independent from the user's local repo. This prevents any git
  // operations in the clone from leaking into the user's working tree.
  const remoteUrl = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoPath,
    timeout: GIT_TIMEOUT,
  })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");

  // Clone from the real remote (GitHub) instead of the local path.
  // This ensures zero coupling: no hardlinks, no local-path origin,
  // no alternates. Falls back to local clone if no remote is configured.
  const cloneSource = remoteUrl || repoPath;
  await execFileAsync("git", ["clone", "--branch", options.baseBranch, cloneSource, sessionDir], {
    timeout: GIT_TIMEOUT,
  });

  // If branch === baseBranch, we're already on it after clone — nothing to do
  if (options.branch !== options.baseBranch) {
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
    } else {
      // Create a new branch from baseBranch
      await execFileAsync("git", ["checkout", "-b", options.branch], {
        cwd: sessionDir,
        timeout: GIT_TIMEOUT,
      });
    }
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
