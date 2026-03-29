import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import {
  getSupervisorActivityPath,
  getSupervisorDir,
  getSupervisorInboxPath,
  getSupervisorLockPath,
  isProcessAlive,
  loadGlobalConfig,
} from "@neotx/core";
import { defineCommand } from "citty";
import { isDaemonRunning, startDaemonDetached } from "../daemon-utils.js";
import { printError, printSuccess } from "../output.js";

const DEFAULT_NAME = "supervisor";

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

  const result = await startDaemonDetached(name);

  if (result.error) {
    printError(`Failed to start supervisor daemon: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const config = await loadGlobalConfig();

  printSuccess(`Supervisor "${name}" started (PID ${result.pid})`);
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

async function handleChildMode(
  parentName: string,
  objective: string | undefined,
  criteriaStr: string | undefined,
  budgetStr: string | undefined,
): Promise<void> {
  if (!objective) {
    printError("--objective is required when using --parent");
    process.exitCode = 1;
    return;
  }

  if (!criteriaStr) {
    printError("--criteria is required when using --parent");
    process.exitCode = 1;
    return;
  }

  const running = await isDaemonRunning(parentName);
  if (!running) {
    printError(`Parent supervisor "${parentName}" is not running.`);
    printError("Start it first with: neo supervise --detach");
    process.exitCode = 1;
    return;
  }

  const criteria = criteriaStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const budget = budgetStr ? Number.parseFloat(budgetStr) : undefined;

  const { spawnChildFromCli } = await import("../child-mode.js");

  const options: Parameters<typeof spawnChildFromCli>[0] = {
    parentName,
    objective,
    acceptanceCriteria: criteria,
  };
  if (budget !== undefined) {
    options.maxCostUsd = budget;
  }

  await spawnChildFromCli(options);
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
    parent: {
      type: "string",
      description: "Start as a child of an existing supervisor (registers via IPC)",
    },
    objective: {
      type: "string",
      description: "Objective for child supervisor (required with --parent)",
    },
    criteria: {
      type: "string",
      description: "Comma-separated acceptance criteria (required with --parent)",
    },
    budget: {
      type: "string",
      description: "Max cost in USD for child supervisor",
    },
  },
  async run({ args }) {
    const name = args.name;

    if (args.parent) {
      await handleChildMode(args.parent, args.objective, args.criteria, args.budget);
      return;
    }

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
