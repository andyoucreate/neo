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

/**
 * Start a supervisor daemon in detached mode.
 * Returns the child process PID.
 */
export async function startDaemonDetached(name: string): Promise<number> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "daemon", "supervisor-worker.js");
  const packageRoot = path.resolve(__dirname, "..");

  const logDir = getSupervisorDir(name);
  await mkdir(logDir, { recursive: true });
  const logFd = openSync(path.join(logDir, "daemon.log"), "a");

  const child = spawn(process.execPath, [workerPath, name], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: packageRoot,
    env: process.env,
  });
  child.unref();
  closeSync(logFd);

  return child.pid ?? 0;
}
