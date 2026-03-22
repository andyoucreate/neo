import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "@/config";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

/**
 * Git ref validation pattern.
 * Allows: alphanumeric, dots, underscores, hyphens, slashes, plus signs (for semver tags).
 * Explicitly forbids: '..' (directory traversal), special chars that could enable injection.
 */
const GIT_REF_PATTERN = /^[a-zA-Z0-9._/+-]+$/;

/**
 * Validate a git ref (branch, tag, or remote name).
 * Throws if the ref contains invalid characters or directory traversal sequences.
 */
function validateGitRef(ref: string, refType: string): void {
  if (!ref || ref.trim() === "") {
    throw new Error(`${refType} cannot be empty`);
  }

  if (ref.includes("..")) {
    throw new Error(`${refType} contains directory traversal sequence: ${ref}`);
  }

  if (!GIT_REF_PATTERN.test(ref)) {
    throw new Error(
      `${refType} contains invalid characters: ${ref}. Only alphanumeric, dots, underscores, hyphens, slashes, and plus signs are allowed.`,
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
  validateGitRef(branch, "Branch name");
  validateGitRef(baseBranch, "Base branch name");
  await git(repoPath, ["branch", branch, baseBranch]);
}

export async function pushBranch(repoPath: string, branch: string, remote: string): Promise<void> {
  validateGitRef(branch, "Branch name");
  validateGitRef(remote, "Remote name");
  await git(repoPath, ["push", remote, branch]);
}

export async function fetchRemote(repoPath: string, remote: string): Promise<void> {
  validateGitRef(remote, "Remote name");
  await git(repoPath, ["fetch", remote]);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  validateGitRef(branch, "Branch name");
  await git(repoPath, ["branch", "-D", branch]);
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Resolve the branch name for a run.
 * If an explicit branch is provided, validate and use it.
 * Otherwise, generate a deterministic name from the repo's branchPrefix and runId.
 */
export function getBranchName(config: RepoConfig, runId: string, branch?: string): string {
  if (branch) {
    validateGitRef(branch, "Branch name");
    return branch;
  }
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
  validateGitRef(branch, "Branch name");
  validateGitRef(remote, "Remote name");
  await git(sessionPath, ["push", "-u", remote, branch]);
}
