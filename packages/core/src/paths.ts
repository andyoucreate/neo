import { homedir } from "node:os";
import path from "node:path";

/**
 * Global data directory for runtime artifacts (journals, runs).
 * Located at ~/.neo, similar to how Claude Code uses ~/.claude.
 */
export function getDataDir(): string {
  return path.join(homedir(), ".neo");
}

export function getJournalsDir(): string {
  return path.join(getDataDir(), "journals");
}

export function getRunsDir(): string {
  return path.join(getDataDir(), "runs");
}

/**
 * Derive a filesystem-safe slug from a repo config.
 * Uses `name` if present, otherwise `basename(path)`.
 */
export function toRepoSlug(repo: { name?: string | undefined; path: string }): string {
  const raw = repo.name ?? path.basename(repo.path);
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Runs directory for a specific repo: ~/.neo/runs/<slug>/
 */
export function getRepoRunsDir(repoSlug: string): string {
  return path.join(getRunsDir(), repoSlug);
}

/**
 * Path to the dispatch request file for a detached run.
 */
export function getRunDispatchPath(repoSlug: string, runId: string): string {
  return path.join(getRepoRunsDir(repoSlug), `${runId}.dispatch.json`);
}

/**
 * Path to the log file for a detached run.
 */
export function getRunLogPath(repoSlug: string, runId: string): string {
  return path.join(getRepoRunsDir(repoSlug), `${runId}.log`);
}
