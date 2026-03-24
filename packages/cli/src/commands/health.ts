import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadGlobalConfig } from "@neotx/core";
import { defineCommand } from "citty";

const execFileAsync = promisify(execFile);

const CLAUDE_TIMEOUT_MS = 5000;

interface CheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

interface HealthSummary {
  ok: boolean;
  checks: {
    config: CheckResult;
    git: CheckResult;
    claude: CheckResult;
  };
}

async function checkConfig(): Promise<CheckResult> {
  try {
    await loadGlobalConfig();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkGit(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const match = stdout.match(/git version (\d+\.\d+\.\d+)/);
    return { ok: true, version: match?.[1] ?? "unknown" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkClaude(): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

    const { stdout } = await execFileAsync("claude", ["--version"], {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const version = stdout.trim();
    return { ok: true, version };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `timeout after ${CLAUDE_TIMEOUT_MS}ms` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default defineCommand({
  meta: {
    name: "health",
    description: "Quick health check: config, git, Claude SDK (JSON output)",
  },
  async run() {
    const [config, git, claude] = await Promise.all([checkConfig(), checkGit(), checkClaude()]);

    const summary: HealthSummary = {
      ok: config.ok && git.ok && claude.ok,
      checks: { config, git, claude },
    };

    console.log(JSON.stringify(summary, null, 2));

    // Use process.exitCode (not process.exit) to allow proper cleanup
    if (!summary.ok) {
      process.exitCode = 1;
    }
  },
});
