import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitStrategy, McpServerConfig, RepoConfig } from "@/config";
import { buildSandboxConfig } from "@/isolation/sandbox";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import { type ParsedOutput, parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
import type {
  Middleware,
  MiddlewareContext,
  ResolvedAgent,
  StepResult,
  WorkflowStepDef,
} from "@/types";

// ─── Constants ─────────────────────────────────────────

const INSTRUCTIONS_PATH = ".neo/INSTRUCTIONS.md";

// ─── Types ─────────────────────────────────────────────

export interface SessionExecutionInput {
  runId: string;
  sessionId: string;
  agent: ResolvedAgent;
  stepDef: WorkflowStepDef;
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

// ─── Repo instructions loader ──────────────────────────

async function loadRepoInstructions(repoPath: string): Promise<string | undefined> {
  const filePath = path.join(repoPath, INSTRUCTIONS_PATH);
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

// ─── Git strategy prompt builder ───────────────────────

function buildGitStrategyInstructions(
  strategy: GitStrategy,
  agent: ResolvedAgent,
  branch: string,
  baseBranch: string,
  remote: string,
  metadata?: Record<string, unknown>,
): string | null {
  const prNumber = metadata?.prNumber as number | undefined;

  // Readonly agents: only inject PR comment instruction if a PR exists
  if (agent.sandbox !== "writable") {
    if (prNumber) {
      return `## Pull Request\n\nPR #${String(prNumber)} is open for this task. After your review, leave your findings as a comment: \`gh pr comment ${String(prNumber)} --body "..."\`.`;
    }
    return null;
  }

  // Writable agents: inject git workflow context
  if (strategy === "pr") {
    if (prNumber) {
      return `## Git workflow\n\nYou are on branch \`${branch}\`.\nAn open PR exists: #${String(prNumber)}.\nAfter committing, push your changes to the branch. The PR will be updated automatically.\nLeave a review comment on the PR summarizing what you did: \`gh pr comment ${String(prNumber)} --body "..."\`.`;
    }
    return `## Git workflow\n\nYou are on branch \`${branch}\` (base: \`${baseBranch}\`).\nAfter committing:\n1. Push: \`git push -u ${remote} ${branch}\`\n2. Create a PR against \`${baseBranch}\` — choose a title and description that reflect the work you completed. End the PR body with: \`🤖 Generated with [neo](https://neotx.dev)\`\n3. Output the PR URL on a dedicated line: \`PR_URL: <url>\``;
  }

  // strategy === "branch"
  return `## Git workflow\n\nYou are on branch \`${branch}\` (base: \`${baseBranch}\`).\nCommit your changes. The branch will be pushed automatically.`;
}

// ─── Reporting instructions for agents ──────────────────

function buildReportingInstructions(_runId: string): string {
  return `## Reporting & Memory

### Progress reporting (real-time, visible in TUI)
Chain \`neo log\` with the command that triggered it — never standalone:
\`\`\`bash
pnpm test && neo log milestone "all tests passing" || neo log blocker "tests failing"
git push origin HEAD && neo log action "pushed to branch"
neo log decision "chose JWT over sessions — simpler for MVP"
\`\`\`

### Memory (persistent, injected into future agent prompts)
Write discoveries so the next agent on this repo starts smarter.

**Be selective** — only write a memory if it would change HOW you or future agents approach work:
\`\`\`bash
# GOOD: affects workflow decisions
neo memory write --type fact --scope $NEO_REPOSITORY "CI requires pnpm build before push — no auto-rebuild in pipeline"
neo memory write --type fact --scope $NEO_REPOSITORY "Biome enforces complexity max 20 — extract helpers for large functions"
neo memory write --type procedure --scope $NEO_REPOSITORY "Integration tests require DATABASE_URL env var — set before running"

# BAD: trivial or derivable — do NOT write these
# "packages/core has 71 files" — derivable from ls
# "Uses React 19" — visible in package.json
# "apps/web has no test framework" — derivable from ls/cat
\`\`\`

**The test**: if \`cat package.json\`, \`ls\`, or reading the README can answer it, do NOT memorize it. Only memorize truths that affect decisions or non-obvious workflows learned from failure.

Write at key moments: after resolving a non-obvious issue, after discovering a build/CI quirk, before finishing.`;
}

// ─── Full prompt assembler ─────────────────────────────

function buildFullPrompt(
  agentPrompt: string | undefined,
  repoInstructions: string | undefined,
  gitInstructions: string | null,
  taskPrompt: string,
  memoryContext?: string | undefined,
  cwdInstructions?: string | undefined,
  reportingInstructions?: string | undefined,
): string {
  const sections: string[] = [];

  if (agentPrompt) sections.push(agentPrompt);
  if (cwdInstructions) sections.push(cwdInstructions);
  if (memoryContext) sections.push(memoryContext);
  if (repoInstructions) sections.push(`## Repository instructions\n\n${repoInstructions}`);
  if (gitInstructions) sections.push(gitInstructions);
  if (reportingInstructions) sections.push(reportingInstructions);
  sections.push(`## Task\n\n${taskPrompt}`);

  return sections.join("\n\n---\n\n");
}

// ─── Middleware context builder ────────────────────────

function buildMiddlewareContext(
  runId: string,
  workflow: string,
  step: string,
  agent: string,
  repo: string,
  getContextValue: (key: string) => unknown,
): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    runId,
    workflow,
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
      stepDef,
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
      stepDef.prompt ? "workflow" : "direct",
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
      stepDef.prompt ?? taskPrompt,
      memoryContext,
      cwdInstructions,
      reportingInstructions,
    );

    // Execute session with recovery
    const recoveryOpts = stepDef.recovery;
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
      initTimeoutMs: this.config.initTimeoutMs,
      maxDurationMs: this.config.maxDurationMs,
      maxRetries: recoveryOpts?.maxRetries ?? this.config.maxRetries,
      backoffBaseMs: this.config.backoffBaseMs,
      ...(sessionPath ? { sessionPath } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(recoveryOpts?.nonRetryable ? { nonRetryable: recoveryOpts.nonRetryable } : {}),
      ...(onAttempt ? { onAttempt } : {}),
    });

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
