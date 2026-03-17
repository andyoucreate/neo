import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSupervisorActivityPath,
  getSupervisorDir,
  getSupervisorInboxPath,
  getSupervisorLockPath,
  getSupervisorStatePath,
  loadGlobalConfig,
  type SupervisorDaemonState,
  supervisorDaemonStateSchema,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const DEFAULT_NAME = "supervisor";

async function readState(name: string): Promise<SupervisorDaemonState | null> {
  const statePath = getSupervisorStatePath(name);
  if (!existsSync(statePath)) return null;
  try {
    const raw = await readFile(statePath, "utf-8");
    return supervisorDaemonStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isDaemonRunning(name: string): Promise<SupervisorDaemonState | null> {
  const state = await readState(name);
  if (!state || state.status === "stopped") return null;
  if (!isProcessAlive(state.pid)) return null;
  return state;
}

async function handleStatus(name: string): Promise<void> {
  const state = await isDaemonRunning(name);
  if (!state) {
    console.log(`No supervisor daemon running (name: ${name}).`);
    return;
  }

  const config = await loadGlobalConfig();
  printSuccess(`Supervisor "${name}" running`);
  console.log(`  PID:        ${state.pid}`);
  console.log(`  Port:       ${state.port}`);
  console.log(`  Session:    ${state.sessionId}`);
  console.log(`  Started:    ${state.startedAt}`);
  console.log(`  Timeout:    ${config.supervisor.eventTimeoutMs / 1000}s`);
  console.log(`  Heartbeats: ${state.heartbeatCount}`);
  if (state.lastHeartbeat) {
    console.log(`  Last beat:  ${state.lastHeartbeat}`);
  }
  console.log(`  Cost today: $${state.todayCostUsd?.toFixed(2) ?? "0.00"}`);
  console.log(`  Cost total: $${state.totalCostUsd?.toFixed(2) ?? "0.00"}`);
  console.log(`  Status:     ${state.status}`);
  console.log("");
  console.log(`  Health:   curl localhost:${state.port}/health`);
  console.log("  TUI:      neo supervise");
  console.log("  Stop:     neo supervise --kill");
}

async function handleKill(name: string): Promise<void> {
  const state = await isDaemonRunning(name);
  if (!state) {
    printError(`No supervisor daemon running (name: ${name}).`);

    // Clean up stale lock if exists
    const lockPath = getSupervisorLockPath(name);
    if (existsSync(lockPath)) {
      await rm(lockPath, { force: true });
    }
    process.exitCode = 1;
    return;
  }

  // Send SIGTERM for graceful shutdown, then SIGKILL after 10s
  const pid = state.pid;
  try {
    process.kill(pid, "SIGTERM");
    printSuccess(`Sent SIGTERM to supervisor "${name}" (PID ${pid})`);
  } catch {
    printError(`Failed to send signal to PID ${pid}. Cleaning up.`);
    const lockPath = getSupervisorLockPath(name);
    await rm(lockPath, { force: true });
    return;
  }

  // Wait up to 10s for graceful exit, then force kill
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessAlive(pid)) {
      printSuccess("Daemon stopped.");
      return;
    }
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
    printSuccess(`Daemon did not exit in time — sent SIGKILL (PID ${pid}).`);
  } catch {
    // Already dead
  }

  // Clean up lock
  const lockPath = getSupervisorLockPath(name);
  await rm(lockPath, { force: true });
}

async function startDaemon(name: string): Promise<void> {
  const running = await isDaemonRunning(name);
  if (running) {
    printError(`Supervisor "${name}" is already running (PID ${running.pid}).`);
    printError("Use --kill first, or run neo supervise to open TUI.");
    process.exitCode = 1;
    return;
  }

  // Clean up stale lock
  const lockPath = getSupervisorLockPath(name);
  if (existsSync(lockPath)) {
    await rm(lockPath, { force: true });
  }

  // Resolve the worker script path and package root (for module resolution)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "daemon", "supervisor-worker.js");
  const packageRoot = path.resolve(__dirname, "..");

  // Spawn as detached child process with stdio to log file
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

  const config = await loadGlobalConfig();
  printSuccess(`Supervisor "${name}" started (PID ${child.pid})`);
  console.log(`  Port:     ${config.supervisor.port}`);
  console.log(`  Health:   curl localhost:${config.supervisor.port}/health`);
  console.log(`  Webhook:  curl -X POST localhost:${config.supervisor.port}/webhook -d '{}'`);
  console.log(`  Logs:     ${getSupervisorDir(name)}/daemon.log`);
  console.log(`  TUI:      neo supervise`);
  console.log(`  Status:   neo supervise --status`);
  console.log(`  Stop:     neo supervise --kill`);
}

async function handleAttach(name: string): Promise<void> {
  const running = await isDaemonRunning(name);
  if (!running) {
    printError(`No supervisor daemon running (name: ${name}).`);
    printError("Start with: neo supervise");
    process.exitCode = 1;
    return;
  }

  const { renderSupervisorTui } = await import("../tui/index.js");
  await renderSupervisorTui(name);
}

async function handleMessage(name: string, text: string): Promise<void> {
  const running = await isDaemonRunning(name);
  if (!running) {
    printError(`No supervisor daemon running (name: ${name}).`);
    process.exitCode = 1;
    return;
  }

  const id = randomUUID();
  const timestamp = new Date().toISOString();

  const message = { id, from: "api" as const, text, timestamp };
  await appendFile(getSupervisorInboxPath(name), `${JSON.stringify(message)}\n`, "utf-8");

  // Write to activity.jsonl so the message appears in the TUI conversation
  const activityEntry = { id, type: "message", summary: text, timestamp };
  await appendFile(getSupervisorActivityPath(name), `${JSON.stringify(activityEntry)}\n`, "utf-8");

  printSuccess(`Message sent to supervisor "${name}".`);
}

export default defineCommand({
  meta: {
    name: "supervise",
    description: "Manage the autonomous supervisor daemon",
  },
  args: {
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: DEFAULT_NAME,
    },
    status: {
      type: "boolean",
      description: "Show supervisor status",
      default: false,
    },
    kill: {
      type: "boolean",
      description: "Stop the running supervisor",
      default: false,
    },
    attach: {
      type: "boolean",
      description: "Open the TUI for a running supervisor (default when no flags given)",
      default: false,
    },
    detach: {
      type: "boolean",
      alias: "d",
      description: "Start daemon in the background without opening the TUI",
      default: false,
    },
    message: {
      type: "string",
      description: "Send a message to the supervisor inbox",
    },
  },
  async run({ args }) {
    const name = args.name;

    if (args.status) {
      await handleStatus(name);
      return;
    }

    if (args.kill) {
      await handleKill(name);
      return;
    }

    if (args.attach) {
      await handleAttach(name);
      return;
    }

    if (args.message) {
      await handleMessage(name, args.message);
      return;
    }

    // --detach: start daemon headless (no TUI)
    if (args.detach) {
      const alreadyRunning = await isDaemonRunning(name);
      if (alreadyRunning) {
        printSuccess(`Supervisor "${name}" already running (PID ${alreadyRunning.pid}).`);
        return;
      }
      await startDaemon(name);
      return;
    }

    // Default: start daemon if needed, then open TUI
    const alreadyRunning = await isDaemonRunning(name);
    if (!alreadyRunning) {
      await startDaemon(name);
      // Wait briefly for daemon to initialize before attaching
      await new Promise((r) => setTimeout(r, 1500));
    }
    await handleAttach(name);
  },
});
