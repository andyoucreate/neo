import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const execFileAsync = promisify(execFile);

async function detectDefaultBranch(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"]);
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
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

    // Install supervisor skills
    await installSkills();

    printSuccess("neo initialized. Run 'neo doctor' to verify setup.");
  },
});

function resolveSkillsDir(): string {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.dirname(distDir);
  return path.join(pkgRoot, "src", "skills");
}

async function installSkills(): Promise<void> {
  const skillsDir = path.resolve(".claude/skills/neo");
  await mkdir(skillsDir, { recursive: true });

  const srcDir = resolveSkillsDir();
  if (!existsSync(srcDir)) {
    printError("Skill templates not found. Skills not installed.");
    return;
  }

  const files = await readdir(srcDir);
  let count = 0;

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = await readFile(path.join(srcDir, file), "utf-8");
    await writeFile(path.join(skillsDir, file), content, "utf-8");
    count++;
  }

  printSuccess(`Installed ${count} supervisor skills to .claude/skills/neo/`);
}
