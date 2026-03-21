import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "@/config";
import { validateBranchName } from "./clone";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

/**
 * Validates that a remote name is safe for use in git commands.
 * Prevents command injection by rejecting shell metacharacters and directory traversal.
 *
 * @param remoteName - The remote name to validate
 * @throws Error if the remote name contains invalid characters
 */
function validateRemoteName(remoteName: string): void {
  // Allow alphanumeric, underscore, dot, and hyphen
  // Standard git remote names like: origin, upstream, my-remote
  const validRemotePattern = /^[a-zA-Z0-9_.-]+$/;

  if (!validRemotePattern.test(remoteName)) {
    throw new Error(
      `Invalid remote name: "${remoteName}". Remote names must contain only alphanumeric characters, underscores, dots, and hyphens.`,
    );
  }

  // Additional check: prevent directory traversal patterns
  if (remoteName.includes("..")) {
    throw new Error(
      `Invalid remote name: "${remoteName}". Remote names cannot contain directory traversal patterns (..).`,
    );
  }
}

/**
 * Run a git command with execFile (no shell — prevents injection).
 */
async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: resolve(repoPath),
    timeout: GIT_TIMEOUT,
  });
  return stdout.trim();
}

export async function createBranch(
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  validateBranchName(branch);
  validateBranchName(baseBranch);
  await git(repoPath, ["branch", branch, baseBranch]);
}

export async function pushBranch(repoPath: string, branch: string, remote: string): Promise<void> {
  validateBranchName(branch);
  validateRemoteName(remote);
  await git(repoPath, ["push", remote, branch]);
}

export async function fetchRemote(repoPath: string, remote: string): Promise<void> {
  validateRemoteName(remote);
  await git(repoPath, ["fetch", remote]);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  validateBranchName(branch);
  await git(repoPath, ["branch", "-D", branch]);
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Resolve the branch name for a run.
 * If an explicit branch is provided, use it as-is.
 * Otherwise, generate a deterministic name from the repo's branchPrefix and runId.
 */
export function getBranchName(config: RepoConfig, runId: string, branch?: string): string {
  if (branch) return branch;
  const prefix = config.branchPrefix ?? "feat";
  const sanitized = runId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${prefix}/run-${sanitized}`;
}

/**
 * Check if a session clone has uncommitted changes (staged or unstaged).
 */
export async function hasUncommittedChanges(sessionPath: string): Promise<boolean> {
  const status = await git(sessionPath, ["status", "--porcelain"]);
  return status.length > 0;
}

/**
 * Auto-commit all changes in a session clone. Used as a safety net after agent
 * sessions to prevent losing work when the clone is cleaned up.
 */
export async function autoCommitChanges(sessionPath: string, runId: string): Promise<boolean> {
  const hasChanges = await hasUncommittedChanges(sessionPath);
  if (!hasChanges) return false;

  await git(sessionPath, ["add", "-A"]);
  await git(sessionPath, [
    "commit",
    "-m",
    `chore: auto-commit uncommitted changes from run ${runId}`,
  ]);

  return true;
}

/**
 * Push a branch from a session clone to a remote. Silently succeeds if
 * the branch has no new commits to push.
 */
export async function pushSessionBranch(
  sessionPath: string,
  branch: string,
  remote: string,
): Promise<void> {
  validateBranchName(branch);
  validateRemoteName(remote);
  await git(sessionPath, ["push", "-u", remote, branch]);
}
