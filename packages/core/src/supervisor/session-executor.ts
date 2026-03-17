import path from "node:path";
import type { GitStrategy, McpServerConfig, RepoConfig } from "@/config";
import { createSessionClone, removeSessionClone } from "@/isolation/clone";
import { pushSessionBranch } from "@/isolation/git";
import { buildSandboxConfig } from "@/isolation/sandbox";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import { parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
import { formatMemoriesForPrompt, MemoryStore } from "@/supervisor/memory/index.js";
import type {
  DispatchInput,
  Middleware,
  MiddlewareContext,
  ResolvedAgent,
  StepResult,
  WorkflowStepDef,
} from "@/types";

// ─── Types ─────────────────────────────────────────────

export interface SessionExecutorConfig {
  sessionsDir: string;
  initTimeoutMs: number;
  maxDurationMs: number;
  recovery: {
    maxRetries: number;
    backoffBaseMs: number;
  };
}

export interface SessionContext {
  runId: string;
  sessionId: string;
  startedAt: string;
  stepName: string;
  stepDef: WorkflowStepDef;
  agent: ResolvedAgent;
  repoConfig: RepoConfig;
  input: DispatchInput;
}

export interface SessionEvents {
  onSessionStart?: (ctx: SessionContext) => void;
  onSessionComplete?: (ctx: SessionContext, result: StepResult) => void;
  onSessionFail?: (ctx: SessionContext, error: string, attempt: number, willRetry: boolean) => void;
  onRetry?: (ctx: SessionContext, attempt: number, strategy: string) => void;
}

// ─── Constants ─────────────────────────────────────────

const INSTRUCTIONS_PATH = ".neo/INSTRUCTIONS.md";

// ─── Repo instructions loader ──────────────────────────

async function loadRepoInstructions(repoPath: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
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
Write discoveries so the next agent on this repo starts smarter:
\`\`\`bash
# Stable facts — describe clearly for semantic search
neo memory write --type fact --scope $NEO_REPOSITORY "Uses Prisma ORM with PostgreSQL, migrations in prisma/migrations/"
neo memory write --type fact --scope $NEO_REPOSITORY "Biome for lint+format, config in biome.json"

# How-to procedures — non-obvious workflows
neo memory write --type procedure --scope $NEO_REPOSITORY "Integration tests require DATABASE_URL env var"
neo memory write --type procedure --scope $NEO_REPOSITORY "Always run pnpm build before push — CI doesn't rebuild"
\`\`\`

Write at key moments: after discovering conventions, after resolving a non-obvious issue, before finishing.`;
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

// ─── Session Executor ──────────────────────────────────

export class SessionExecutor {
  private readonly config: SessionExecutorConfig;
  private readonly userMiddleware: Middleware[];
  private readonly mcpServers: Record<string, McpServerConfig> | undefined;
  private memoryStore: MemoryStore | null = null;
  private readonly supervisorDir: string;

  constructor(
    config: SessionExecutorConfig,
    options: {
      middleware?: Middleware[];
      mcpServers?: Record<string, McpServerConfig>;
      supervisorDir: string;
    },
  ) {
    this.config = config;
    this.userMiddleware = options.middleware ?? [];
    this.mcpServers = options.mcpServers;
    this.supervisorDir = options.supervisorDir;
  }

  /**
   * Execute a session for the given context.
   * Handles clone creation, SDK invocation, and cleanup.
   */
  async execute(ctx: SessionContext, events?: SessionEvents): Promise<StepResult> {
    const startTime = Date.now();
    let sessionPath: string | undefined;

    try {
      // Create isolated clone if writable agent
      if (ctx.agent.sandbox === "writable") {
        sessionPath = await this.createSessionClone(ctx);
      }

      // Emit session start event
      events?.onSessionStart?.(ctx);

      const stepResult = await this.runAgentSession(ctx, sessionPath, events);
      events?.onSessionComplete?.(ctx, stepResult);

      return stepResult;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      events?.onSessionFail?.(ctx, errorMsg, 1, false);

      const failResult: StepResult = {
        status: "failure",
        sessionId: ctx.sessionId,
        costUsd: 0,
        durationMs: Date.now() - startTime,
        agent: ctx.agent.name,
        startedAt: ctx.startedAt,
        completedAt: new Date().toISOString(),
        error: errorMsg,
        attempt: 1,
      };

      // Write episode to memory store
      await this.writeEpisodeOnFailure(ctx, failResult);

      return failResult;
    } finally {
      // Auto-commit, push, and cleanup session clone
      if (sessionPath) {
        await this.finalizeSession(sessionPath, ctx);
      }
    }
  }

  /**
   * Load memory context for a repository.
   */
  loadMemoryContext(repoPath: string): string | undefined {
    try {
      const store = this.getMemoryStore();
      const memories = store.query({
        scope: repoPath,
        types: ["fact", "procedure", "feedback"],
        limit: 25,
        sortBy: "relevance",
      });
      if (memories.length === 0) return undefined;
      store.markAccessed(memories.map((m) => m.id));
      return formatMemoriesForPrompt(memories);
    } catch {
      return undefined;
    }
  }

  /**
   * Write an episode to memory for run tracking.
   */
  async writeEpisode(ctx: SessionContext, result: StepResult): Promise<void> {
    try {
      const store = this.getMemoryStore();
      const isSuccess = result.status === "success";
      await store.write({
        type: "episode",
        scope: ctx.input.repo,
        content: `Run ${ctx.runId.slice(0, 8)} (${ctx.agent.name}): ${isSuccess ? "completed" : "failed"}${result.error ? ` — ${result.error.slice(0, 150)}` : ""}`,
        source: ctx.agent.name,
        outcome: isSuccess ? "success" : "failure",
        runId: ctx.runId,
      });
    } catch {
      // Best-effort — don't fail the run if memory write fails
    }
  }

  // ─── Private methods ──────────────────────────────────

  private getMemoryStore(): MemoryStore {
    if (!this.memoryStore) {
      this.memoryStore = new MemoryStore(path.join(this.supervisorDir, "memory.sqlite"));
    }
    return this.memoryStore;
  }

  private async createSessionClone(ctx: SessionContext): Promise<string> {
    const branchName = ctx.input.branch as string;
    const sessionDir = path.join(this.config.sessionsDir, ctx.runId);
    const info = await createSessionClone({
      repoPath: ctx.input.repo,
      branch: branchName,
      baseBranch: ctx.repoConfig.defaultBranch,
      sessionDir,
    });
    return info.path;
  }

  private async runAgentSession(
    ctx: SessionContext,
    sessionPath: string | undefined,
    events?: SessionEvents,
  ): Promise<StepResult> {
    const { runId, stepDef, agent, input } = ctx;

    const sandboxConfig = buildSandboxConfig(agent, sessionPath);
    const chain = buildMiddlewareChain(this.userMiddleware);
    const middlewareContext = this.buildMiddlewareContext(ctx);
    const hooks = buildSDKHooks(chain, middlewareContext, this.userMiddleware);

    // Build the full prompt with repo instructions and git strategy context
    const repoInstructions = await loadRepoInstructions(input.repo);
    const strategy: GitStrategy = input.gitStrategy ?? ctx.repoConfig.gitStrategy ?? "branch";

    if (agent.sandbox === "writable" && !input.branch) {
      throw new Error(
        "Validation error: --branch is required for writable agents. Provide an explicit branch name (e.g. --branch feat/PROJ-42-description).",
      );
    }

    const branch = agent.sandbox === "writable" ? (input.branch as string) : "";
    const gitInstructions = buildGitStrategyInstructions(
      strategy,
      agent,
      branch,
      ctx.repoConfig.defaultBranch,
      ctx.repoConfig.pushRemote ?? "origin",
      input.metadata,
    );
    const taskPrompt = stepDef.prompt ?? input.prompt;

    // Memory injection: load relevant memories for this repo
    const memoryContext = this.loadMemoryContext(input.repo);

    // Inject working directory context so the agent knows where to operate.
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

    const recoveryOpts = stepDef.recovery;
    const mcpServers = this.resolveMcpServers(stepDef, agent);

    // Inject env vars so agents can use `neo log` and `neo memory` for reporting
    const agentEnv: Record<string, string> = {
      NEO_RUN_ID: runId,
      NEO_AGENT_NAME: agent.name,
      NEO_REPOSITORY: input.repo,
    };

    const sessionResult = await runWithRecovery({
      agent,
      prompt: fullPrompt,
      repoPath: input.repo,
      sandboxConfig,
      hooks,
      env: agentEnv,
      initTimeoutMs: this.config.initTimeoutMs,
      maxDurationMs: this.config.maxDurationMs,
      maxRetries: recoveryOpts?.maxRetries ?? this.config.recovery.maxRetries,
      backoffBaseMs: this.config.recovery.backoffBaseMs,
      ...(sessionPath ? { sessionPath } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(recoveryOpts?.nonRetryable ? { nonRetryable: recoveryOpts.nonRetryable } : {}),
      onAttempt: (attempt, strategy) => {
        if (attempt > 1) {
          events?.onRetry?.(ctx, attempt - 1, strategy);
        }
      },
    });

    const parsed = parseOutput(sessionResult.output);

    const result: StepResult = {
      status: "success",
      sessionId: sessionResult.sessionId,
      output: parsed.output ?? parsed.rawOutput,
      rawOutput: sessionResult.output,
      costUsd: sessionResult.costUsd,
      durationMs: sessionResult.durationMs,
      agent: agent.name,
      startedAt: ctx.startedAt,
      completedAt: new Date().toISOString(),
      attempt: 1,
    };

    if (parsed.prUrl) {
      result.prUrl = parsed.prUrl;
    }
    if (parsed.prNumber !== undefined) {
      result.prNumber = parsed.prNumber;
    }

    // Write episode to memory store
    await this.writeEpisode(ctx, result);

    return result;
  }

  private async finalizeSession(sessionPath: string, ctx: SessionContext): Promise<void> {
    const { repoConfig, input } = ctx;
    const branch = input.branch as string;
    const remote = repoConfig.pushRemote ?? "origin";

    try {
      await pushSessionBranch(sessionPath, branch, remote).catch(() => {
        // Push may fail (no remote, auth, etc.) — not critical
      });
    } catch {
      // Best-effort — don't let finalization errors mask the real result
    }

    try {
      await removeSessionClone(sessionPath);
    } catch {
      // Session cleanup is best-effort
    }
  }

  private async writeEpisodeOnFailure(ctx: SessionContext, failResult: StepResult): Promise<void> {
    try {
      const store = this.getMemoryStore();
      await store.write({
        type: "episode",
        scope: ctx.input.repo,
        content: `Run ${ctx.runId.slice(0, 8)} (${ctx.agent.name}): failed${failResult.error ? ` — ${failResult.error.slice(0, 150)}` : ""}`,
        source: ctx.agent.name,
        outcome: "failure",
        runId: ctx.runId,
      });
    } catch {
      // Best-effort — don't fail the run if memory write fails
    }
  }

  private buildMiddlewareContext(ctx: SessionContext): MiddlewareContext {
    const store = new Map<string, unknown>();
    return {
      runId: ctx.runId,
      workflow: ctx.input.workflow,
      step: ctx.stepName,
      agent: ctx.agent.name,
      repo: ctx.input.repo,
      get: ((key: string) => store.get(key)) as MiddlewareContext["get"],
      set: ((key: string, value: unknown) => {
        store.set(key, value);
      }) as MiddlewareContext["set"],
    };
  }

  private resolveMcpServers(
    stepDef: WorkflowStepDef,
    agent: ResolvedAgent,
  ): Record<string, McpServerConfig> | undefined {
    if (!this.mcpServers) return undefined;

    // Collect unique server names from step definition and agent definition
    const names = new Set<string>();
    if (stepDef.mcpServers) {
      for (const name of stepDef.mcpServers) names.add(name);
    }
    if (agent.definition.mcpServers) {
      for (const name of agent.definition.mcpServers) names.add(name);
    }

    if (names.size === 0) return undefined;

    const resolved: Record<string, McpServerConfig> = {};
    for (const name of names) {
      const serverConfig = this.mcpServers[name];
      if (serverConfig) {
        resolved[name] = serverConfig;
      }
    }

    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }
}
