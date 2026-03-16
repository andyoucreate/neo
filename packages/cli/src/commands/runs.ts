import type { PersistedRun } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printTable } from "../output.js";
import { loadRunsFiltered, resolveRepoFilter } from "../repo-filter.js";

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
      Object.values(r.steps)[0]?.agent ?? "unknown",
      `$${totalCost(r).toFixed(4)}`,
      formatDuration(totalDuration(r)),
      r.branch?.replace("feat/run-", "").slice(0, 8) ?? "-",
    ]),
  );
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
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
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

    // If a runId is given (full or prefix), show details
    if (args.runId) {
      const match = runs.find(
        (r) => r.runId === args.runId || r.runId.startsWith(args.runId as string),
      );
      if (!match) {
        printError(`Run "${args.runId}" not found.`);
        process.exitCode = 1;
        return;
      }

      if (jsonOutput) {
        printJson(match);
        return;
      }

      showRunDetail(match, args.short);
      return;
    }

    // List mode
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
          agent: Object.values(r.steps)[0]?.agent ?? "unknown",
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
