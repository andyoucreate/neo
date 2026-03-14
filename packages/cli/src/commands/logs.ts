import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getJournalsDir } from "@neo-cli/core";
import { defineCommand } from "citty";
import { printError, printJson } from "../output.js";

interface JournalEvent {
  type?: string;
  timestamp: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  [key: string]: unknown;
}

async function readJournalLines(journalDir: string, filePrefix: string): Promise<JournalEvent[]> {
  if (!existsSync(journalDir)) return [];
  const files = await readdir(journalDir);
  const matching = files
    .filter((f) => f.startsWith(filePrefix))
    .sort()
    .reverse();
  const events: JournalEvent[] = [];

  for (const file of matching) {
    const content = await readFile(path.join(journalDir, file), "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as JournalEvent);
    }
  }

  // Sort by timestamp descending (most recent first)
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events;
}

function formatEvent(event: JournalEvent, short: boolean): string {
  const ts = event.timestamp.slice(11, 19);
  const type = event.type ?? "cost";

  if (short) {
    // Ultra compact: one line, minimal tokens
    switch (type) {
      case "session:start":
        return `${ts} START ${event.agent} ${event.runId?.slice(0, 8) ?? ""}`;
      case "session:complete":
        return `${ts} OK    $${(event.costUsd ?? 0).toFixed(4)} ${event.durationMs ?? 0}ms`;
      case "session:fail":
        return `${ts} FAIL  ${event.error?.slice(0, 80) ?? ""}`;
      case "cost:update":
        return `${ts} COST  today=$${(event.todayTotal as number | undefined)?.toFixed(4) ?? "?"} remaining=${(event.budgetRemainingPct as number | undefined)?.toFixed(0) ?? "?"}%`;
      case "budget:alert":
        return `${ts} ALERT budget=${(event.utilizationPct as number | undefined)?.toFixed(0) ?? "?"}%`;
      default:
        return `${ts} ${type}`;
    }
  }

  switch (type) {
    case "session:start":
      return `[${ts}] session:start   agent=${event.agent} run=${event.runId?.slice(0, 8) ?? "?"}`;
    case "session:complete":
      return `[${ts}] session:done    cost=$${(event.costUsd ?? 0).toFixed(4)} duration=${event.durationMs ?? 0}ms`;
    case "session:fail":
      return `[${ts}] session:fail    error=${event.error ?? "unknown"}`;
    case "cost:update":
      return `[${ts}] cost:update     today=$${(event.todayTotal as number | undefined)?.toFixed(4) ?? "?"} remaining=${(event.budgetRemainingPct as number | undefined)?.toFixed(0) ?? "?"}%`;
    case "budget:alert":
      return `[${ts}] budget:alert    utilization=${(event.utilizationPct as number | undefined)?.toFixed(0) ?? "?"}%`;
    default:
      return `[${ts}] ${type}`;
  }
}

export default defineCommand({
  meta: {
    name: "logs",
    description: "Show event logs from journals (session starts, completions, failures, costs)",
  },
  args: {
    last: {
      type: "string",
      description: "Show only the last N events (default: 20)",
      default: "20",
    },
    type: {
      type: "string",
      description:
        "Filter by event type: session:start, session:complete, session:fail, cost:update, budget:alert",
    },
    run: {
      type: "string",
      description: "Filter by run ID (prefix match)",
    },
    short: {
      type: "boolean",
      description: "Compact output for supervisor agents (saves tokens)",
      default: false,
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const journalDir = getJournalsDir();

    let events = await readJournalLines(journalDir, "events-");

    if (events.length === 0) {
      printError("No event logs found.");
      process.exitCode = 1;
      return;
    }

    // Filter by type
    if (args.type) {
      events = events.filter((e) => e.type === args.type);
    }

    // Filter by run
    if (args.run) {
      events = events.filter((e) => e.runId?.startsWith(args.run as string));
    }

    // Limit
    const limit = Number(args.last);
    events = events.slice(0, limit);

    if (jsonOutput) {
      printJson(events);
      return;
    }

    for (const event of events.reverse()) {
      console.log(formatEvent(event, args.short));
    }
  },
});
