import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedRun } from "@neotx/core";
import { getRunsDir } from "@neotx/core";
import chokidar from "chokidar";
import { defineCommand } from "citty";
import { printError, printJson, printTable } from "../output.js";
import { loadRunsFiltered, resolveRepoFilter } from "../repo-filter.js";

type RunStatus = "running" | "paused" | "completed" | "failed" | "blocked";

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "blocked"]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status as RunStatus);
}

/**
 * Find the JSON file path for a given runId.
 * Checks ~/.neo/runs/<slug>/<runId>.json first, then legacy ~/.neo/runs/<runId>.json.
 * Returns null if not found.
 */
export async function findRunFilePath(runId: string): Promise<string | null> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return null;

  // Search in slug subdirectories
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(runsDir, entry.name, `${runId}.json`);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore readdir errors
  }

  // Legacy: directly under runs dir
  const legacy = path.join(runsDir, `${runId}.json`);
  if (existsSync(legacy)) return legacy;

  return null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function totalCost(run: PersistedRun): number {
  return Object.values(run.steps).reduce((sum, s) => sum + s.costUsd, 0);
}

function totalDuration(run: PersistedRun): number {
  return Object.values(run.steps).reduce((sum, s) => sum + s.durationMs, 0);
}

function shortId(runId: string): string {
  return runId.slice(0, 8);
}

function repoName(run: PersistedRun): string {
  return run.repo.split("/").pop() ?? run.repo;
}

function agentName(run: PersistedRun): string {
  if (run.agent) return run.agent;

  const stepAgent = Object.values(run.steps)[0]?.agent;
  return stepAgent ?? "unknown";
}

function showRunDetail(match: PersistedRun, short: boolean): void {
  if (short) {
    console.log(`${match.runId} ${match.status} $${totalCost(match).toFixed(4)}`);
    for (const [name, step] of Object.entries(match.steps)) {
      const out = typeof step.output === "string" ? step.output.slice(0, 200) : "";
      console.log(`  ${name}: ${step.status} ${step.agent} ${out}`);
    }
    return;
  }

  console.log(`Run:      ${match.runId}`);
  console.log(`Status:   ${match.status}`);
  console.log(`Repo:     ${match.repo}`);
  console.log(`Prompt:   ${match.prompt}`);
  if (match.branch) console.log(`Branch:   ${match.branch}`);
  console.log(`Cost:     $${totalCost(match).toFixed(4)}`);
  console.log(`Duration: ${formatDuration(totalDuration(match))}`);
  console.log(`Created:  ${match.createdAt}`);
  console.log("");
  for (const [name, step] of Object.entries(match.steps)) {
    console.log(`Step: ${name}`);
    console.log(`  Agent:    ${step.agent}`);
    console.log(`  Status:   ${step.status}`);
    console.log(`  Cost:     $${step.costUsd.toFixed(4)}`);
    console.log(`  Duration: ${formatDuration(step.durationMs)}`);
    if (step.error) console.log(`  Error:    ${step.error}`);
    if (step.output) {
      const out = typeof step.output === "string" ? step.output : JSON.stringify(step.output);
      console.log(`  Output:   ${out}`);
    }
  }
}

function listRuns(runs: PersistedRun[], short: boolean): void {
  if (short) {
    for (const r of runs) {
      const agent = Object.values(r.steps)[0]?.agent ?? "?";
      console.log(
        `${shortId(r.runId)} ${r.status.padEnd(9)} ${repoName(r).padEnd(14)} ${agent.padEnd(18)} $${totalCost(r).toFixed(4).padStart(8)} ${formatDuration(totalDuration(r)).padStart(7)}`,
      );
    }
    return;
  }

  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  printTable(
    ["RUN", "STATUS", "REPO", "AGENT", "COST", "DURATION", "BRANCH"],
    runs.map((r) => [
      shortId(r.runId),
      r.status,
      repoName(r),
      agentName(r),
      `$${totalCost(r).toFixed(4)}`,
      formatDuration(totalDuration(r)),
      r.branch?.replace("feat/run-", "").slice(0, 8) ?? "-",
    ]),
  );
}

async function watchRun(runId: string, match: PersistedRun): Promise<void> {
  // Initial render
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(`Watching ${runId} \u2014 Ctrl+C to stop`);
  showRunDetail(match, false);

  // Already terminal — no need to watch
  if (isTerminal(match.status)) return;

  const filePath = await findRunFilePath(runId);
  if (!filePath) {
    printError(`Could not locate run file for "${runId}".`);
    process.exitCode = 1;
    return;
  }

  await new Promise<void>((resolve) => {
    const watcher = chokidar.watch(filePath, { ignoreInitial: true });

    function cleanup(): void {
      watcher.close().catch(() => {});
      resolve();
    }

    watcher.on("change", async () => {
      try {
        const content = await readFile(filePath, "utf-8");
        const updated = JSON.parse(content) as PersistedRun;
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(`Watching ${runId} \u2014 Ctrl+C to stop`);
        showRunDetail(updated, false);
        if (isTerminal(updated.status)) cleanup();
      } catch {
        // Ignore transient read errors during file writes
      }
    });

    watcher.on("unlink", () => cleanup());
    watcher.on("error", () => cleanup());

    process.once("SIGINT", () => {
      cleanup();
    });
  });
}

export default defineCommand({
  meta: {
    name: "runs",
    description: "List runs or show details of a specific run",
  },
  args: {
    runId: {
      type: "positional",
      description: "Run ID to show details (omit to list all runs)",
      required: false,
    },
    repo: {
      type: "string",
      description: "Filter by repo name or path",
    },
    last: {
      type: "string",
      description: "Show only the last N runs",
    },
    status: {
      type: "string",
      description: "Filter by status: completed, failed, running",
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
    watch: {
      type: "boolean",
      description: "Watch the run file for updates (requires a runId)",
      default: false,
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";

    if (args.watch) {
      if (!args.runId) {
        printError("--watch requires a runId argument.");
        process.exitCode = 1;
        return;
      }
      if (jsonOutput) {
        printError("--watch is not compatible with --output json.");
        process.exitCode = 1;
        return;
      }
    }

    const filter = await resolveRepoFilter({ repo: args.repo });
    let runs = await loadRunsFiltered(filter);

    if (runs.length === 0) {
      if (!jsonOutput) {
        printError("No runs found. Run 'neo run <agent>' first.");
      } else {
        printJson([]);
      }
      return;
    }

    if (args.runId) {
      const match = runs.find(
        (r) => r.runId === args.runId || r.runId.startsWith(args.runId as string),
      );
      if (!match) {
        printError(`Run "${args.runId}" not found.`);
        process.exitCode = 1;
        return;
      }

      if (args.watch) {
        await watchRun(match.runId, match);
        return;
      }

      if (jsonOutput) {
        printJson(match);
        return;
      }

      showRunDetail(match, args.short);
      return;
    }

    if (args.status) {
      runs = runs.filter((r) => r.status === args.status);
    }

    if (args.last) {
      runs = runs.slice(0, Number(args.last));
    }

    if (jsonOutput) {
      printJson(
        runs.map((r) => ({
          runId: r.runId,
          status: r.status,
          repo: r.repo,
          agent: agentName(r),
          costUsd: totalCost(r),
          durationMs: totalDuration(r),
          branch: r.branch,
          updatedAt: r.updatedAt,
        })),
      );
      return;
    }

    listRuns(runs, args.short);
  },
});
