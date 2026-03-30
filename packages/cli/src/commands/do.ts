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
    to: {
      type: "string",
      alias: "t",
      description: "Target supervisor to route mission to",
      default: DEFAULT_NAME,
    },
    name: {
      type: "string",
      description: "Supervisor instance name (alias for --to)",
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
    // --to takes precedence over --name if specified, otherwise use --name or default
    const to = args.to as string | undefined;
    const nameArg = args.name as string | undefined;
    const name = to ?? nameArg ?? DEFAULT_NAME;
    const task = args.task as string;

    let running = await isDaemonRunning(name);

    if (!running) {
      if (args.detach) {
        const result = await startDaemonDetached(name);
        if (result.error) {
          printError(`Failed to start supervisor daemon: ${result.error}`);
          process.exitCode = 1;
          return;
        }
        printSuccess(`Supervisor "${name}" started (PID ${result.pid})`);
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
