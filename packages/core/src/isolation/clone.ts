import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

/**
 * Validates that a git ref name (branch, tag, remote) is safe to use.
 * Prevents command injection by allowing only alphanumeric chars, dashes, slashes, underscores, plus, and dot.
 * Rejects '..' to prevent directory traversal attacks.
 * Rejects git option-like strings starting with '-' to prevent option injection.
 *
 * @throws Error if the ref name is invalid
 */
export function validateGitRef(refName: string, paramName: string): void {
  if (!refName || typeof refName !== "string") {
    throw new Error(`${paramName} must be a non-empty string`);
  }

  // Reject directory traversal
  if (refName.includes("..")) {
    throw new Error(`${paramName} contains invalid pattern '..' (directory traversal)`);
  }

  // Reject git option injection (anything starting with -)
  if (refName.startsWith("-")) {
    throw new Error(`${paramName} cannot start with '-' (option injection)`);
  }

  // Allow only safe characters: alphanumeric, dash, underscore, slash, plus, dot
  // This supports semver tags like v1.2.3+build.123
  const validRefPattern = /^[a-zA-Z0-9/_+.-]+$/;
  if (!validRefPattern.test(refName)) {
    throw new Error(
      `${paramName} contains invalid characters. Only alphanumeric, dash, underscore, slash, plus, and dot are allowed. Got: ${refName}`,
    );
  }
}

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
  // SECURITY: Validate all git ref parameters BEFORE any git operations
  // This prevents command injection via branch names like '--upload-pack=payload'
  validateGitRef(options.branch, "branch");
  validateGitRef(options.baseBranch, "baseBranch");

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
    .catch((err) => {
      // No remote configured — will fall back to local clone
      console.debug(
        `[neo] No remote.origin.url for ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "";
    });

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
      .catch((err) => {
        // Branch doesn't exist remotely or network error — will create new branch
        console.debug(
          `[neo] ls-remote failed for branch ${options.branch}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      });

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
      } catch (err) {
        // No origin or not a clone — keep clonePath as fallback
        console.debug(
          `[neo] Failed to get origin URL for ${clonePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      clones.push({
        path: clonePath,
        branch: branchOut.trim(),
        repoPath,
      });
    } catch (err) {
      // Not a git repo — skip
      console.debug(
        `[neo] Skipping ${clonePath}, not a valid git repo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return clones;
}
