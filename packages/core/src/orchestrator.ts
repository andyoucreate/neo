import { Semaphore } from "@/concurrency/semaphore";
import type { GitStrategy, McpServerConfig, NeoConfig, RepoConfig } from "@/config";
import { CostJournal } from "@/cost/journal";
import { NeoEventEmitter } from "@/events";
import { EventJournal } from "@/events/journal";
import { WebhookDispatcher } from "@/events/webhook";
import { createSessionClone, removeSessionClone } from "@/isolation/clone";
import { pushSessionBranch } from "@/isolation/git";
import { buildSandboxConfig } from "@/isolation/sandbox";
import { auditLog } from "@/middleware/audit-log";
import { budgetGuard } from "@/middleware/budget-guard";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import { loopDetection } from "@/middleware/loop-detection";
import { getJournalsDir, getRepoRunsDir, getRunsDir, getSupervisorsDir, toRepoSlug } from "@/paths";
import { parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
import { loadKnowledge } from "@/supervisor/knowledge";
import type {
  ActiveSession,
  CostEntry,
  DispatchInput,
  Middleware,
  MiddlewareContext,
  NeoEvent,
  OrchestratorStatus,
  PersistedRun,
  ResolvedAgent,
  StepResult,
  TaskResult,
  WorkflowDefinition,
  WorkflowStepDef,
} from "@/types";
import { WorkflowRegistry } from "@/workflows/registry";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Constants ─────────────────────────────────────────

const MAX_PROMPT_SIZE = 100 * 1024; // 100 KB
const MAX_METADATA_DEPTH = 5;
const SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Session clones are stored in the configured sessions.dir (default: /tmp/neo-sessions)
const INSTRUCTIONS_PATH = ".neo/INSTRUCTIONS.md";
const textEncoder = new TextEncoder();

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

// ─── Helpers ────────────────────────────────────────────

function formatTimeAgo(ms: number): string {
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Reporting instructions for agents ──────────────────

function buildReportingInstructions(runId: string): string {
  const shortId = runId.slice(0, 8);
  return `## Reporting

Report progress so the supervisor can track your work. Environment is pre-configured.

\`\`\`bash
neo log decision "chose X because Y"       # key decisions
neo log action "opened PR #42"              # actions taken
neo log blocker "missing API key in vault"  # blocked (wakes supervisor)
neo log milestone "all tests passing"       # major milestone
neo log discovery --knowledge "repo uses Prisma ORM"  # stable fact
\`\`\`

Track your run narrative:
\`\`\`bash
neo notes ${shortId} observation "tests passing, 2 warnings"
neo notes ${shortId} decision "split migration into 2 PRs"
neo notes ${shortId} blocker "CI failing — missing env var"
neo notes ${shortId} resolution "env var added, CI green"
\`\`\`

Log at key moments: after decisions, on blockers, and before finishing.`;
}

// ─── Full prompt assembler ─────────────────────────────

function buildFullPrompt(
  agentPrompt: string | undefined,
  repoInstructions: string | undefined,
  gitInstructions: string | null,
  taskPrompt: string,
  knowledgeContext?: string | undefined,
  crossRunLessons?: string | undefined,
  cwdInstructions?: string | undefined,
  reportingInstructions?: string | undefined,
): string {
  const sections: string[] = [];

  if (agentPrompt) sections.push(agentPrompt);
  if (cwdInstructions) sections.push(cwdInstructions);
  if (knowledgeContext) sections.push(knowledgeContext);
  if (crossRunLessons) sections.push(crossRunLessons);
  if (repoInstructions) sections.push(`## Repository instructions\n\n${repoInstructions}`);
  if (gitInstructions) sections.push(gitInstructions);
  if (reportingInstructions) sections.push(reportingInstructions);
  sections.push(`## Task\n\n${taskPrompt}`);

  return sections.join("\n\n---\n\n");
}

// ─── Options ───────────────────────────────────────────

export interface OrchestratorOptions {
  middleware?: Middleware[] | undefined;
  journalDir?: string | undefined;
  builtInWorkflowDir?: string | undefined;
  customWorkflowDir?: string | undefined;
}

// ─── Internal dispatch context ─────────────────────────

interface DispatchContext {
  input: DispatchInput;
  runId: string;
  sessionId: string;
  startedAt: number;
  stepName: string;
  stepDef: WorkflowStepDef;
  agent: ResolvedAgent;
  repoConfig: RepoConfig;
  activeSession: ActiveSession;
}

// ─── Idempotency ───────────────────────────────────────

interface IdempotencyEntry {
  result: TaskResult;
  expiresAt: number;
}

// ─── Orchestrator ──────────────────────────────────────

export class Orchestrator extends NeoEventEmitter {
  private readonly config: NeoConfig;
  private readonly semaphore: Semaphore;
  private readonly userMiddleware: Middleware[];
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly registeredAgents = new Map<string, ResolvedAgent>();
  private readonly _activeSessions = new Map<string, ActiveSession>();
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly repoIndex = new Map<string, RepoConfig>();
  private readonly createdRunDirs = new Set<string>();
  private readonly journalDir: string;
  private readonly builtInWorkflowDir: string | undefined;
  private readonly customWorkflowDir: string | undefined;
  private costJournal: CostJournal | null = null;
  private eventJournal: EventJournal | null = null;
  private webhookDispatcher: WebhookDispatcher | null = null;
  private _paused = false;
  private _costToday = 0;
  private _startedAt = 0;
  private _drainResolve: (() => void) | null = null;

  constructor(config: NeoConfig, options: OrchestratorOptions = {}) {
    super();
    this.config = config;
    this.userMiddleware = options.middleware ?? [];
    this.journalDir = options.journalDir ?? getJournalsDir();
    this.builtInWorkflowDir = options.builtInWorkflowDir;
    this.customWorkflowDir = options.customWorkflowDir;
    for (const repo of config.repos) {
      const resolvedPath = path.resolve(repo.path);
      const normalizedRepo = { ...repo, path: resolvedPath };
      this.repoIndex.set(resolvedPath, normalizedRepo);
    }
    this.semaphore = new Semaphore(
      {
        maxSessions: config.concurrency.maxSessions,
        maxPerRepo: config.concurrency.maxPerRepo,
        queueMax: config.concurrency.queueMax,
      },
      {
        onEnqueue: (sessionId, repo, position) => {
          this.emit({
            type: "queue:enqueue",
            sessionId,
            repo,
            position,
            timestamp: new Date().toISOString(),
          });
        },
        onDequeue: (sessionId, repo, waitedMs) => {
          this.emit({
            type: "queue:dequeue",
            sessionId,
            repo,
            waitedMs,
            timestamp: new Date().toISOString(),
          });
        },
      },
    );
  }

  // ─── Registration ──────────────────────────────────────

  registerWorkflow(definition: WorkflowDefinition): void {
    this.workflows.set(definition.name, definition);
  }

  registerAgent(agent: ResolvedAgent): void {
    this.registeredAgents.set(agent.name, agent);
  }

  // ─── Dispatch ──────────────────────────────────────────

  async dispatch(input: DispatchInput): Promise<TaskResult> {
    const idempotencyKey = this.preDispatchChecks(input);
    const ctx = this.buildDispatchContext(input);

    // Acquire semaphore (blocks if at capacity)
    const abortController = new AbortController();
    this.abortControllers.set(ctx.sessionId, abortController);
    await this.semaphore.acquire(
      input.repo,
      ctx.sessionId,
      input.priority ?? "medium",
      abortController.signal,
    );
    ctx.activeSession.status = "running";

    const stepResult = await this.executeStep(ctx);
    return this.finalizeDispatch(ctx, stepResult, idempotencyKey);
  }

  // ─── Control ───────────────────────────────────────────

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  async kill(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort(new Error("Session killed"));
    }

    this._activeSessions.delete(sessionId);
    this.abortControllers.delete(sessionId);
    this.semaphore.release(sessionId);
  }

  async drain(): Promise<void> {
    this._paused = true;
    if (this._activeSessions.size === 0) return;
    return new Promise<void>((resolve) => {
      this._drainResolve = resolve;
    });
  }

  // ─── Getters ───────────────────────────────────────────

  get status(): OrchestratorStatus {
    return {
      paused: this._paused,
      activeSessions: [...this._activeSessions.values()],
      queueDepth: this.semaphore.queueDepth(),
      costToday: this._costToday,
      budgetCapUsd: this.config.budget.dailyCapUsd,
      budgetRemainingPct: this.computeBudgetRemainingPct(),
      uptime: this._startedAt > 0 ? Date.now() - this._startedAt : 0,
    };
  }

  get activeSessions(): ActiveSession[] {
    return [...this._activeSessions.values()];
  }

  // ─── Lifecycle ─────────────────────────────────────────

  async start(): Promise<void> {
    this._startedAt = Date.now();

    // Initialize journals
    this.costJournal = new CostJournal({ dir: this.journalDir });
    this.eventJournal = new EventJournal({ dir: this.journalDir });

    // Initialize webhook dispatcher with configured webhooks + auto-discovered supervisor webhooks
    const supervisorWebhooks = await this.discoverSupervisorWebhooks();

    const allWebhooks = [...this.config.webhooks, ...supervisorWebhooks];
    if (allWebhooks.length > 0) {
      this.webhookDispatcher = new WebhookDispatcher(allWebhooks);
    }

    // Restore today's cost from journal
    this._costToday = await this.costJournal.getDayTotal();

    // Load workflows from registry if dirs are configured
    if (this.builtInWorkflowDir) {
      const registry = new WorkflowRegistry(this.builtInWorkflowDir, this.customWorkflowDir);
      await registry.load();
      for (const workflow of registry.list()) {
        this.registerWorkflow(workflow);
      }
    }

    await this.recoverOrphanedRuns();

    await mkdir(this.config.sessions.dir, { recursive: true });
  }

  async shutdown(): Promise<void> {
    this._paused = true;

    if (this._activeSessions.size > 0) {
      await Promise.race([
        this.drain(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    }

    for (const mw of this.userMiddleware) {
      if ("flush" in mw && typeof mw.flush === "function") {
        await (mw as { flush: () => Promise<void> }).flush();
      }
      if ("cleanup" in mw && typeof mw.cleanup === "function") {
        for (const session of this._activeSessions.values()) {
          (mw as { cleanup: (id: string) => void }).cleanup(session.sessionId);
        }
      }
    }

    this.emit({
      type: "orchestrator:shutdown",
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Emit override (journal events) ───────────────────

  override emit(event: NeoEvent): void {
    super.emit(event);
    // Fire-and-forget event journal append
    if (this.eventJournal) {
      this.eventJournal.append(event).catch(() => {});
    }
    // Fire-and-forget webhook dispatch
    if (this.webhookDispatcher) {
      this.webhookDispatcher.dispatch(event);
    }
  }

  // ─── Static middleware factories ───────────────────────

  static middleware = {
    loopDetection: (options: { threshold: number; scope?: "session" }) => loopDetection(options),
    auditLog: (options: {
      dir: string;
      includeInput?: boolean;
      includeOutput?: boolean;
      flushIntervalMs?: number;
      flushSize?: number;
    }) => auditLog(options),
    budgetGuard: () => budgetGuard(),
  };

  // ─── Private: Dispatch phases ──────────────────────────

  private preDispatchChecks(input: DispatchInput): string | null {
    this.validateInput(input);

    const idempotencyKey = this.computeIdempotencyKey(input);
    if (idempotencyKey) {
      this.evictExpiredIdempotencyEntries();
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached && cached.expiresAt > Date.now()) {
        throw new Error(
          `Duplicate dispatch rejected: runId '${input.runId ?? "auto-generated"}' already exists. Each dispatch must use a unique runId.`,
        );
      }
    }

    if (this._paused) {
      throw new Error(
        "Dispatch rejected: orchestrator is paused. Call orchestrator.resume() before dispatching.",
      );
    }

    return idempotencyKey;
  }

  private buildDispatchContext(input: DispatchInput): DispatchContext {
    const runId = input.runId ?? randomUUID();
    const sessionId = randomUUID();
    const workflow = this.workflows.get(input.workflow);
    if (!workflow) {
      const available = [...this.workflows.keys()].join(", ") || "none";
      throw new Error(
        `Workflow "${input.workflow}" not found. Available workflows: ${available}. Check the workflow name or register it first.`,
      );
    }
    const [stepName, stepDef] = this.getFirstStep(workflow, input);
    const agent = this.resolveStepAgent(stepDef, workflow.name);
    const repoConfig = this.resolveRepo(input.repo);

    const activeSession: ActiveSession = {
      sessionId,
      runId,
      workflow: input.workflow,
      step: stepName,
      agent: agent.name,
      repo: input.repo,
      status: "queued",
      startedAt: new Date().toISOString(),
    };
    this._activeSessions.set(sessionId, activeSession);

    return {
      input,
      runId,
      sessionId,
      startedAt: Date.now(),
      stepName,
      stepDef,
      agent,
      repoConfig,
      activeSession,
    };
  }

  private async executeStep(ctx: DispatchContext): Promise<StepResult> {
    const { input, runId, sessionId, startedAt, agent, repoConfig, activeSession } = ctx;
    let sessionPath: string | undefined;

    // Persist initial running state so `neo runs` shows this run immediately
    await this.persistRun({
      version: 1,
      runId,
      workflow: input.workflow,
      repo: input.repo,
      prompt: input.prompt,
      status: "running",
      steps: {},
      createdAt: activeSession.startedAt,
      updatedAt: new Date().toISOString(),
      metadata: input.metadata,
    });

    try {
      // Create isolated clone if writable agent
      if (agent.sandbox === "writable") {
        const branchName = input.branch as string;
        const sessionDir = path.join(this.config.sessions.dir, runId);
        const info = await createSessionClone({
          repoPath: input.repo,
          branch: branchName,
          baseBranch: repoConfig.defaultBranch,
          sessionDir,
        });
        sessionPath = info.path;
        activeSession.sessionPath = sessionPath;
      }

      const stepResult = await this.runAgentSession(ctx, sessionPath);
      this.emitCostEvents(sessionId, stepResult.costUsd, ctx);
      this.emitSessionComplete(ctx, stepResult);
      return stepResult;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitSessionFail(ctx, errorMsg);

      return {
        status: "failure",
        sessionId,
        costUsd: 0,
        durationMs: Date.now() - startedAt,
        agent: agent.name,
        startedAt: activeSession.startedAt,
        completedAt: new Date().toISOString(),
        error: errorMsg,
        attempt: 1,
      };
    } finally {
      // Auto-commit, push, and cleanup session clone
      if (sessionPath) {
        await this.finalizeSession(sessionPath, ctx);
      }

      this.semaphore.release(sessionId);
      this._activeSessions.delete(sessionId);
      this.abortControllers.delete(sessionId);

      if (this._activeSessions.size === 0 && this._drainResolve) {
        this._drainResolve();
        this._drainResolve = null;
      }
    }
  }

  /**
   * Push the branch, then remove the session clone.
   * Runs in `finally` so it executes on both success and failure.
   */
  private async finalizeSession(sessionPath: string, ctx: DispatchContext): Promise<void> {
    const { repoConfig } = ctx;
    const branch = ctx.input.branch as string;
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

  private async runAgentSession(
    ctx: DispatchContext,
    sessionPath: string | undefined,
  ): Promise<StepResult> {
    const { input, runId, sessionId, stepName, stepDef, agent, activeSession } = ctx;

    const sandboxConfig = buildSandboxConfig(agent, sessionPath);
    const chain = buildMiddlewareChain(this.userMiddleware);
    const middlewareContext = this.buildMiddlewareContext(
      runId,
      input.workflow,
      stepName,
      agent.name,
      input.repo,
    );
    const hooks = buildSDKHooks(chain, middlewareContext, this.userMiddleware);

    this.emit({
      type: "session:start",
      sessionId,
      runId,
      workflow: input.workflow,
      step: stepName,
      agent: agent.name,
      repo: input.repo,
      metadata: input.metadata,
      timestamp: new Date().toISOString(),
    });

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

    // Knowledge injection: load known facts about this repo
    const knowledgeContext = await this.loadKnowledgeContext(input.repo);

    // Cross-run learning: extract lessons from recent failed runs on this repo
    const crossRunLessons = await this.loadCrossRunLessons(input.repo);

    // Inject working directory context so the agent knows where to operate.
    // Without this, Claude Code may resolve to the wrong directory.
    const cwdInstructions = sessionPath
      ? `## Working directory\n\nYou are working in an isolated clone at: \`${sessionPath}\`\nALWAYS run commands from this directory. NEVER cd to or operate on any other repository.`
      : undefined;

    const reportingInstructions = buildReportingInstructions(runId);

    const fullPrompt = buildFullPrompt(
      agent.definition.prompt,
      repoInstructions,
      gitInstructions,
      taskPrompt,
      knowledgeContext,
      crossRunLessons,
      cwdInstructions,
      reportingInstructions,
    );

    const recoveryOpts = stepDef.recovery;
    const mcpServers = this.resolveMcpServers(stepDef, agent);

    // Inject env vars so agents can use `neo log` and `neo notes` for reporting
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
      initTimeoutMs: this.config.sessions.initTimeoutMs,
      maxDurationMs: this.config.sessions.maxDurationMs,
      maxRetries: recoveryOpts?.maxRetries ?? this.config.recovery.maxRetries,
      backoffBaseMs: this.config.recovery.backoffBaseMs,
      ...(sessionPath ? { sessionPath } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(recoveryOpts?.nonRetryable ? { nonRetryable: recoveryOpts.nonRetryable } : {}),
      onAttempt: (attempt, strategy) => {
        if (attempt > 1) {
          this.emit({
            type: "session:fail",
            sessionId,
            runId,
            error: `Retrying with strategy: ${strategy}`,
            attempt: attempt - 1,
            maxRetries: recoveryOpts?.maxRetries ?? this.config.recovery.maxRetries,
            willRetry: true,
            metadata: input.metadata,
            timestamp: new Date().toISOString(),
          });
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
      startedAt: activeSession.startedAt,
      completedAt: new Date().toISOString(),
      attempt: 1,
    };

    if (parsed.prUrl) {
      result.prUrl = parsed.prUrl;
    }
    if (parsed.prNumber !== undefined) {
      result.prNumber = parsed.prNumber;
    }

    return result;
  }

  private async finalizeDispatch(
    ctx: DispatchContext,
    stepResult: StepResult,
    idempotencyKey: string | null,
  ): Promise<TaskResult> {
    const { input, runId, stepName, activeSession } = ctx;

    const taskResult: TaskResult = {
      runId,
      workflow: input.workflow,
      repo: input.repo,
      status: stepResult.status === "success" ? "success" : "failure",
      steps: { [stepName]: stepResult },
      branch:
        stepResult.status === "success" && activeSession.sessionPath ? input.branch : undefined,
      costUsd: stepResult.costUsd,
      durationMs: Date.now() - ctx.startedAt,
      timestamp: new Date().toISOString(),
      metadata: input.metadata,
    };

    if (stepResult.prUrl) {
      taskResult.prUrl = stepResult.prUrl;
    }
    if (stepResult.prNumber !== undefined) {
      taskResult.prNumber = stepResult.prNumber;
    }

    await this.persistRun({
      version: 1,
      runId,
      workflow: input.workflow,
      repo: input.repo,
      prompt: input.prompt,
      branch: taskResult.branch,
      status: taskResult.status === "success" ? "completed" : "failed",
      steps: taskResult.steps,
      createdAt: activeSession.startedAt,
      updatedAt: new Date().toISOString(),
      metadata: input.metadata,
    });

    if (idempotencyKey) {
      const ttl = this.config.idempotency?.ttlMs ?? 3_600_000;
      this.idempotencyCache.set(idempotencyKey, {
        result: taskResult,
        expiresAt: Date.now() + ttl,
      });
    }

    return taskResult;
  }

  // ─── Private: Knowledge injection ─────────────────────

  /**
   * Load knowledge relevant to the target repo from the default supervisor.
   * Returns a formatted section or undefined if no knowledge exists.
   */
  private async loadKnowledgeContext(_repoPath: string): Promise<string | undefined> {
    try {
      const supervisorDir = path.join(getSupervisorsDir(), "supervisor");
      const knowledge = await loadKnowledge(supervisorDir);
      if (!knowledge.trim()) return undefined;

      return `## Known facts\n${knowledge}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Load lessons from recent failed runs on the same repo.
   * Returns a formatted section or undefined if no lessons exist.
   */
  private async loadCrossRunLessons(repoPath: string): Promise<string | undefined> {
    try {
      const repoSlug = toRepoSlug({ path: repoPath });
      const repoRunsDir = getRepoRunsDir(repoSlug);
      if (!existsSync(repoRunsDir)) return undefined;

      const files = await readdir(repoRunsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".dispatch.json"));

      // Read all run files and filter to recent failures
      const failedRuns: Array<{
        runId: string;
        agent: string;
        error: string;
        completedAt: string;
      }> = [];
      for (const file of jsonFiles) {
        try {
          const raw = await readFile(path.join(repoRunsDir, file), "utf-8");
          const run = JSON.parse(raw) as PersistedRun;
          if (run.status !== "failed") continue;

          // Extract error from failed steps
          for (const step of Object.values(run.steps)) {
            if (step.status === "failure" && step.error && step.completedAt) {
              failedRuns.push({
                runId: run.runId.slice(0, 8),
                agent: step.agent,
                error: step.error.slice(0, 200),
                completedAt: step.completedAt,
              });
            }
          }
        } catch {
          // Skip corrupted files
        }
      }

      if (failedRuns.length === 0) return undefined;

      // Sort by most recent, take last 5
      failedRuns.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
      const recent = failedRuns.slice(0, 5);

      const now = Date.now();
      const lines = recent.map((r) => {
        const ago = formatTimeAgo(now - new Date(r.completedAt).getTime());
        return `- Run ${r.runId} (${r.agent}, ${ago}): Failed — "${r.error}"`;
      });

      return `## Lessons from previous runs on this repository\n${lines.join("\n")}`;
    } catch {
      return undefined;
    }
  }

  // ─── Private: Event helpers ────────────────────────────

  private emitCostEvents(sessionId: string, sessionCost: number, ctx: DispatchContext): void {
    this._costToday += sessionCost;

    // Persist cost entry to journal (fire-and-forget)
    if (this.costJournal) {
      const costEntry: CostEntry = {
        timestamp: new Date().toISOString(),
        runId: ctx.runId,
        workflow: ctx.input.workflow,
        step: ctx.stepName,
        sessionId,
        agent: ctx.agent.name,
        costUsd: sessionCost,
        models: {},
        durationMs: Date.now() - ctx.startedAt,
        repo: ctx.input.repo,
      };
      this.costJournal.append(costEntry).catch(() => {});
    }

    this.emit({
      type: "cost:update",
      sessionId,
      sessionCost,
      todayTotal: this._costToday,
      budgetRemainingPct: this.computeBudgetRemainingPct(),
      timestamp: new Date().toISOString(),
    });

    const utilizationPct = (this._costToday / this.config.budget.dailyCapUsd) * 100;
    if (utilizationPct >= this.config.budget.alertThresholdPct) {
      this.emit({
        type: "budget:alert",
        todayTotal: this._costToday,
        capUsd: this.config.budget.dailyCapUsd,
        utilizationPct,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private emitSessionComplete(ctx: DispatchContext, stepResult: StepResult): void {
    this.emit({
      type: "session:complete",
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      status: "success",
      costUsd: stepResult.costUsd,
      durationMs: stepResult.durationMs,
      output: stepResult.output,
      metadata: ctx.input.metadata,
      timestamp: new Date().toISOString(),
    });
  }

  private emitSessionFail(ctx: DispatchContext, errorMsg: string): void {
    this.emit({
      type: "session:fail",
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      error: errorMsg,
      attempt: 1,
      maxRetries: this.config.recovery.maxRetries,
      willRetry: false,
      metadata: ctx.input.metadata,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Private: Input validation ─────────────────────────

  private validateInput(input: DispatchInput): void {
    if (!input.prompt || input.prompt.trim().length === 0) {
      throw new Error("Validation error: prompt must be a non-empty string");
    }
    if (textEncoder.encode(input.prompt).length > MAX_PROMPT_SIZE) {
      throw new Error(
        `Validation error: prompt exceeds maximum size of ${String(MAX_PROMPT_SIZE)} bytes`,
      );
    }

    if (!existsSync(input.repo)) {
      throw new Error(`Validation error: repo path does not exist: ${input.repo}`);
    }

    if (!this.workflows.has(input.workflow)) {
      throw new Error(`Validation error: workflow "${input.workflow}" not found in registry`);
    }

    if (input.metadata !== undefined) {
      if (!isPlainObject(input.metadata)) {
        throw new Error("Validation error: metadata must be a plain object");
      }
      if (objectDepth(input.metadata) > MAX_METADATA_DEPTH) {
        throw new Error(
          `Validation error: metadata exceeds maximum nesting depth of ${String(MAX_METADATA_DEPTH)}`,
        );
      }
    }

    const resumeOptions = [input.step, input.from, input.retry].filter(Boolean);
    if (resumeOptions.length > 1) {
      throw new Error("Validation error: step, from, and retry are mutually exclusive");
    }
  }

  // ─── Private: Helpers ──────────────────────────────────

  private evictExpiredIdempotencyEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.idempotencyCache) {
      if (entry.expiresAt <= now) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  private computeIdempotencyKey(input: DispatchInput): string | null {
    const idempotency = this.config.idempotency;
    if (!idempotency?.enabled) return null;

    const key = idempotency.key ?? "metadata";
    if (key === "prompt") {
      return `${input.workflow}:${input.repo}:${input.prompt}`;
    }
    return `${input.workflow}:${input.repo}:${JSON.stringify(input.metadata ?? {})}`;
  }

  private getFirstStep(
    workflow: WorkflowDefinition,
    input: DispatchInput,
  ): [string, WorkflowStepDef] {
    if (input.step) {
      const step = workflow.steps[input.step];
      if (!step || step.type === "gate") {
        throw new Error(
          `Step "${input.step}" not found in workflow "${workflow.name}" or is a gate step. Check the step name in the workflow definition.`,
        );
      }
      return [input.step, step as WorkflowStepDef];
    }

    for (const [name, step] of Object.entries(workflow.steps)) {
      if (step.type === "gate") continue;
      const stepDef = step as WorkflowStepDef;
      if (!stepDef.dependsOn || stepDef.dependsOn.length === 0) {
        return [name, stepDef];
      }
    }

    const entries = Object.entries(workflow.steps);
    const first = entries[0];
    if (!first) {
      throw new Error(`Workflow "${workflow.name}" has no steps`);
    }
    return [first[0], first[1] as WorkflowStepDef];
  }

  private resolveStepAgent(step: WorkflowStepDef, workflowName: string): ResolvedAgent {
    const agent = this.registeredAgents.get(step.agent);
    if (!agent) {
      throw new Error(
        `Agent "${step.agent}" required by workflow "${workflowName}" not found in registry. Register the agent or check the workflow definition.`,
      );
    }
    return agent;
  }

  private resolveRepo(repoPath: string): RepoConfig {
    const repo = this.repoIndex.get(path.resolve(repoPath));
    if (repo) return repo;
    return {
      path: repoPath,
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };
  }

  private buildMiddlewareContext(
    runId: string,
    workflow: string,
    step: string,
    agent: string,
    repo: string,
  ): MiddlewareContext {
    const store = new Map<string, unknown>();
    return {
      runId,
      workflow,
      step,
      agent,
      repo,
      get: ((key: string) => {
        if (key === "costToday") return this._costToday;
        if (key === "budgetCapUsd") return this.config.budget.dailyCapUsd;
        return store.get(key);
      }) as MiddlewareContext["get"],
      set: ((key: string, value: unknown) => {
        store.set(key, value);
      }) as MiddlewareContext["set"],
    };
  }

  private computeBudgetRemainingPct(): number {
    const cap = this.config.budget.dailyCapUsd;
    if (cap <= 0) return 0;
    return Math.max(0, ((cap - this._costToday) / cap) * 100);
  }

  // ─── Private: MCP server resolution ────────────────────

  private resolveMcpServers(
    stepDef: WorkflowStepDef,
    agent: ResolvedAgent,
  ): Record<string, McpServerConfig> | undefined {
    const configServers = this.config.mcpServers;
    if (!configServers) return undefined;

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
      const serverConfig = configServers[name];
      if (serverConfig) {
        resolved[name] = serverConfig;
      }
    }

    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  // ─── Private: Supervisor discovery ─────────────────────

  /** Discover running supervisor daemons and return webhook configs for their endpoints. */
  private async discoverSupervisorWebhooks(): Promise<NeoConfig["webhooks"]> {
    const { readdir } = await import("node:fs/promises");
    const supervisorsDir = getSupervisorsDir();
    if (!existsSync(supervisorsDir)) return [];

    const webhooks: NeoConfig["webhooks"] = [];

    try {
      const entries = await readdir(supervisorsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const statePath = path.join(supervisorsDir, entry.name, "state.json");
          const raw = await readFile(statePath, "utf-8");
          const state = JSON.parse(raw) as { status?: string; port?: number; pid?: number };

          if (state.status !== "running" || !state.port) continue;
          if (state.pid && !isProcessAlive(state.pid)) continue;

          webhooks.push({
            url: `http://localhost:${String(state.port)}/webhook`,
            events: ["session:complete", "session:fail", "budget:alert"],
            secret: this.config.supervisor.secret,
            timeoutMs: 5000,
          });
        } catch {
          // State file missing or corrupt — skip
        }
      }
    } catch {
      // Supervisors dir unreadable — skip
    }

    return webhooks;
  }

  // ─── Private: Run persistence ──────────────────────────

  private async persistRun(run: PersistedRun): Promise<void> {
    try {
      const slug = toRepoSlug({ path: run.repo });
      const runsDir = getRepoRunsDir(slug);
      if (!this.createdRunDirs.has(runsDir)) {
        await mkdir(runsDir, { recursive: true });
        this.createdRunDirs.add(runsDir);
      }
      const filePath = path.join(runsDir, `${run.runId}.json`);
      await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
    } catch {
      // Non-critical — don't fail the dispatch if persistence fails
    }
  }

  private async recoverOrphanedRuns(): Promise<void> {
    const runsDir = getRunsDir();
    if (!existsSync(runsDir)) return;

    try {
      const jsonFiles = await collectRunFiles(runsDir);
      for (const filePath of jsonFiles) {
        await this.recoverRunIfOrphaned(filePath);
      }
    } catch {
      // Non-critical
    }
  }

  private async recoverRunIfOrphaned(filePath: string): Promise<void> {
    const content = await readFile(filePath, "utf-8");
    const run = JSON.parse(content) as PersistedRun;

    if (run.status !== "running") return;
    // If the run has a PID and the process is still alive, skip it
    if (run.pid && isProcessAlive(run.pid)) return;

    run.status = "failed";
    run.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
  }
}

// ─── Utility functions ─────────────────────────────────

async function collectRunFiles(runsDir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(runsDir, { withFileTypes: true });
  const jsonFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDir = path.join(runsDir, entry.name);
      const subFiles = await readdir(subDir);
      for (const f of subFiles) {
        if (f.endsWith(".json")) jsonFiles.push(path.join(subDir, f));
      }
    } else if (entry.name.endsWith(".json")) {
      jsonFiles.push(path.join(runsDir, entry.name));
    }
  }

  return jsonFiles;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectDepth(obj: unknown, current = 0): number {
  if (!isPlainObject(obj)) return current;
  let max = current + 1;
  for (const value of Object.values(obj)) {
    const depth = objectDepth(value, current + 1);
    if (depth > max) max = depth;
  }
  return max;
}
