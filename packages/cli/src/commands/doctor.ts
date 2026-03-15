import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AgentRegistry,
  getDataDir,
  getJournalsDir,
  listReposFromGlobalConfig,
  listWorktrees,
  loadGlobalConfig,
  removeWorktree,
  toRepoSlug,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";

const execFileAsync = promisify(execFile);

type FixableIssue = "missing-directory" | "stale-worktree";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "info";
  message?: string;
  fixable?: FixableIssue;
  fixData?: unknown;
}

interface FixResult {
  name: string;
  success: boolean;
  message: string;
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
      status: "fail",
      message: `Directory missing: ${journalDir}`,
      fixable: "missing-directory",
      fixData: { path: journalDir },
    };
  }
  try {
    await access(journalDir, constants.W_OK);
    return { name: "Journals", status: "pass", message: journalDir };
  } catch {
    return { name: "Journals", status: "fail", message: `${journalDir} is not writable` };
  }
}

async function checkDataDir(): Promise<CheckResult> {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    return {
      name: "Data directory",
      status: "fail",
      message: `Directory missing: ${dataDir}`,
      fixable: "missing-directory",
      fixData: { path: dataDir },
    };
  }
  try {
    await access(dataDir, constants.W_OK);
    return { name: "Data directory", status: "pass", message: dataDir };
  } catch {
    return { name: "Data directory", status: "fail", message: `${dataDir} is not writable` };
  }
}

interface StaleWorktree {
  path: string;
  branch: string;
  repoPath: string;
}

async function checkStaleWorktrees(): Promise<CheckResult> {
  const cwd = process.cwd();
  const worktreesDir = path.join(cwd, ".neo", "worktrees");

  if (!existsSync(worktreesDir)) {
    return { name: "Worktrees", status: "pass", message: "No worktrees directory" };
  }

  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    const staleWorktrees: StaleWorktree[] = [];

    // Get all worktrees known to git
    let knownWorktrees: string[] = [];
    try {
      const worktrees = await listWorktrees(cwd);
      knownWorktrees = worktrees.map((w) => w.path);
    } catch {
      // Not a git repo or can't list worktrees
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worktreePath = path.join(worktreesDir, entry.name);

      // A worktree is stale if its directory exists but git doesn't know about it
      const isKnown = knownWorktrees.some(
        (known) => path.resolve(known) === path.resolve(worktreePath),
      );

      if (!isKnown) {
        // Check if it looks like a worktree (has .git file)
        const gitFile = path.join(worktreePath, ".git");
        if (existsSync(gitFile)) {
          staleWorktrees.push({ path: worktreePath, branch: entry.name, repoPath: cwd });
        } else {
          // Directory exists but isn't a worktree - still consider it stale
          staleWorktrees.push({ path: worktreePath, branch: entry.name, repoPath: cwd });
        }
      }
    }

    if (staleWorktrees.length === 0) {
      return { name: "Worktrees", status: "pass", message: "No stale worktrees" };
    }

    return {
      name: "Worktrees",
      status: "fail",
      message: `${staleWorktrees.length} stale worktree(s) found`,
      fixable: "stale-worktree",
      fixData: { worktrees: staleWorktrees },
    };
  } catch (error) {
    return {
      name: "Worktrees",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fixMissingDirectory(dirPath: string): Promise<FixResult> {
  try {
    await mkdir(dirPath, { recursive: true });
    return { name: `Create ${dirPath}`, success: true, message: "Created" };
  } catch (error) {
    return {
      name: `Create ${dirPath}`,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fixStaleWorktree(worktree: StaleWorktree): Promise<FixResult> {
  try {
    await removeWorktree(worktree.path);
    return { name: `Remove ${worktree.path}`, success: true, message: "Removed" };
  } catch (error) {
    return {
      name: `Remove ${worktree.path}`,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function applyFixes(checks: CheckResult[]): Promise<FixResult[]> {
  const results: FixResult[] = [];

  for (const check of checks) {
    if (!check.fixable) continue;

    switch (check.fixable) {
      case "missing-directory": {
        const data = check.fixData as { path: string };
        results.push(await fixMissingDirectory(data.path));
        break;
      }
      case "stale-worktree": {
        const data = check.fixData as { worktrees: StaleWorktree[] };
        for (const worktree of data.worktrees) {
          results.push(await fixStaleWorktree(worktree));
        }
        break;
      }
    }
  }

  return results;
}

async function runAllChecks(): Promise<CheckResult[]> {
  const results = await Promise.all([
    checkNodeVersion(),
    checkGit(),
    checkDataDir(),
    checkGlobalConfig(),
    checkRepoRegistered(),
    checkClaudeCli(),
    checkAgents(),
    checkJournalDirs(),
    checkStaleWorktrees(),
  ]);
  return results.filter((c): c is CheckResult => c !== null);
}

function printCheckResult(check: CheckResult, shouldFix: boolean): boolean {
  if (check.status === "pass") {
    printSuccess(`${check.name}: ${check.message ?? "OK"}`);
    return false;
  }
  if (check.status === "info") {
    console.log(`  ${check.name}: ${check.message ?? ""}`);
    return false;
  }
  const fixableHint = check.fixable && !shouldFix ? " (fixable with --fix)" : "";
  printError(`${check.name}: ${check.message ?? "FAILED"}${fixableHint}`);
  return true;
}

function printFixResults(fixResults: FixResult[]): boolean {
  console.log("\nFix results:");
  let allFixed = true;
  for (const fix of fixResults) {
    if (fix.success) {
      printSuccess(`${fix.name}: ${fix.message}`);
    } else {
      printError(`${fix.name}: ${fix.message}`);
      allFixed = false;
    }
  }
  return allFixed;
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
    fix: {
      type: "boolean",
      description: "Attempt to automatically fix detected issues",
      default: false,
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const shouldFix = args.fix;

    const checks = await runAllChecks();

    // In fix mode, attempt to fix issues
    let fixResults: FixResult[] = [];
    if (shouldFix) {
      const fixableChecks = checks.filter((c) => c.status === "fail" && c.fixable);
      if (fixableChecks.length > 0) {
        fixResults = await applyFixes(fixableChecks);
      }
    }

    if (jsonOutput) {
      const output: { checks: CheckResult[]; fixes?: FixResult[] } = { checks };
      if (shouldFix && fixResults.length > 0) {
        output.fixes = fixResults;
      }
      printJson(output);

      const hasUnfixedFailures = shouldFix
        ? fixResults.some((f) => !f.success)
        : checks.some((c) => c.status === "fail");
      if (hasUnfixedFailures) {
        process.exitCode = 1;
      }
      return;
    }

    // Print check results
    let hasFailure = false;
    for (const check of checks) {
      if (printCheckResult(check, shouldFix)) {
        hasFailure = true;
      }
    }

    // Print fix results
    if (shouldFix && fixResults.length > 0) {
      const allFixed = printFixResults(fixResults);
      if (allFixed) {
        hasFailure = false;
      }
    }

    if (hasFailure) {
      process.exitCode = 1;
    }
  },
});
