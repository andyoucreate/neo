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
        prompt: `You are a pragmatic code reviewer. Review ONLY the added/modified lines in the PR diff.

Your default stance is APPROVE. Only block if something will break in production.

Check in order of priority:
1. Security — directly exploitable injections, auth bypass, hardcoded secrets
2. Bugs — logic errors that WILL cause failures (not theoretical edge cases)
3. Performance — N+1 queries on unbounded data, O(n²) on user-generated lists

Do NOT check for:
- Missing tests (that's the developer's choice for small PRs)
- Naming, style, or code structure preferences
- Theoretical race conditions or edge cases that require unlikely preconditions
- Issues in code that existed before this PR

Rules:
- Maximum 3 issues total. Only flag things with concrete, demonstrable impact.
- If everything looks reasonable, APPROVE. Don't hunt for problems.
- CRITICAL = will cause a production incident. Not "could theoretically cause issues".
- Do NOT checkout main for comparison. Review current branch only.

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
  onInit?: () => void,
): Promise<PipelineResult> {
  const diffSize = await getPrDiffSize(request.prNumber, request.repository, repoDir);
  const reviewAgents = selectReviewAgents(diffSize);
  const agentCount = Object.keys(reviewAgents).length;

  logger.info(
    `Review PR #${request.prNumber}: ${diffSize} lines changed → ${agentCount} reviewer(s)`,
  );

  const prompt = `Review Pull Request #${request.prNumber} in this repository.

Use \`gh pr diff ${request.prNumber}\` to get the diff.

Spawn the available review subagents to perform parallel reviews, then consolidate results.

## CRITICAL — Scope Discipline
- Review ONLY lines that appear in the diff (+ or modified lines). Pre-existing code is OUT OF SCOPE.
- Do NOT explore the broader codebase looking for problems. If it's not in the diff, it doesn't exist for this review.
- Do NOT flag missing tests, missing indexes, or missing features that were not part of this PR's intent.

## Consolidation Rules
- Deduplicate: if multiple reviewers flag the same issue, keep only one.
- CRITICAL = would cause a production incident (data loss, security breach, crash). NOT: naming, style, theoretical race conditions, missing tests.
- Only CHANGES_REQUESTED if there are genuinely exploitable security holes or bugs that WILL break in production.
- Missing tests, naming issues, suggestions, theoretical concerns → APPROVED with notes. These NEVER block.
- Maximum 5 issues total in the final report. Keep only issues with concrete, demonstrable impact. Drop everything else.
- If in doubt about severity, downgrade. The goal is to help the developer, not to block them.

Output a structured JSON review report with:
- verdict: "APPROVED" or "CHANGES_REQUESTED"
- summary (2 sentences max — what the PR does well, what needs attention)
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
    onInit,
  );
}
