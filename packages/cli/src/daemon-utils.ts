import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSupervisorDir,
  getSupervisorStatePath,
  isProcessAlive,
  type SupervisorDaemonState,
  supervisorDaemonStateSchema,
} from "@neotx/core";

/**
 * Read and parse supervisor daemon state.
 */
export async function readDaemonState(name: string): Promise<SupervisorDaemonState | null> {
  const statePath = getSupervisorStatePath(name);
  if (!existsSync(statePath)) return null;
  try {
    const raw = await readFile(statePath, "utf-8");
    return supervisorDaemonStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Check if daemon is running by verifying state and process liveness.
 */
export async function isDaemonRunning(name: string): Promise<SupervisorDaemonState | null> {
  const state = await readDaemonState(name);
  if (!state || state.status === "stopped") return null;
  if (!isProcessAlive(state.pid)) return null;
  return state;
}

export interface DaemonSpawnResult {
  pid: number;
  error?: undefined;
}

export interface DaemonSpawnError {
  pid: 0;
  error: string;
}

/**
 * Start a supervisor daemon in detached mode.
 * Returns a Promise that resolves with the PID after spawn confirmation,
 * or rejects with an error if spawn fails.
 */
export async function startDaemonDetached(
  name: string,
): Promise<DaemonSpawnResult | DaemonSpawnError> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "daemon", "supervisor-worker.js");
  const packageRoot = path.resolve(__dirname, "..");

  const logDir = getSupervisorDir(name);
  await mkdir(logDir, { recursive: true });
  const logFd = openSync(path.join(logDir, "daemon.log"), "a");

  return new Promise((resolve) => {
    let resolved = false;
    let fdClosed = false;
    const safeResolve = (result: DaemonSpawnResult | DaemonSpawnError) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (!fdClosed) {
        fdClosed = true;
        closeSync(logFd);
      }
      resolve(result);
    };

    const child = spawn(process.execPath, [workerPath, name], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: packageRoot,
      env: process.env,
    });

    // Capture spawn errors before unref() - these would otherwise be silently discarded
    child.on("error", (err) => {
      safeResolve({ pid: 0, error: err.message });
    });

    // Wait for 'spawn' event to confirm process started successfully
    child.on("spawn", () => {
      child.unref();
      if (child.pid) {
        safeResolve({ pid: child.pid });
      } else {
        safeResolve({ pid: 0, error: "Spawn succeeded but no PID assigned" });
      }
    });

    // Safety timeout in case neither event fires (shouldn't happen)
    const timer = setTimeout(() => {
      child.unref();
      if (child.pid) {
        safeResolve({ pid: child.pid });
      } else {
        safeResolve({ pid: 0, error: "Spawn timeout - no PID available" });
      }
    }, 1000);
  });
}
