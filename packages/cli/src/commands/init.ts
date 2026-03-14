import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const execFileAsync = promisify(execFile);

async function detectDefaultBranch(): Promise<string> {
  // Try remote HEAD first (works even on a feature branch)
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    // Returns e.g. "refs/remotes/origin/main" → extract "main"
    const ref = stdout.trim();
    const branch = ref.replace(/^refs\/remotes\/origin\//, "");
    if (branch && branch !== ref) return branch;
  } catch {
    // origin/HEAD may not be set — fall through
  }

  // Fallback: check if common default branch names exist locally
  for (const candidate of ["main", "master"]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      // branch doesn't exist — try next
    }
  }

  return "main";
}

const DEFAULT_CONFIG = (budget: number, branch: string) => `repos:
  - path: "."
    defaultBranch: ${branch}
concurrency:
  maxSessions: 5
  maxPerRepo: 2
budget:
  dailyCapUsd: ${budget}
  alertThresholdPct: 80
`;

const DIRS = ["agents", "runs", "journals"];

export default defineCommand({
  meta: {
    name: "init",
    description: "Initialize a .neo/ project directory (config, agents, journals)",
  },
  args: {
    budget: {
      type: "string",
      description: "Daily budget cap in USD",
      default: "500",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing configuration",
      default: false,
    },
  },
  async run({ args }) {
    const configPath = path.resolve(".neo/config.yml");

    if (existsSync(configPath) && !args.force) {
      printError(".neo/config.yml already exists. Use --force to overwrite.");
      process.exit(1);
    }

    // Create .neo/ structure
    await mkdir(path.resolve(".neo"), { recursive: true });
    for (const dir of DIRS) {
      await mkdir(path.resolve(`.neo/${dir}`), { recursive: true });
    }

    // Write config
    const budget = Number(args.budget);
    const branch = await detectDefaultBranch();
    await writeFile(configPath, DEFAULT_CONFIG(budget, branch), "utf-8");
    printSuccess(`Created .neo/config.yml (budget: $${budget}/day, branch: ${branch})`);

    printSuccess("neo initialized. Run 'neo doctor' to verify setup.");
  },
});
