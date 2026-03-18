import { type ActivityEntry, getSupervisorDir, StatusReader } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printTable } from "../../output.js";

const DEFAULT_NAME = "supervisor";
const DEFAULT_LIMIT = 50;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatActivityTable(entries: ActivityEntry[]): void {
  const headers = ["Timestamp", "Type", "Summary"];
  const rows = entries.map((e) => [formatTimestamp(e.timestamp), e.type, e.summary]);
  printTable(headers, rows);
}

export default defineCommand({
  meta: {
    name: "activity",
    description: "Show supervisor activity log",
  },
  args: {
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: DEFAULT_NAME,
    },
    type: {
      type: "string",
      description: "Filter by activity type (decision, action, discovery, error)",
    },
    since: {
      type: "string",
      description: "Show activity since this ISO timestamp",
    },
    until: {
      type: "string",
      description: "Show activity until this ISO timestamp",
    },
    limit: {
      type: "string",
      description: "Maximum number of entries to show",
      default: String(DEFAULT_LIMIT),
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

    const limit = Number.parseInt(args.limit, 10) || DEFAULT_LIMIT;
    const type = args.type as "decision" | "action" | "discovery" | "error" | undefined;

    const entries = reader.queryActivity({
      type,
      since: args.since,
      until: args.until,
      limit,
    });

    if (entries.length === 0) {
      if (args.json) {
        printJson([]);
        return;
      }
      printError("No activity found");
      return;
    }

    if (args.json) {
      printJson(entries);
      return;
    }

    formatActivityTable(entries);
  },
});
