import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AgentRegistry, loadConfig } from "@neo-cli/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";

const execFileAsync = promisify(execFile);

interface CheckResult {
  name: string;
  status: "pass" | "fail";
  message?: string;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0]!, 10);
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

async function checkConfig(): Promise<CheckResult> {
  const configPath = path.resolve(".neo/config.yml");
  if (!existsSync(configPath)) {
    return { name: "Config", status: "fail", message: ".neo/config.yml not found. Run 'neo init'" };
  }
  try {
    await loadConfig(configPath);
    return { name: "Config", status: "pass", message: configPath };
  } catch (error) {
    return {
      name: "Config",
      status: "fail",
      message: `Invalid: ${error instanceof Error ? error.message : String(error)}`,
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
  const journalDir = path.resolve(".neo/journals");
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
    description: "Check environment prerequisites",
  },
  args: {
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";

    const checks = await Promise.all([
      checkNodeVersion(),
      checkGit(),
      checkConfig(),
      checkClaudeCli(),
      checkAgents(),
      checkJournalDirs(),
    ]);

    if (jsonOutput) {
      printJson({ checks });
      process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
    }

    let hasFailure = false;
    for (const check of checks) {
      if (check.status === "pass") {
        printSuccess(`${check.name}: ${check.message ?? "OK"}`);
      } else {
        printError(`${check.name}: ${check.message ?? "FAILED"}`);
        hasFailure = true;
      }
    }

    process.exit(hasFailure ? 1 : 0);
  },
});
