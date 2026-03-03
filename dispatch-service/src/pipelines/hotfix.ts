import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { agents } from "../agents.js";
import { CLAUDE_CODE_PATH } from "../config.js";
import { hooks } from "../hooks.js";
import { logger } from "../logger.js";
import { runWithRecovery } from "../recovery.js";
import { createSandboxConfig } from "../sandbox.js";
import type { HotfixRequest, PipelineResult } from "../types.js";

/**
 * Run the hotfix pipeline for critical/high bugs.
 * Fast-tracked: developer agent only, no architect.
 */
export async function runHotfixPipeline(
  request: HotfixRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const startTime = Date.now();

  const prompt = `HOTFIX — Priority: ${request.priority.toUpperCase()}

## Bug Report
- **ID**: ${request.ticketId}
- **Title**: ${request.title}

## Description
${request.description}

## Instructions
This is a hotfix — speed is critical but correctness is paramount.
1. Identify the root cause of the bug
2. Implement the minimal fix
3. Write a regression test that would have caught this bug
4. Run the full test suite
5. Create a conventional commit: fix(scope): description
6. Create a PR targeting the main branch`;

  const options: Options = {
    pathToClaudeCodeExecutable: CLAUDE_CODE_PATH,
    permissionMode: "acceptEdits",
    settingSources: ["user", "project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks,
    sandbox: createSandboxConfig(repoDir),
    agents: { developer: agents.developer },
    tools: { type: "preset", preset: "claude_code" },
    cwd: repoDir,
    maxTurns: 75,
  };

  let sessionId = "";
  let costUsd = 0;

  try {
    const result = await runWithRecovery("hotfix", prompt, options, {
      onSessionId: (id) => {
        sessionId = id;
      },
      onCostRecord: (msg) => {
        costUsd = msg.total_cost_usd;
      },
    });

    return {
      ticketId: request.ticketId,
      sessionId,
      pipeline: "hotfix",
      status: result.subtype === "success" ? "success" : "failure",
      summary: result.subtype === "success" ? result.result : undefined,
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Hotfix pipeline failed for ${request.ticketId}`, error);
    return {
      ticketId: request.ticketId,
      sessionId,
      pipeline: "hotfix",
      status: "failure",
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
