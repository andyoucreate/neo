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

/**
 * Directory for all supervisor instances: ~/.neo/supervisors/
 */
export function getSupervisorsDir(): string {
  return path.join(getDataDir(), "supervisors");
}

/**
 * Directory for a specific supervisor instance: ~/.neo/supervisors/<name>/
 */
export function getSupervisorDir(name: string): string {
  return path.join(getSupervisorsDir(), name);
}

/**
 * Path to a supervisor state file: ~/.neo/supervisors/<name>/state.json
 */
export function getSupervisorStatePath(name: string): string {
  return path.join(getSupervisorDir(name), "state.json");
}

export function getSupervisorActivityPath(name: string): string {
  return path.join(getSupervisorDir(name), "activity.jsonl");
}

export function getSupervisorInboxPath(name: string): string {
  return path.join(getSupervisorDir(name), "inbox.jsonl");
}

export function getSupervisorEventsPath(name: string): string {
  return path.join(getSupervisorDir(name), "events.jsonl");
}

export function getSupervisorLockPath(name: string): string {
  return path.join(getSupervisorDir(name), "daemon.lock");
}

export function getSupervisorDecisionsPath(name: string): string {
  return path.join(getSupervisorDir(name), "decisions.jsonl");
}

/**
 * Path to the children registry file: ~/.neo/supervisors/<name>/children.json
 * Written by ChildRegistry, read by the TUI to display focused child supervisors.
 */
export function getSupervisorChildrenPath(name: string): string {
  return path.join(getSupervisorDir(name), "children.json");
}

/**
 * Directory for all focused supervisor instances: ~/.neo/supervisors/focused/
 */
export function getFocusedSupervisorsDir(): string {
  return path.join(getSupervisorsDir(), "focused");
}

/**
 * Directory for a specific focused supervisor: ~/.neo/supervisors/focused/<id>/
 */
export function getFocusedSupervisorDir(supervisorId: string): string {
  return path.join(getFocusedSupervisorsDir(), supervisorId);
}

/**
 * Session file for a focused supervisor: ~/.neo/supervisors/focused/<id>/session.json
 */
export function getFocusedSupervisorSessionPath(supervisorId: string): string {
  return path.join(getFocusedSupervisorDir(supervisorId), "session.json");
}
