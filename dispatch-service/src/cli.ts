#!/usr/bin/env node
/**
 * Local CLI for testing dispatch pipelines.
 *
 * Usage:
 *   pnpm dispatch:test fixer   --pr 51 --repo org/standards [--dry-run]
 *   pnpm dispatch:test review  --pr 51 --repo org/standards [--dry-run]
 *   pnpm dispatch:test feature --ticket PROJ-42 --repo org/app [--dry-run]
 *   pnpm dispatch:test hotfix  --ticket PROJ-42 --repo org/app [--dry-run]
 *   pnpm dispatch:test refine  --ticket PROJ-42 --repo org/app [--dry-run]
 *
 * --dry-run: Logs the SDK prompt and options without calling Claude (no API cost).
 * Without --dry-run: Runs the real SDK locally.
 *
 * The .env file is loaded automatically at startup (no dotenv dependency needed).
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ─── Load .env file before any config imports ─────────────────
try {
  const envContent = readFileSync(".env", "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Don't override existing env vars (explicit exports win)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // No .env file — that's fine, use defaults from config.ts
}

// ─── Clean inherited Claude Code session env vars ────────────
// When running from inside a Claude Code session (e.g. VSCode extension),
// these env vars prevent nested Claude Code processes from starting.
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
delete process.env.CLAUDE_AGENT_SDK_VERSION;

import { logger } from "./logger.js";

// ─── Arg parsing ──────────────────────────────────────────────
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pr: { type: "string" },
    ticket: { type: "string" },
    repo: { type: "string" },
    title: { type: "string", default: "CLI test ticket" },
    description: { type: "string", default: "Triggered from local CLI" },
    priority: { type: "string", default: "medium" },
    complexity: { type: "string", default: "3" },
    type: { type: "string", default: "feature" },
    "dry-run": { type: "boolean", default: false },
    severity: { type: "string", default: "HIGH" },
    file: { type: "string", default: "src/index.ts" },
    line: { type: "string", default: "1" },
    issue: { type: "string", default: "Issue from CLI test" },
  },
});

const pipeline = positionals[0];
const dryRun = values["dry-run"];

if (!pipeline || !values.repo) {
  console.error(
    "Usage: pnpm dispatch:test <pipeline> --repo <org/repo> [--pr N] [--ticket ID] [--dry-run]",
  );
  console.error("Pipelines: fixer, review, feature, hotfix, refine");
  process.exit(1);
}

// Set DRY_RUN env var so recovery.ts skips the real SDK call and logs prompt/options
if (dryRun) {
  process.env.DRY_RUN = "true";
}

const repo = values.repo;

// ─── Resolve repo directory ────────────────────────────────────
function resolveRepoDir(repository: string): string {
  const baseDir = process.env.REPOS_BASE_DIR || "/home/voltaire/repos";
  const parts = repository.replace("github.com/", "").split("/");
  return `${baseDir}/${parts.join("/")}`;
}

// ─── Pipeline runners ──────────────────────────────────────────

/**
 * Fixer pipeline — mirrors server's dispatchWithPrWorktree:
 * 1. Fetch PR branch name via gh api
 * 2. Create worktree on that branch
 * 3. Run fixer in worktree
 * 4. Verify commits were pushed
 * 5. Cleanup worktree
 */
async function runFixer(): Promise<void> {
  const pr = values.pr;
  const ticket = values.ticket;
  if (!pr || !ticket) {
    console.error("Fixer requires --pr <number> --ticket <id>");
    process.exit(1);
  }

  const { runFixerPipeline } = await import("./pipelines/fixer.js");
  const repoDir = resolveRepoDir(repo);
  const prNumber = parseInt(pr, 10);
  const repoSlug = repo.replace("github.com/", "");

  const request = {
    ticketId: ticket,
    prNumber,
    repository: repo,
    issues: [
      {
        source: "reviewer-quality",
        severity: values.severity as "CRITICAL" | "HIGH" | "WARNING",
        file: values.file,
        line: parseInt(values.line, 10),
        description: values.issue,
      },
    ],
  };

  // In dry-run mode, skip worktree setup and run directly
  if (dryRun) {
    logResult(await runFixerPipeline(request, repoDir));
    return;
  }

  // Fetch PR branch name
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${repoSlug}/pulls/${prNumber}`, "--jq", ".head.ref"],
    { cwd: repoDir, timeout: 30_000 },
  );
  const prBranch = stdout.trim();
  logger.info(`Fixer: checking out PR #${prNumber} branch: ${prBranch}`);

  // Create worktree on PR branch
  const { createWorktreeForBranch, removeWorktree } = await import("./worktree.js");
  const sessionId = `cli-fixer-${Date.now()}`;
  const worktreePath = await createWorktreeForBranch(repoDir, sessionId, prBranch);

  try {
    const result = await runFixerPipeline(request, worktreePath);

    // Verify the fixer actually pushed commits
    try {
      const { stdout: unpushed } = await execFileAsync(
        "git",
        ["log", "--oneline", `origin/${prBranch}..HEAD`],
        { cwd: worktreePath, timeout: 10_000 },
      );
      if (unpushed.trim()) {
        logger.warn(
          `Fixer has UNPUSHED commits — they will be lost when the worktree is cleaned up:\n${unpushed.trim()}`,
        );
      }
    } catch {
      // Non-blocking
    }

    logResult(result);
  } finally {
    await removeWorktree(repoDir, sessionId).catch((err: unknown) => {
      logger.warn("Failed to cleanup worktree", err);
    });
  }
}

/**
 * Review pipeline — mirrors server's dispatchWithPrWorktree:
 * 1. Fetch PR branch name via gh api
 * 2. Create worktree on that branch (read-only)
 * 3. Run review in worktree
 * 4. Cleanup worktree
 */
async function runReview(): Promise<void> {
  const pr = values.pr;
  const ticket = values.ticket;
  if (!pr || !ticket) {
    console.error("Review requires --pr <number> --ticket <id>");
    process.exit(1);
  }

  const { runReviewPipeline } = await import("./pipelines/review.js");
  const repoDir = resolveRepoDir(repo);
  const prNumber = parseInt(pr, 10);
  const repoSlug = repo.replace("github.com/", "");

  const request = {
    ticketId: ticket,
    prNumber,
    repository: repo,
  };

  // In dry-run mode, skip worktree setup
  if (dryRun) {
    logResult(await runReviewPipeline(request, repoDir));
    return;
  }

  // Fetch PR branch name
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${repoSlug}/pulls/${prNumber}`, "--jq", ".head.ref"],
    { cwd: repoDir, timeout: 30_000 },
  );
  const prBranch = stdout.trim();
  logger.info(`Review: checking out PR #${prNumber} branch: ${prBranch}`);

  // Create worktree on PR branch
  const { createWorktreeForBranch, removeWorktree } = await import("./worktree.js");
  const sessionId = `cli-review-${Date.now()}`;
  const worktreePath = await createWorktreeForBranch(repoDir, sessionId, prBranch);

  try {
    logResult(await runReviewPipeline(request, worktreePath));
  } finally {
    await removeWorktree(repoDir, sessionId).catch((err: unknown) => {
      logger.warn("Failed to cleanup worktree", err);
    });
  }
}

/**
 * Feature pipeline — mirrors server's dispatchWithWorktree:
 * Creates a new branch in a worktree, runs pipeline, then cleans up.
 */
async function runFeature(): Promise<void> {
  const ticket = values.ticket;
  if (!ticket) {
    console.error("Feature requires --ticket <id>");
    process.exit(1);
  }

  const { runFeaturePipeline } = await import("./pipelines/feature.js");
  const repoDir = resolveRepoDir(repo);
  const branch = `feat/${ticket.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

  const request = {
    ticketId: ticket,
    title: values.title,
    type: values.type as "feature" | "bug" | "refactor" | "chore",
    priority: values.priority as "critical" | "high" | "medium" | "low",
    complexity: parseInt(values.complexity, 10) as 1 | 2 | 3 | 5 | 8 | 13 | 21 | 34 | 55 | 89 | 144,
    repository: repo,
    criteria: "",
    description: values.description,
  };

  // In dry-run mode, skip worktree setup
  if (dryRun) {
    logResult(await runFeaturePipeline(request, repoDir, branch, "main"));
    return;
  }

  const { createWorktree, getDefaultBranch, removeWorktree } = await import("./worktree.js");
  const sessionId = `cli-feature-${Date.now()}`;
  const worktreePath = await createWorktree(repoDir, sessionId, branch);

  try {
    const baseBranch = await getDefaultBranch(repoDir);
    const result = await runFeaturePipeline(request, worktreePath, branch, baseBranch);
    logResult(result);
  } finally {
    await removeWorktree(repoDir, sessionId).catch((err: unknown) => {
      logger.warn("Failed to cleanup worktree", err);
    });
  }
}

/**
 * Hotfix pipeline — mirrors server's dispatchWithWorktree.
 */
async function runHotfix(): Promise<void> {
  const ticket = values.ticket;
  if (!ticket) {
    console.error("Hotfix requires --ticket <id>");
    process.exit(1);
  }

  const { runHotfixPipeline } = await import("./pipelines/hotfix.js");
  const repoDir = resolveRepoDir(repo);
  const branch = `fix/${ticket.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

  const request = {
    ticketId: ticket,
    title: values.title,
    priority: values.priority as "critical" | "high" | "medium" | "low",
    repository: repo,
    description: values.description,
  };

  // In dry-run mode, skip worktree setup
  if (dryRun) {
    logResult(await runHotfixPipeline(request, repoDir, branch, "main"));
    return;
  }

  const { createWorktree, getDefaultBranch, removeWorktree } = await import("./worktree.js");
  const sessionId = `cli-hotfix-${Date.now()}`;
  const worktreePath = await createWorktree(repoDir, sessionId, branch);

  try {
    const baseBranch = await getDefaultBranch(repoDir);
    const result = await runHotfixPipeline(request, worktreePath, branch, baseBranch);
    logResult(result);
  } finally {
    await removeWorktree(repoDir, sessionId).catch((err: unknown) => {
      logger.warn("Failed to cleanup worktree", err);
    });
  }
}

async function runRefine(): Promise<void> {
  const ticket = values.ticket;
  if (!ticket) {
    console.error("Refine requires --ticket <id>");
    process.exit(1);
  }

  const { runRefinePipeline } = await import("./pipelines/refine.js");
  const repoDir = resolveRepoDir(repo);

  const result = await runRefinePipeline(
    {
      ticketId: ticket,
      title: values.title,
      type: values.type as "feature" | "bug" | "refactor" | "chore",
      priority: values.priority as "critical" | "high" | "medium" | "low",
      repository: repo,
    },
    repoDir,
  );

  console.log("\n--- REFINE RESULT ---");
  console.log(JSON.stringify(result, null, 2));
}

function logResult(result: unknown): void {
  console.log("\n--- PIPELINE RESULT ---");
  console.log(JSON.stringify(result, null, 2));
}

// ─── Main ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.info(`CLI: running ${pipeline} pipeline${dryRun ? " (DRY RUN)" : ""}`);

  const runners: Record<string, () => Promise<void>> = {
    fixer: runFixer,
    review: runReview,
    feature: runFeature,
    hotfix: runHotfix,
    refine: runRefine,
  };

  const runner = runners[pipeline] as (() => Promise<void>) | undefined;
  if (!runner) {
    console.error(`Unknown pipeline: ${pipeline}`);
    console.error("Available: fixer, review, feature, hotfix, refine");
    process.exit(1);
  }

  try {
    await runner();
  } catch (error) {
    logger.error("CLI pipeline failed", error);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
