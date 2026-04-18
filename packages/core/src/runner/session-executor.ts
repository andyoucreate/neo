import type { GitStrategy, McpServerConfig, RepoConfig } from "@/config";
import { buildSandboxConfig } from "@/isolation/sandbox";
import {
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  loadRepoInstructions,
} from "@/orchestrator/prompt-builder";
import { type ParsedOutput, parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
import { SessionError } from "@/runner/session";
import type { Middleware, ResolvedAgent, StepResult } from "@/types";

// ─── Types ─────────────────────────────────────────────

export interface SessionExecutionInput {
  runId: string;
  sessionId: string;
  agent: ResolvedAgent;
  repoConfig: RepoConfig;
  repoPath: string;
  prompt: string;
  branch?: string | undefined;
  gitStrategy: GitStrategy;
  sessionPath?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  startedAt: string;
}

export interface SessionExecutionConfig {
  initTimeoutMs: number;
  maxDurationMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  /** Default model from config (models.default) — passed to session for adapter resolution */
  defaultModel?: string;
}

export interface SessionExecutionDeps {
  middleware: Middleware[];
  mcpServers?: Record<string, McpServerConfig> | undefined;
  memoryContext?: string | undefined;
  onAttempt?: (attempt: number, strategy: string) => void;
}

export interface SessionExecutionResult extends StepResult {
  parsed: ParsedOutput;
}

// ─── SessionExecutor ───────────────────────────────────

/**
 * Encapsulates session execution logic: prompt building, SDK calls, and response processing.
 * Extracted from Orchestrator for better testability and separation of concerns.
 */
export class SessionExecutor {
  constructor(private readonly config: SessionExecutionConfig) {}

  /**
   * Execute an agent session with the given input and dependencies.
   * Handles prompt building, SDK invocation via recovery wrapper, and output parsing.
   */
  async execute(
    input: SessionExecutionInput,
    deps: SessionExecutionDeps,
  ): Promise<SessionExecutionResult> {
    const {
      runId,
      agent,
      repoConfig,
      repoPath,
      prompt: taskPrompt,
      branch,
      gitStrategy,
      sessionPath,
      metadata,
      startedAt,
    } = input;

    const { mcpServers, memoryContext, onAttempt } = deps;

    // Validate writable agents have a branch
    if (agent.sandbox === "writable" && !branch) {
      throw new Error(
        "Validation error: --branch is required for writable agents. Provide an explicit branch name (e.g. --branch feat/PROJ-42-description).",
      );
    }

    const branchName = agent.sandbox === "writable" ? (branch as string) : "";

    // Build sandbox config for agent
    const sandboxConfig = buildSandboxConfig(agent, sessionPath);

    // Build the full prompt
    const repoInstructions = await loadRepoInstructions(repoPath);
    const gitInstructions = buildGitStrategyInstructions(
      gitStrategy,
      agent,
      branchName,
      repoConfig.defaultBranch,
      repoConfig.pushRemote ?? "origin",
      metadata,
    );

    const cwdInstructions = sessionPath
      ? `## Working directory\n\nYou are working in an isolated clone at: \`${sessionPath}\`\nALWAYS run commands from this directory. NEVER cd to or operate on any other repository.`
      : undefined;

    const reportingInstructions = buildReportingInstructions(runId);

    const fullPrompt = buildFullPrompt(
      agent.definition.prompt,
      repoInstructions,
      gitInstructions,
      taskPrompt,
      memoryContext,
      cwdInstructions,
      reportingInstructions,
    );

    // Execute session with recovery
    const agentEnv: Record<string, string> = {
      NEO_RUN_ID: runId,
      NEO_AGENT_NAME: agent.name,
      NEO_REPOSITORY: repoPath,
    };

    const sessionResult = await runWithRecovery({
      agent,
      prompt: fullPrompt,
      repoPath,
      sandboxConfig,
      env: agentEnv,
      initTimeoutMs: this.config.initTimeoutMs,
      maxDurationMs: this.config.maxDurationMs,
      maxRetries: this.config.maxRetries,
      backoffBaseMs: this.config.backoffBaseMs,
      ...(sessionPath ? { sessionPath } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(onAttempt ? { onAttempt } : {}),
      ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
      ...(this.config.defaultModel ? { defaultModel: this.config.defaultModel } : {}),
    });

    // Post-session budget check (SDK provides cost only after session ends)
    if (agent.maxCost !== undefined && sessionResult.costUsd >= agent.maxCost) {
      throw new SessionError(
        `Agent session exceeded budget: $${sessionResult.costUsd.toFixed(4)} >= $${agent.maxCost.toFixed(4)} limit`,
        "budget_exceeded",
        sessionResult.sessionId,
      );
    }

    // Parse output
    const parsed = parseOutput(sessionResult.output);

    // Build result
    const result: SessionExecutionResult = {
      status: "success",
      sessionId: sessionResult.sessionId,
      output: parsed.output ?? parsed.rawOutput,
      rawOutput: sessionResult.output,
      costUsd: sessionResult.costUsd,
      durationMs: sessionResult.durationMs,
      agent: agent.name,
      startedAt,
      completedAt: new Date().toISOString(),
      attempt: 1,
      parsed,
    };

    if (parsed.prUrl) {
      result.prUrl = parsed.prUrl;
    }
    if (parsed.prNumber !== undefined) {
      result.prNumber = parsed.prNumber;
    }

    return result;
  }
}

// ─── Standalone prompt builders (re-exported for backward compatibility) ───

export {
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  loadRepoInstructions,
};
