import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { agents } from "../agents.js";
import { hooks } from "../hooks.js";
import { logger } from "../logger.js";
import { runWithRecovery } from "../recovery.js";
import { createSandboxConfig } from "../sandbox.js";
import type { FeatureRequest, PipelineResult } from "../types.js";

/**
 * Build the prompt for a feature pipeline.
 */
function buildFeaturePrompt(ticket: FeatureRequest): string {
  return `You are the orchestrator for a feature implementation.

## Ticket
- **ID**: ${ticket.ticketId}
- **Title**: ${ticket.title}
- **Type**: ${ticket.type}
- **Priority**: ${ticket.priority}
- **Size**: ${ticket.size}

## Acceptance Criteria
${ticket.criteria}

## Description
${ticket.description}

## Instructions
1. Analyze the codebase and understand the architecture
2. Design the implementation approach
3. Implement the feature following project conventions
4. Write tests for all new functionality
5. Run the full test suite and ensure all tests pass
6. Create a conventional commit with a clear message
7. Create a pull request with a summary of changes`;
}

/**
 * Run the feature pipeline for a ticket.
 */
export async function runFeaturePipeline(
  ticket: FeatureRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const prompt = buildFeaturePrompt(ticket);

  // Select agents based on ticket size
  const selectedAgents: Record<string, AgentDefinition> =
    ticket.size === "xs" || ticket.size === "s"
      ? { developer: agents.developer }
      : {
          architect: agents.architect,
          developer: agents.developer,
        };

  const options: Options = {
    permissionMode: "acceptEdits",
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks,
    sandbox: createSandboxConfig(repoDir),
    agents: selectedAgents,
    tools: { type: "preset", preset: "claude_code" },
    cwd: repoDir,
    maxTurns: ticket.size === "xs" || ticket.size === "s" ? 50 : 150,
  };

  let sessionId = "";
  let costUsd = 0;

  try {
    const result = await runWithRecovery("feature", prompt, options, {
      onSessionId: (id) => {
        sessionId = id;
      },
      onCostRecord: (msg) => {
        costUsd = msg.total_cost_usd;
      },
    });

    return {
      ticketId: ticket.ticketId,
      sessionId,
      pipeline: "feature",
      status: result.subtype === "success" ? "success" : "failure",
      summary: result.subtype === "success" ? result.result : undefined,
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Feature pipeline failed for ${ticket.ticketId}`, error);
    return {
      ticketId: ticket.ticketId,
      sessionId,
      pipeline: "feature",
      status: "failure",
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
