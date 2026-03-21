import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "@/config";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

// Shell metacharacters that must be rejected to prevent injection
const DANGEROUS_CHARS = /[;<>|`$()&\s*?[\]{}#@%!]/;

/**
 * Validates that a git ref (branch or tag name) is safe and conforms to git ref-format rules.
 * Prevents shell injection and git command injection via malicious ref names.
 *
 * Applies two layers of validation:
 * 1. Rejects shell metacharacters and unsafe patterns (injection prevention)
 * 2. Uses git check-ref-format for git-specific rules
 *
 * @param ref - The git ref to validate
 * @param refType - Type of ref being validated (for error messages)
 * @throws Error if ref is empty, contains unsafe patterns, or fails git check-ref-format
 */
export async function validateGitRef(
  ref: string,
  refType: "branch" | "tag" | "remote" = "branch",
): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new Error(`${refType} name cannot be empty`);
  }

  // Layer 1: Reject dangerous shell metacharacters and unsafe patterns
  if (DANGEROUS_CHARS.test(ref)) {
    throw new Error(`Invalid ${refType} name: contains shell metacharacters or unsafe characters`);
  }

  // Explicitly reject directory traversal and refs starting with dots
  if (ref.includes("..") || ref.startsWith(".")) {
    throw new Error(`Invalid ${refType} name: contains unsafe path sequences`);
  }

  // Layer 2: Use git check-ref-format for git-specific validation rules
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", ref], {
      timeout: 5000,
    });
  } catch (_error) {
    throw new Error(`Invalid ${refType} name: does not conform to git ref-format rules`);
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
  await validateGitRef(branch, "branch");
  await validateGitRef(baseBranch, "branch");
  await git(repoPath, ["branch", branch, baseBranch]);
}

export async function pushBranch(repoPath: string, branch: string, remote: string): Promise<void> {
  await validateGitRef(branch, "branch");
  await validateGitRef(remote, "remote");
  await git(repoPath, ["push", remote, branch]);
}

export async function fetchRemote(repoPath: string, remote: string): Promise<void> {
  await validateGitRef(remote, "remote");
  await git(repoPath, ["fetch", remote]);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await validateGitRef(branch, "branch");
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
export async function getBranchName(
  config: RepoConfig,
  runId: string,
  branch?: string,
): Promise<string> {
  if (branch) {
    await validateGitRef(branch, "branch");
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
  await validateGitRef(branch, "branch");
  await validateGitRef(remote, "remote");
  await git(sessionPath, ["push", "-u", remote, branch]);
}
