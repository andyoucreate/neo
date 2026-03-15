import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { addRepoToGlobalConfig, getDataDir, loadGlobalConfig } from "@neotx/core";
import { defineCommand } from "citty";
import { detectDefaultBranch } from "../git-utils.js";
import { printError, printSuccess } from "../output.js";

async function ensureGitignore(): Promise<boolean> {
  // Session clones are stored in /tmp/neo-sessions/ by default,
  // so no .gitignore entry is needed. Keep the function for future use.
  return false;
}

export default defineCommand({
  meta: {
    name: "init",
    description: "Initialize a .neo/ project directory and register the repo",
  },
  args: {
    force: {
      type: "boolean",
      description: "Re-register even if already initialized",
      default: false,
    },
  },
  async run({ args }) {
    const agentsDir = path.resolve(".neo/agents");

    if (existsSync(agentsDir) && !args.force) {
      printError(".neo/agents/ already exists. Use --force to re-register.");
      process.exitCode = 1;
      return;
    }

    // Create .neo/agents/ for project-local agent definitions
    await mkdir(agentsDir, { recursive: true });
    printSuccess("Created .neo/agents/");

    await ensureGitignore();

    // Detect default branch and register repo in global config
    const branch = await detectDefaultBranch();
    const repoPath = path.resolve(".");

    await addRepoToGlobalConfig({
      path: repoPath,
      defaultBranch: branch,
    });
    printSuccess(`Registered repo in global config (branch: ${branch})`);

    // Ensure global config exists (creates with defaults if missing)
    const globalConfig = await loadGlobalConfig();
    const globalDir = getDataDir();
    printSuccess(
      `Global config at ${globalDir}/config.yml (budget: $${globalConfig.budget.dailyCapUsd}/day)`,
    );

    printSuccess("neo initialized. Run 'neo doctor' to verify setup.");
  },
});
