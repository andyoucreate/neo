import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir, loadGlobalConfig } from "@neo-cli/core";
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

const REPO_CONFIG = (branch: string) => `repos:
  - path: "."
    defaultBranch: ${branch}
`;

export default defineCommand({
  meta: {
    name: "init",
    description: "Initialize a .neo/ project directory (repo config + agents)",
  },
  args: {
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
      process.exitCode = 1;
      return;
    }

    // Create .neo/ structure (repo-level: config + agents only)
    await mkdir(path.resolve(".neo"), { recursive: true });
    await mkdir(path.resolve(".neo/agents"), { recursive: true });

    // Write repo config
    const branch = await detectDefaultBranch();
    await writeFile(configPath, REPO_CONFIG(branch), "utf-8");
    printSuccess(`Created .neo/config.yml (branch: ${branch})`);

    // Ensure global config exists at ~/.neo/config.yml (creates with defaults if missing)
    const globalConfig = await loadGlobalConfig();
    const globalDir = getDataDir();
    printSuccess(
      `Global config at ${globalDir}/config.yml (budget: $${globalConfig.budget.dailyCapUsd}/day)`,
    );

    printSuccess("neo initialized. Run 'neo doctor' to verify setup.");
  },
});
