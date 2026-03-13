import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "../config.js";
import { withGitLock } from "./git-mutex.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

/**
 * Run a git command with execFile (no shell — prevents injection).
 * All callers should go through the public API which acquires the mutex.
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
  await withGitLock(repoPath, () =>
    git(repoPath, ["branch", branch, baseBranch]),
  );
}

export async function pushBranch(
  repoPath: string,
  branch: string,
  remote: string,
): Promise<void> {
  await withGitLock(repoPath, () => git(repoPath, ["push", remote, branch]));
}

export async function fetchRemote(
  repoPath: string,
  remote: string,
): Promise<void> {
  await withGitLock(repoPath, () => git(repoPath, ["fetch", remote]));
}

export async function deleteBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  await withGitLock(repoPath, () => git(repoPath, ["branch", "-D", branch]));
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return withGitLock(repoPath, () =>
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
  );
}

/**
 * Generate a deterministic branch name for a run.
 * Uses the repo's branchPrefix (default "feat") and the runId.
 */
export function getBranchName(config: RepoConfig, runId: string): string {
  const prefix = config.branchPrefix ?? "feat";
  const sanitized = runId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${prefix}/run-${sanitized}`;
}
