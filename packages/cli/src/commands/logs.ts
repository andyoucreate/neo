import { existsSync, watch } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedRun } from "@neotx/core";
import { getJournalsDir, getRepoRunsDir, getRunLogPath, getRunsDir } from "@neotx/core";
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

/**
 * Find the log file for a run by searching all repo slug directories.
 */
async function findRunLogPath(runId: string): Promise<string | null> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return null;

  const slugs = await readdir(runsDir, { withFileTypes: true });
  for (const entry of slugs) {
    if (!entry.isDirectory()) continue;
    const logPath = getRunLogPath(entry.name, runId);
    if (existsSync(logPath)) return logPath;
    // Also try prefix match on runId
    const runFile = path.join(getRepoRunsDir(entry.name), `${runId}.json`);
    if (existsSync(runFile)) return logPath;
  }
  return null;
}

/**
 * Tail a log file, printing new content as it appears.
 * Stops when the run completes or the user presses Ctrl+C.
 */
async function followRunLog(runId: string): Promise<void> {
  const logPath = await findRunLogPath(runId);
  if (!logPath) {
    printError(`No log file found for run ${runId}. Is it a detached run?`);
    process.exitCode = 1;
    return;
  }

  // Print existing content
  if (existsSync(logPath)) {
    const existing = await readFile(logPath, "utf-8");
    if (existing) process.stdout.write(existing);
  }

  // Find persisted run to check status
  const runDir = path.dirname(logPath);
  const runJsonPath = path.join(runDir, `${runId}.json`);

  // Check if already finished
  if (existsSync(runJsonPath)) {
    const runData = JSON.parse(await readFile(runJsonPath, "utf-8")) as PersistedRun;
    if (runData.status === "completed" || runData.status === "failed") {
      return;
    }
  }

  // Watch for changes
  let offset = existsSync(logPath)
    ? await open(logPath, "r").then(async (fh) => {
        const stat = await fh.stat();
        await fh.close();
        return stat.size;
      })
    : 0;

  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());

  try {
    const watcher = watch(logPath, { signal: ac.signal });
    watcher.on("change", async () => {
      try {
        const fh = await open(logPath, "r");
        const stat = await fh.stat();
        if (stat.size > offset) {
          const buf = Buffer.alloc(stat.size - offset);
          await fh.read(buf, 0, buf.length, offset);
          process.stdout.write(buf);
          offset = stat.size;
        }
        await fh.close();

        // Check if run is done
        if (existsSync(runJsonPath)) {
          const runData = JSON.parse(await readFile(runJsonPath, "utf-8")) as PersistedRun;
          if (runData.status === "completed" || runData.status === "failed") {
            ac.abort();
          }
        }
      } catch (err) {
        // Ignore read errors during follow
        console.debug(
          `[logs] Read error during follow: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err;
  }
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
    follow: {
      type: "boolean",
      alias: "f",
      description: "Follow a detached run log in real time (requires --run)",
      default: false,
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    // Follow mode: tail a detached run's log file
    if (args.follow) {
      if (!args.run) {
        printError("--follow requires --run <runId>");
        process.exitCode = 1;
        return;
      }
      await followRunLog(args.run);
      return;
    }

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
