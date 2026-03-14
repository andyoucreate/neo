import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CostEntry } from "@neotx/core";
import { getJournalsDir, toRepoSlug } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printTable } from "../output.js";
import { resolveRepoFilter } from "../repo-filter.js";

async function readCostEntries(journalDir: string): Promise<CostEntry[]> {
  if (!existsSync(journalDir)) return [];
  const files = await readdir(journalDir);
  const costFiles = files
    .filter((f) => f.startsWith("cost-"))
    .sort()
    .reverse();
  const entries: CostEntry[] = [];

  for (const file of costFiles) {
    const content = await readFile(path.join(journalDir, file), "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as CostEntry);
    }
  }

  return entries;
}

function isToday(timestamp: string): boolean {
  const d = new Date(timestamp);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

export default defineCommand({
  meta: {
    name: "cost",
    description: "Show cost breakdown from journals (today, by agent, by run)",
  },
  args: {
    all: {
      type: "boolean",
      description:
        "Show costs from all registered repos with per-repo breakdown (default: current repo only)",
      default: false,
    },
    repo: {
      type: "string",
      description: "Filter costs by repo name or path",
    },
    short: {
      type: "boolean",
      description: "One-liner output optimized for supervisor agents: today=$X sessions=N agent=$Y",
      default: false,
    },
    output: {
      type: "string",
      description:
        "Output format: 'json' for structured output with today/allTime/byAgent (default: human-readable)",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const journalDir = getJournalsDir();
    let entries = await readCostEntries(journalDir);

    if (entries.length === 0) {
      printError("No cost data found.");
      process.exitCode = 1;
      return;
    }

    // Filter by repo unless --all
    const filter = await resolveRepoFilter({ all: args.all, repo: args.repo });
    if (filter.mode !== "all") {
      const slug = filter.repoSlug;
      entries = entries.filter((e) => {
        if (!e.repo) return false;
        return toRepoSlug({ path: e.repo }) === slug;
      });
    }

    const todayEntries = entries.filter((e) => isToday(e.timestamp));
    const todayTotal = todayEntries.reduce((sum, e) => sum + e.costUsd, 0);
    const allTimeTotal = entries.reduce((sum, e) => sum + e.costUsd, 0);

    // Breakdown by agent (today)
    const byAgent = new Map<string, { cost: number; runs: number }>();
    for (const e of todayEntries) {
      const prev = byAgent.get(e.agent) ?? { cost: 0, runs: 0 };
      byAgent.set(e.agent, { cost: prev.cost + e.costUsd, runs: prev.runs + 1 });
    }

    // Breakdown by repo (today, only in --all mode)
    const byRepo = new Map<string, { cost: number; runs: number }>();
    if (filter.mode === "all") {
      for (const e of todayEntries) {
        const repo = e.repo ?? "unknown";
        const prev = byRepo.get(repo) ?? { cost: 0, runs: 0 };
        byRepo.set(repo, { cost: prev.cost + e.costUsd, runs: prev.runs + 1 });
      }
    }

    if (jsonOutput) {
      printJson({
        today: {
          total: todayTotal,
          sessions: todayEntries.length,
          byAgent: Object.fromEntries(byAgent),
          ...(byRepo.size > 0 ? { byRepo: Object.fromEntries(byRepo) } : {}),
        },
        allTime: {
          total: allTimeTotal,
          sessions: entries.length,
        },
      });
      return;
    }

    if (args.short) {
      const agents = [...byAgent.entries()]
        .map(([name, data]) => `${name}=$${data.cost.toFixed(4)}`)
        .join(" ");
      console.log(`today=$${todayTotal.toFixed(4)} sessions=${todayEntries.length} ${agents}`);
      return;
    }

    console.log(`Today:    $${todayTotal.toFixed(4)} (${todayEntries.length} sessions)`);
    console.log(`All time: $${allTimeTotal.toFixed(4)} (${entries.length} sessions)`);

    if (byAgent.size > 0) {
      console.log("");
      printTable(
        ["AGENT", "COST TODAY", "SESSIONS"],
        [...byAgent.entries()]
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([name, data]) => [name, `$${data.cost.toFixed(4)}`, String(data.runs)]),
      );
    }

    if (byRepo.size > 0) {
      console.log("");
      printTable(
        ["REPO", "COST TODAY", "SESSIONS"],
        [...byRepo.entries()]
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([repo, data]) => [repo, `$${data.cost.toFixed(4)}`, String(data.runs)]),
      );
    }
  },
});
