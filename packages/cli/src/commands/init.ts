import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { addRepoToGlobalConfig, getDataDir, loadGlobalConfig } from "@neotx/core";
import { defineCommand } from "citty";
import { detectDefaultBranch } from "../git-utils.js";
import { printError, printSuccess } from "../output.js";

const GITIGNORE_ENTRY = ".neo/worktrees/";

async function ensureGitignore(): Promise<boolean> {
  const gitignorePath = path.resolve(".gitignore");

  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (content.includes(GITIGNORE_ENTRY)) return false;
    await appendFile(gitignorePath, `\n# neo worktrees (ephemeral)\n${GITIGNORE_ENTRY}\n`);
  } else {
    await appendFile(gitignorePath, `# neo worktrees (ephemeral)\n${GITIGNORE_ENTRY}\n`);
  }

  return true;
}

export default defineCommand({
  meta: {
    name: "init",
    description: "Initialize a .neo/ project directory and register the repo",
  },
  args: {
    force: {
      type: "boolean",
      description:
        "Re-register even if .neo/agents/ already exists — overwrites config and re-detects branch",
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

    // Ensure .neo/worktrees/ is in .gitignore
    if (await ensureGitignore()) {
      printSuccess(`Added ${GITIGNORE_ENTRY} to .gitignore`);
    }

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
