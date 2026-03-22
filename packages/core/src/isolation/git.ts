import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "@/config";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

/**
 * Validates a git reference name (branch, tag, remote).
 * Allows alphanumeric, slashes, dashes, underscores, dots, and plus signs (for semver).
 * Explicitly rejects '..' to prevent directory traversal.
 * Rejects names starting with dash to prevent git option injection.
 * Throws if the name is invalid.
 */
export function validateGitRef(ref: string, refType = "reference"): void {
  if (!ref || ref.trim().length === 0) {
    throw new Error(`Git ${refType} name cannot be empty`);
  }

  // Reject directory traversal attempts
  if (ref.includes("..")) {
    throw new Error(
      `Git ${refType} name cannot contain '..' (directory traversal attempt): ${ref}`,
    );
  }

  // Reject names starting with dash (git interprets as options)
  if (ref.startsWith("-")) {
    throw new Error(
      `Git ${refType} name cannot start with '-' (would be interpreted as git option): ${ref}`,
    );
  }

  // Allow alphanumeric, slashes, dashes (not at start), underscores, dots, and plus signs
  // This pattern supports conventional branch names and semver tags
  const validPattern = /^[a-zA-Z0-9/_+.-]+$/;
  if (!validPattern.test(ref)) {
    throw new Error(
      `Invalid git ${refType} name: ${ref}. Only alphanumeric characters, slashes, dashes, underscores, dots, and plus signs are allowed.`,
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
  validateGitRef(branch, "branch");
  validateGitRef(baseBranch, "branch");
  await git(repoPath, ["branch", branch, baseBranch]);
}

export async function pushBranch(repoPath: string, branch: string, remote: string): Promise<void> {
  validateGitRef(branch, "branch");
  validateGitRef(remote, "remote");
  await git(repoPath, ["push", remote, branch]);
}

export async function fetchRemote(repoPath: string, remote: string): Promise<void> {
  validateGitRef(remote, "remote");
  await git(repoPath, ["fetch", remote]);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  validateGitRef(branch, "branch");
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
    validateGitRef(branch, "branch");
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
  validateGitRef(branch, "branch");
  validateGitRef(remote, "remote");
  await git(sessionPath, ["push", "-u", remote, branch]);
}
