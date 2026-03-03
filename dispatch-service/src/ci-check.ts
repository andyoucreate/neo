import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 30_000;
const MAX_WAIT_MS = 2 * 60_000;

export interface CiCheckResult {
  conclusion:
    | "success"
    | "failure"
    | "no_checks"
    | "pending"
    | "timeout"
    | "error";
  failedChecks?: Array<{ name: string; conclusion: string }>;
  details?: string;
}

interface GhCheck {
  name: string;
  status: string;
  conclusion: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCheckRuns(
  prNumber: number,
  repo: string,
): Promise<CiCheckResult> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "checks",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "name,status,conclusion",
      ],
      { timeout: 15_000 },
    );

    const checks = JSON.parse(stdout) as GhCheck[];

    if (checks.length === 0) {
      return { conclusion: "no_checks" };
    }

    const pending = checks.some(
      (c) => c.status !== "completed" && c.status !== "",
    );
    if (pending) {
      return { conclusion: "pending" };
    }

    const failed = checks.filter(
      (c) =>
        c.conclusion !== "success" &&
        c.conclusion !== "skipped" &&
        c.conclusion !== "neutral" &&
        c.conclusion !== "",
    );

    if (failed.length > 0) {
      return {
        conclusion: "failure",
        failedChecks: failed.map((c) => ({
          name: c.name,
          conclusion: c.conclusion,
        })),
      };
    }

    return { conclusion: "success" };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("no checks") || msg.includes("no check runs")) {
      return { conclusion: "no_checks" };
    }
    logger.warn(`gh pr checks failed for PR #${String(prNumber)}`, error);
    return { conclusion: "error", details: msg };
  }
}

/**
 * Poll GitHub CI checks for a PR until they complete or timeout.
 * Uses `gh pr checks` CLI (must be authenticated on the host).
 */
export async function pollCiChecks(
  prNumber: number,
  repository: string,
): Promise<CiCheckResult> {
  const repo = repository.replace("github.com/", "");
  const deadline = Date.now() + MAX_WAIT_MS;

  const initial = await getCheckRuns(prNumber, repo);
  if (initial.conclusion !== "pending") {
    return initial;
  }

  logger.info(
    `CI checks pending for PR #${String(prNumber)}, polling (max ${String(MAX_WAIT_MS / 1000)}s)...`,
  );

  while (Date.now() + POLL_INTERVAL_MS < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await getCheckRuns(prNumber, repo);
    if (result.conclusion !== "pending") {
      return result;
    }
  }

  return { conclusion: "timeout", details: "CI still running after max wait" };
}
