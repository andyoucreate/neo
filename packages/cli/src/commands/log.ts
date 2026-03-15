import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { getSupervisorDir } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const VALID_TYPES = ["decision", "action", "blocker", "progress"] as const;

const TYPE_MAP: Record<string, string> = {
  decision: "decision",
  action: "action",
  blocker: "error",
  progress: "event",
};

export default defineCommand({
  meta: {
    name: "log",
    description: "Log a structured progress report to the supervisor activity log",
  },
  args: {
    type: {
      type: "positional",
      description: "Report type: decision, action, blocker, progress",
      required: true,
    },
    message: {
      type: "positional",
      description: "Message to log",
      required: true,
    },
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: "supervisor",
    },
  },
  async run({ args }) {
    const type = args.type as string;
    if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
      printError(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const dir = getSupervisorDir(args.name);
    const activityPath = `${dir}/activity.jsonl`;

    const entry = {
      id: randomUUID(),
      type: TYPE_MAP[type] ?? "event",
      summary: args.message,
      timestamp: new Date().toISOString(),
    };

    await appendFile(activityPath, `${JSON.stringify(entry)}\n`, "utf-8");
    printSuccess(`Logged: [${type}] ${args.message.slice(0, 100)}`);
  },
});
