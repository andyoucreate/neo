import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { agents } from "../agents.js";
import { CLAUDE_CODE_PATH } from "../config.js";
import { createSandboxConfig } from "../sandbox.js";
import { runWithRecovery } from "../recovery.js";
import type { FixerRequest, PipelineResult } from "../types.js";
import { logger } from "../logger.js";
import { hooks } from "../hooks.js";

/**
 * Run the fixer pipeline to auto-correct review/QA issues.
 */
export async function runFixerPipeline(
  request: FixerRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const startTime = Date.now();

  const issuesJson = JSON.stringify(request.issues, null, 2);

  const prompt = `You are the Fixer agent. Fix the following issues found by reviewers/QA on PR #${request.prNumber}.

## Issues to Fix
\`\`\`json
${issuesJson}
\`\`\`

## Rules
1. Fix ROOT CAUSES, never symptoms
2. Maximum 3 files modified
3. Maximum 3 fix attempts
4. Maximum 100 lines changed
5. Run full test suite before committing
6. If scope exceeds limits, STOP and report "ESCALATED"
7. Add regression tests for every fix

## Output
Report what was fixed and what was not, in structured JSON.`;

  const options: Options = {
    pathToClaudeCodeExecutable: CLAUDE_CODE_PATH,
    permissionMode: "acceptEdits",
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks,
    sandbox: createSandboxConfig(repoDir),
    agents: { fixer: agents.fixer },
    tools: { type: "preset", preset: "claude_code" },
    cwd: repoDir,
    maxTurns: 50,
  };

  let sessionId = "";
  let costUsd = 0;

  try {
    const result = await runWithRecovery("fixer", prompt, options, {
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
      pipeline: "fixer",
      status: result.subtype === "success" ? "success" : "failure",
      summary: result.subtype === "success" ? result.result : undefined,
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Fixer pipeline failed for PR #${request.prNumber}`, error);
    return {
      prNumber: request.prNumber,
      sessionId,
      pipeline: "fixer",
      status: "failure",
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
