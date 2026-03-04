import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { agents } from "../agents.js";
import { logger } from "../logger.js";
import type { PipelineResult, ReviewRequest } from "../types.js";
import { runPipeline } from "./run-pipeline.js";

/**
 * Select review agents based on PR diff size.
 * XS/S: 1 combined reviewer (Opus)
 * M: 2 reviewers (quality+perf, security+coverage)
 * L/XL: 4 parallel reviewers
 */
function selectReviewAgents(
  diffSize: number,
): Record<string, AgentDefinition> {
  if (diffSize < 50) {
    // XS/S — single combined reviewer
    return {
      "combined-reviewer": {
        description:
          "Combined code reviewer covering quality, security, performance, and test coverage.",
        prompt: `You are a combined code reviewer. Review the PR diff for:
1. Code quality (DRY, naming, complexity, patterns)
2. Security (injections, auth gaps, secrets, input validation)
3. Performance (N+1, re-renders, bundle size, algorithms)
4. Test coverage (missing tests, edge cases, error paths)

Output a structured JSON review with verdict, issues, and stats.`,
        tools: ["Read", "Glob", "Grep", "Bash"],
        model: "opus",
      },
    };
  }

  if (diffSize < 300) {
    // M — two review subagents
    return {
      "quality-perf-reviewer": {
        ...agents["reviewer-quality"],
        prompt: `${agents["reviewer-quality"].prompt}

Also review for performance issues: N+1 queries, re-renders, bundle size.`,
        model: "sonnet",
      },
      "security-coverage-reviewer": {
        ...agents["reviewer-security"],
        prompt: `${agents["reviewer-security"].prompt}

Also review for test coverage gaps: missing tests, edge cases, error paths.`,
        model: "opus",
      },
    };
  }

  // L/XL — full 4-lens review
  return {
    "reviewer-quality": agents["reviewer-quality"],
    "reviewer-security": agents["reviewer-security"],
    "reviewer-perf": agents["reviewer-perf"],
    "reviewer-coverage": agents["reviewer-coverage"],
  };
}

/**
 * Estimate PR diff size via GitHub API (additions + deletions).
 */
async function getPrDiffSize(
  prNumber: number,
  repository: string,
  repoDir: string,
): Promise<number> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const repo = repository.replace("github.com/", "");

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".additions + .deletions"],
      { cwd: repoDir, timeout: 30_000 },
    );
    const total = parseInt(stdout.trim(), 10);
    return Number.isFinite(total) ? total : 100;
  } catch {
    logger.warn(`Could not get diff size for PR #${prNumber}, defaulting to M`);
    return 100;
  }
}

/**
 * Run the review pipeline for a PR.
 */
export async function runReviewPipeline(
  request: ReviewRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const diffSize = await getPrDiffSize(request.prNumber, request.repository, repoDir);
  const reviewAgents = selectReviewAgents(diffSize);
  const agentCount = Object.keys(reviewAgents).length;

  logger.info(
    `Review PR #${request.prNumber}: ${diffSize} lines changed → ${agentCount} reviewer(s)`,
  );

  const prompt = `Review Pull Request #${request.prNumber} in this repository.

Use \`gh pr diff ${request.prNumber}\` to get the diff, then perform a thorough review.

Spawn the available review subagents to perform parallel reviews, then consolidate results.

Output a structured JSON review report with:
- verdict: "APPROVED" or "CHANGES_REQUESTED"
- summary
- issues array (each with severity, category, file, line, description, remediation)
- stats (files_reviewed, critical, high, medium, low counts)`;

  return runPipeline(
    {
      pipeline: "review",
      prompt,
      repoDir,
      agents: reviewAgents,
      maxTurns: 100,
      sandbox: "readonly",
    },
    { prNumber: request.prNumber, repository: request.repository },
  );
}
