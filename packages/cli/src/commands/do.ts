import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { getSupervisorActivityPath, getSupervisorInboxPath } from "@neotx/core";
import { defineCommand } from "citty";
import { isDaemonRunning, startDaemonDetached } from "../daemon-utils.js";
import { printError, printSuccess } from "../output.js";

const DEFAULT_NAME = "supervisor";

export default defineCommand({
  meta: {
    name: "do",
    description: "Send a task to the supervisor (alias for neo supervise --message)",
  },
  args: {
    task: {
      type: "positional",
      description: "Task description to send to the supervisor",
      required: true,
    },
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: DEFAULT_NAME,
    },
    detach: {
      type: "boolean",
      alias: "d",
      description: "Start supervisor in background if not running",
      default: false,
    },
  },
  async run({ args }) {
    const name = args.name as string;
    const task = args.task as string;

    let running = await isDaemonRunning(name);

    if (!running) {
      if (args.detach) {
        const pid = await startDaemonDetached(name);
        printSuccess(`Supervisor "${name}" started (PID ${pid})`);
        // Wait briefly for daemon to initialize
        await new Promise((r) => setTimeout(r, 1500));
        running = await isDaemonRunning(name);
      } else {
        printError(`No supervisor daemon running (name: ${name}).`);
        printError("Use --detach to start one, or run: neo supervise");
        process.exitCode = 1;
        return;
      }
    }

    // Send message to inbox
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const message = { id, from: "api" as const, text: task, timestamp };

    await appendFile(getSupervisorInboxPath(name), `${JSON.stringify(message)}\n`, "utf-8");

    // Also write to activity.jsonl for TUI visibility
    const activityEntry = { id, type: "message", summary: task, timestamp };
    await appendFile(
      getSupervisorActivityPath(name),
      `${JSON.stringify(activityEntry)}\n`,
      "utf-8",
    );

    printSuccess(`Task sent to supervisor "${name}"`);
    console.log(`  Task: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}`);
    console.log(`  Status: neo supervise --status`);
    console.log(`  TUI: neo supervise`);
  },
});
