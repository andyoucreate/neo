import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_PATH } from "../config.js";
import { hooks } from "../hooks.js";
import { logger } from "../logger.js";
import { runWithRecovery } from "../recovery.js";
import { createReadonlySandboxConfig, createSandboxConfig } from "../sandbox.js";
import type { PipelineResult, PipelineType } from "../types.js";

// ─── Pipeline configuration ─────────────────────────────────
export interface PipelineConfig {
  pipeline: PipelineType;
  prompt: string;
  repoDir: string;
  agents: Record<string, AgentDefinition>;
  maxTurns: number;
  sandbox?: "writable" | "readonly";
  mcpServers?: Options["mcpServers"];
  branch?: string;
}

export interface PipelineMeta {
  ticketId?: string;
  prNumber?: number;
  repository?: string;
}

// ─── Low-level execution result ─────────────────────────────
export interface ExecutionResult {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  success: boolean;
  output: string | undefined;
}

// ─── PR info parsing ────────────────────────────────────────
interface PrInfo {
  prUrl?: string;
  prNumber?: number;
}

/**
 * Extract PR URL and number from agent output text.
 * Looks for explicit PR_URL markers, then falls back to GitHub PR URL patterns.
 */
function parsePrInfo(output: string | undefined): PrInfo {
  if (!output) return {};

  const markerMatch = output.match(
    /PR_URL:\s*(https:\/\/github\.com\/[^\s]+\/pull\/(\d+))/,
  );
  if (markerMatch) {
    return { prUrl: markerMatch[1], prNumber: parseInt(markerMatch[2], 10) };
  }

  const urlMatch = output.match(
    /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/,
  );
  if (urlMatch) {
    return { prUrl: urlMatch[0], prNumber: parseInt(urlMatch[1], 10) };
  }

  return {};
}

/**
 * Build SDK Options from pipeline config.
 */
function buildOptions(config: PipelineConfig): Options {
  const sandbox =
    config.sandbox === "readonly"
      ? createReadonlySandboxConfig(config.repoDir)
      : createSandboxConfig(config.repoDir);

  return {
    pathToClaudeCodeExecutable: CLAUDE_CODE_PATH,
    permissionMode: "bypassPermissions",
    settingSources: ["user", "project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks,
    sandbox,
    agents: config.agents,
    tools: { type: "preset", preset: "claude_code" },
    cwd: config.repoDir,
    maxTurns: config.maxTurns,
    ...(config.mcpServers && { mcpServers: config.mcpServers }),
  };
}

/**
 * Execute a pipeline and return raw execution result.
 * Throws on unrecoverable failure (after all retries exhausted).
 * Use this for pipelines with custom result handling (e.g., refine).
 */
export async function executePipeline(
  config: PipelineConfig,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const options = buildOptions(config);

  let sessionId = "";
  let costUsd = 0;

  const result = await runWithRecovery(config.pipeline, config.prompt, options, {
    onSessionId: (id) => {
      sessionId = id;
    },
    onCostRecord: (msg) => {
      costUsd = msg.total_cost_usd;
    },
  });

  return {
    sessionId,
    costUsd,
    durationMs: Date.now() - startTime,
    success: result.subtype === "success",
    output: result.subtype === "success" ? result.result : undefined,
  };
}

/**
 * Run a pipeline and return a PipelineResult.
 * Handles all boilerplate: options building, session tracking, error handling.
 * Use this for standard pipelines (feature, fixer, hotfix, qa, review).
 */
export async function runPipeline(
  config: PipelineConfig,
  meta: PipelineMeta,
): Promise<PipelineResult> {
  const startTime = Date.now();

  let sessionId = "";
  let costUsd = 0;

  try {
    const exec = await executePipeline(config);
    sessionId = exec.sessionId;
    costUsd = exec.costUsd;

    const prInfo = parsePrInfo(exec.output);

    return {
      ...meta,
      sessionId,
      pipeline: config.pipeline,
      status: exec.success ? "success" : "failure",
      summary: exec.output,
      branch: config.branch,
      ...prInfo,
      costUsd,
      durationMs: exec.durationMs,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`${config.pipeline} pipeline failed`, error);
    return {
      ...meta,
      sessionId,
      pipeline: config.pipeline,
      status: "failure",
      branch: config.branch,
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
