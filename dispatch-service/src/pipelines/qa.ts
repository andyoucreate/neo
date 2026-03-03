import { agents } from "../agents.js";
import { mcpPlaywright } from "../mcp.js";
import type { PipelineResult, QaRequest } from "../types.js";
import { runPipeline } from "./run-pipeline.js";

/**
 * Run the QA pipeline for a PR.
 * Uses Playwright MCP for E2E tests and visual regression.
 */
export async function runQaPipeline(
  request: QaRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const prompt = `You are the QA orchestrator for PR #${request.prNumber}.

Execute the QA pipeline:
1. Resolve the preview URL (from deployment status or local build)
2. Run smoke tests on all critical pages
3. Execute E2E critical path tests
4. Run visual regression tests against baselines

Use the Playwright MCP server for browser interactions.

Output a structured JSON QA report with:
- verdict: "PASS" or "FAIL"
- smoke_tests, e2e_tests, visual_regression results
- blocking_issues array`;

  return runPipeline(
    {
      pipeline: "qa",
      prompt,
      repoDir,
      agents: { "qa-playwright": agents["qa-playwright"] },
      maxTurns: 100,
      mcpServers: mcpPlaywright,
    },
    { prNumber: request.prNumber },
  );
}
