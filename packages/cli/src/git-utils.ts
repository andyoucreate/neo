import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Detect the default branch of a git repo.
 * Tries remote HEAD first, then falls back to common branch names.
 * @param cwd - Directory to run git commands in (defaults to process.cwd())
 */
export async function detectDefaultBranch(cwd?: string): Promise<string> {
  const opts = { cwd };

  // Try remote HEAD first (works even on a feature branch)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      opts,
    );
    const ref = stdout.trim();
    const branch = ref.replace(/^refs\/remotes\/origin\//, "");
    if (branch && branch !== ref) return branch;
  } catch {
    // origin/HEAD may not be set — fall through
  }

  // Fallback: check if common default branch names exist locally
  for (const candidate of ["main", "master"]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${candidate}`], opts);
      return candidate;
    } catch {
      // branch doesn't exist — try next
    }
  }

  return "main";
}

/**
 * Check if the current directory is inside a git repository.
 */
export async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd });
    return true;
  } catch {
    return false;
  }
}
