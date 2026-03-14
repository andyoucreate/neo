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
