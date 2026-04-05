import type { GitStrategy, McpServerConfig, RepoConfig } from "@/config";
import { buildSandboxConfig } from "@/isolation/sandbox";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import {
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  loadRepoInstructions,
} from "@/orchestrator/prompt-builder";
import { type ParsedOutput, parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
import { SessionError } from "@/runner/session";
import type { Middleware, MiddlewareContext, ResolvedAgent, StepResult } from "@/types";

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
  claudeCodePath?: string | undefined;
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

// ─── Middleware context builder ────────────────────────

function buildMiddlewareContext(
  runId: string,
  step: string,
  agent: string,
  repo: string,
  getContextValue: (key: string) => unknown,
): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    runId,
    step,
    agent,
    repo,
    get: ((key: string) => {
      const value = getContextValue(key);
      if (value !== undefined) return value;
      return store.get(key);
    }) as MiddlewareContext["get"],
    set: ((key: string, value: unknown) => {
      store.set(key, value);
    }) as MiddlewareContext["set"],
  };
}

// ─── SessionExecutor ───────────────────────────────────

/**
 * Encapsulates session execution logic: prompt building, SDK calls, and response processing.
 * Extracted from Orchestrator for better testability and separation of concerns.
 */
export class SessionExecutor {
  constructor(
    private readonly config: SessionExecutionConfig,
    private readonly getContextValue: (key: string) => unknown,
  ) {}

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

    const { middleware, mcpServers, memoryContext, onAttempt } = deps;

    // Validate writable agents have a branch
    if (agent.sandbox === "writable" && !branch) {
      throw new Error(
        "Validation error: --branch is required for writable agents. Provide an explicit branch name (e.g. --branch feat/PROJ-42-description).",
      );
    }

    const branchName = agent.sandbox === "writable" ? (branch as string) : "";

    // Build sandbox config for agent
    const sandboxConfig = buildSandboxConfig(agent, sessionPath);

    // Build middleware chain and SDK hooks
    const chain = buildMiddlewareChain(middleware);
    const middlewareContext = buildMiddlewareContext(
      runId,
      "execute",
      agent.name,
      repoPath,
      this.getContextValue,
    );
    const hooks = buildSDKHooks(chain, middlewareContext, middleware);

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
      hooks,
      env: agentEnv,
      agents: agent.definition.agents,
      initTimeoutMs: this.config.initTimeoutMs,
      maxDurationMs: this.config.maxDurationMs,
      maxRetries: this.config.maxRetries,
      backoffBaseMs: this.config.backoffBaseMs,
      ...(sessionPath ? { sessionPath } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(onAttempt ? { onAttempt } : {}),
      ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
      ...(this.config.claudeCodePath ? { claudeCodePath: this.config.claudeCodePath } : {}),
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
