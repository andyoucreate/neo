import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { agents } from "../agents.js";
import { CLAUDE_CODE_PATH } from "../config.js";
import { createSandboxConfig } from "../sandbox.js";
import { runWithRecovery } from "../recovery.js";
import { mcpPlaywright } from "../mcp.js";
import type { QaRequest, PipelineResult } from "../types.js";
import { logger } from "../logger.js";
import { hooks } from "../hooks.js";

/**
 * Run the QA pipeline for a PR.
 * Uses Playwright MCP for E2E tests and visual regression.
 */
export async function runQaPipeline(
  request: QaRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const startTime = Date.now();

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

  const options: Options = {
    pathToClaudeCodeExecutable: CLAUDE_CODE_PATH,
    permissionMode: "acceptEdits",
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks,
    sandbox: createSandboxConfig(repoDir),
    agents: { "qa-playwright": agents["qa-playwright"] },
    tools: { type: "preset", preset: "claude_code" },
    mcpServers: mcpPlaywright,
    cwd: repoDir,
    maxTurns: 100,
  };

  let sessionId = "";
  let costUsd = 0;

  try {
    const result = await runWithRecovery("qa", prompt, options, {
      onSessionId: (id) => {
        sessionId = id;
      },
      onCostRecord: (msg) => {
        costUsd = msg.total_cost_usd;
      },
    });

    return {
      prNumber: request.prNumber,
      sessionId,
      pipeline: "qa",
      status: result.subtype === "success" ? "success" : "failure",
      summary: result.subtype === "success" ? result.result : undefined,
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`QA pipeline failed for PR #${request.prNumber}`, error);
    return {
      prNumber: request.prNumber,
      sessionId,
      pipeline: "qa",
      status: "failure",
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
