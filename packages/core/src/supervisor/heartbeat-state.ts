import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRunsDir } from "@/paths";
import { isProcessAlive } from "@/shared/process";
import type { PersistedRun } from "@/types";
import type { SupervisorDaemonState } from "./schemas.js";

/** Grace period before a run without PID can be considered stale (ms). */
export const STALE_GRACE_PERIOD_MS = 30_000;

/**
 * Determine if a persisted run is actually active (not stale).
 *
 * For "running" status, validates:
 * - If PID exists and process is alive → active
 * - If PID exists but process is dead → stale (ghost run)
 * - If no PID and within grace period → active (still starting up)
 * - If no PID and past grace period → stale (ghost run)
 *
 * For "paused" status: always considered active (waiting for user action).
 */
export function isRunActive(
  run: PersistedRun,
  isAlive: (pid: number) => boolean = isProcessAlive,
  now: number = Date.now(),
): boolean {
  // Skip non-active statuses
  if (run.status !== "running" && run.status !== "paused") {
    return false;
  }

  // Paused runs are always considered active (waiting for user action)
  if (run.status === "paused") {
    return true;
  }

  // For running status, validate the run is actually alive
  // If PID exists and process is alive, it's active
  if (run.pid && isAlive(run.pid)) {
    return true;
  }

  // If PID exists but process is dead, it's a stale ghost run
  if (run.pid) {
    return false;
  }

  // No PID: check grace period (run may still be starting up)
  const ageMs = now - new Date(run.createdAt).getTime();

  return ageMs < STALE_GRACE_PERIOD_MS;
}

export interface StateUpdateResult {
  stateUpdate: Partial<SupervisorDaemonState>;
}

/**
 * Build the state update object after heartbeat completion.
 */
export function buildStateUpdate(opts: {
  state: SupervisorDaemonState | null;
  sessionId: string;
  today: string;
  todayCost: number;
  costUsd: number;
  heartbeatCount: number;
  isConsolidation: boolean;
  isCompaction: boolean;
}): StateUpdateResult {
  const stateUpdate: Partial<SupervisorDaemonState> = {
    sessionId: opts.sessionId,
    lastHeartbeat: new Date().toISOString(),
    heartbeatCount: opts.heartbeatCount + 1,
    totalCostUsd: (opts.state?.totalCostUsd ?? 0) + opts.costUsd,
    todayCostUsd: opts.todayCost + opts.costUsd,
    costResetDate: opts.today,
  };

  if (opts.isConsolidation) {
    stateUpdate.lastConsolidationHeartbeat = opts.heartbeatCount + 1;
    stateUpdate.lastConsolidationTimestamp = new Date().toISOString();
  }

  if (opts.isCompaction) {
    stateUpdate.lastCompactionHeartbeat = opts.heartbeatCount + 1;
  }

  return { stateUpdate };
}

/**
 * Read state from disk.
 */
export async function readState(statePath: string): Promise<SupervisorDaemonState | null> {
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw) as SupervisorDaemonState;
  } catch {
    return null;
  }
}

/**
 * Update state on disk with partial updates.
 */
export async function updateState(
  statePath: string,
  updates: Partial<SupervisorDaemonState>,
): Promise<void> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as SupervisorDaemonState;
    Object.assign(state, updates);
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Non-critical
  }
}

/**
 * Read persisted run files and return summaries of active (running/paused) runs.
 * Validates that "running" runs are actually alive by checking their PID.
 * Stale runs (dead PID past grace period) are filtered out to prevent ghost runs.
 */
export async function getActiveRuns(): Promise<string[]> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return [];

  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const active: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(runsDir, entry.name);
      const files = await readdir(subDir);

      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(path.join(subDir, f), "utf-8");
          const run = JSON.parse(raw) as PersistedRun;

          if (isRunActive(run)) {
            active.push(`${run.runId} [${run.status}] ${run.agent} on ${path.basename(run.repo)}`);
          }
        } catch {
          // Corrupted or partial file — skip
        }
      }
    }

    return active;
  } catch {
    return [];
  }
}

/**
 * Read persisted run data to extract actual status, cost, and duration.
 * Returns null if the run file cannot be found or parsed.
 */
export async function readPersistedRun(runId: string): Promise<{
  status: PersistedRun["status"];
  totalCostUsd: number;
  durationMs: number;
  output: string | undefined;
} | null> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return null;

  try {
    const entries = await readdir(runsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(runsDir, entry.name);
      const runPath = path.join(subDir, `${runId}.json`);

      if (existsSync(runPath)) {
        const raw = await readFile(runPath, "utf-8");
        const run = JSON.parse(raw) as PersistedRun;

        // Calculate total cost from all steps
        const totalCostUsd = Object.values(run.steps).reduce(
          (sum, step) => sum + (step.costUsd ?? 0),
          0,
        );

        // Calculate duration from createdAt to updatedAt
        const durationMs = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();

        // Get output from the last completed step
        const completedSteps = Object.values(run.steps).filter(
          (s) => s.status === "success" || s.status === "failure",
        );
        const lastStep = completedSteps[completedSteps.length - 1];
        const output =
          typeof lastStep?.rawOutput === "string" ? lastStep.rawOutput.slice(0, 1000) : undefined;

        return { status: run.status, totalCostUsd, durationMs, output };
      }
    }
  } catch {
    // Non-critical — return null if we can't read run data
  }

  return null;
}
