import { getSupervisorDir, StatusReader, type SupervisorStatus } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess } from "../../output.js";

const DEFAULT_NAME = "supervisor";

function formatUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const seconds = Math.floor(diffMs / 1000) % 60;
  const minutes = Math.floor(diffMs / (1000 * 60)) % 60;
  const hours = Math.floor(diffMs / (1000 * 60 * 60)) % 24;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatStatus(status: SupervisorStatus): void {
  const stateColor = status.status === "running" ? "32" : status.status === "idle" ? "33" : "31";
  const stateDisplay = `\x1b[${stateColor}m${status.status}\x1b[0m`;

  printSuccess(`Supervisor running (PID ${status.pid})`);
  console.log(`  State:       ${stateDisplay}`);
  console.log(`  Uptime:      ${formatUptime(status.startedAt)}`);
  console.log(`  Active runs: ${status.activeRunCount}`);
  console.log(`  Heartbeats:  ${status.heartbeatCount}`);
  console.log(`  Last beat:   ${status.lastHeartbeat}`);
  console.log(`  Cost today:  $${status.todayCostUsd.toFixed(2)}`);
  console.log(`  Cost total:  $${status.totalCostUsd.toFixed(2)}`);

  if (status.recentActivitySummary.length > 0) {
    console.log("\nRecent activity:");
    for (const activity of status.recentActivitySummary.slice(0, 5)) {
      console.log(`  • ${activity}`);
    }
  }
}

export default defineCommand({
  meta: {
    name: "status",
    description: "Show current supervisor status",
  },
  args: {
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: DEFAULT_NAME,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const name = args.name;
    const dataDir = getSupervisorDir(name);
    const reader = new StatusReader(dataDir);

    const status = await reader.getStatus();

    if (!status) {
      if (args.json) {
        printJson({ running: false, error: "Supervisor is not running" });
        return;
      }
      printError(`Supervisor "${name}" is not running.`);
      console.log("\nStart the supervisor with: neo supervise --detach");
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      printJson(status);
      return;
    }

    formatStatus(status);
  },
});
