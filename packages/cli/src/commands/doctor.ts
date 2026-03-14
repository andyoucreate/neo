import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AgentRegistry,
  getDataDir,
  getJournalsDir,
  listReposFromGlobalConfig,
  loadGlobalConfig,
  toRepoSlug,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";

const execFileAsync = promisify(execFile);

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "info";
  message?: string;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  if (major >= 22) {
    return { name: "Node.js", status: "pass", message: `v${version}` };
  }
  return { name: "Node.js", status: "fail", message: `v${version} (requires >= 22)` };
}

async function checkGit(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const match = stdout.match(/(\d+\.\d+)/);
    const version = match?.[1] ?? "unknown";
    const [major, minor] = version.split(".").map(Number);
    if ((major ?? 0) > 2 || ((major ?? 0) === 2 && (minor ?? 0) >= 20)) {
      return { name: "git", status: "pass", message: `v${version}` };
    }
    return { name: "git", status: "fail", message: `v${version} (requires >= 2.20)` };
  } catch {
    return { name: "git", status: "fail", message: "not installed" };
  }
}

async function checkGlobalConfig(): Promise<CheckResult> {
  try {
    const config = await loadGlobalConfig();
    const globalDir = getDataDir();
    const repoCount = config.repos.length;
    return {
      name: "Global config",
      status: "pass",
      message: `${globalDir}/config.yml (budget: $${config.budget.dailyCapUsd}/day, ${repoCount} repos)`,
    };
  } catch (error) {
    return {
      name: "Global config",
      status: "fail",
      message: `Invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkRepoRegistered(): Promise<CheckResult> {
  const cwd = process.cwd();
  const repos = await listReposFromGlobalConfig();
  const match = repos.find((r) => path.resolve(r.path) === cwd);

  if (match) {
    return {
      name: "Repo registered",
      status: "pass",
      message: `"${toRepoSlug(match)}" (branch: ${match.defaultBranch})`,
    };
  }

  return {
    name: "Repo registered",
    status: "info",
    message:
      "CWD not registered. Run 'neo init' or 'neo repos add'. Zero-config mode works without registration.",
  };
}

async function checkLegacyConfig(): Promise<CheckResult | null> {
  const legacyPath = path.resolve(".neo/config.yml");
  if (existsSync(legacyPath)) {
    return {
      name: "Legacy config",
      status: "info",
      message:
        ".neo/config.yml detected — this file is no longer needed. Config is now in ~/.neo/config.yml.",
    };
  }
  return null;
}

async function checkTmux(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("tmux", ["-V"]);
    return { name: "tmux", status: "pass", message: stdout.trim() };
  } catch {
    return {
      name: "tmux",
      status: "info",
      message: "not installed (required for neo supervise)",
    };
  }
}

async function checkClaudeCli(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"]);
    return { name: "Claude CLI", status: "pass", message: stdout.trim() };
  } catch {
    return { name: "Claude CLI", status: "fail", message: "not installed or not in PATH" };
  }
}

async function checkAgents(): Promise<CheckResult> {
  try {
    const agentsDir = resolveAgentsDir();
    if (!existsSync(agentsDir)) {
      return { name: "Agents", status: "fail", message: "Agent definitions not found" };
    }
    const registry = new AgentRegistry(agentsDir);
    await registry.load();
    const count = registry.list().length;
    return { name: "Agents", status: "pass", message: `${count} agents loaded` };
  } catch (error) {
    return {
      name: "Agents",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkJournalDirs(): Promise<CheckResult> {
  const journalDir = getJournalsDir();
  if (!existsSync(journalDir)) {
    return {
      name: "Journals",
      status: "pass",
      message: "Directory will be created on first write",
    };
  }
  try {
    await access(journalDir, constants.W_OK);
    return { name: "Journals", status: "pass", message: journalDir };
  } catch {
    return { name: "Journals", status: "fail", message: `${journalDir} is not writable` };
  }
}

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Check environment prerequisites (Node.js, git, config, Claude CLI)",
  },
  args: {
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";

    const checks = (
      await Promise.all([
        checkNodeVersion(),
        checkGit(),
        checkGlobalConfig(),
        checkRepoRegistered(),
        checkLegacyConfig(),
        checkTmux(),
        checkClaudeCli(),
        checkAgents(),
        checkJournalDirs(),
      ])
    ).filter((c): c is CheckResult => c !== null);

    if (jsonOutput) {
      printJson({ checks });
      if (checks.some((c) => c.status === "fail")) {
        process.exitCode = 1;
      }
      return;
    }

    let hasFailure = false;
    for (const check of checks) {
      if (check.status === "pass") {
        printSuccess(`${check.name}: ${check.message ?? "OK"}`);
      } else if (check.status === "info") {
        console.log(`  ${check.name}: ${check.message ?? ""}`);
      } else {
        printError(`${check.name}: ${check.message ?? "FAILED"}`);
        hasFailure = true;
      }
    }

    if (hasFailure) {
      process.exitCode = 1;
    }
  },
});
