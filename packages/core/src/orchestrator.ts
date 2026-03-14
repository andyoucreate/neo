import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Semaphore } from "@/concurrency/semaphore";
import type { NeoConfig, RepoConfig } from "@/config";
import { CostJournal } from "@/cost/journal";
import { NeoEventEmitter } from "@/events";
import { EventJournal } from "@/events/journal";
import { getBranchName } from "@/isolation/git";
import { buildSandboxConfig } from "@/isolation/sandbox";
import { cleanupOrphanedWorktrees, createWorktree } from "@/isolation/worktree";
import { auditLog } from "@/middleware/audit-log";
import { budgetGuard } from "@/middleware/budget-guard";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import { loopDetection } from "@/middleware/loop-detection";
import { parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
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

// ─── Constants ─────────────────────────────────────────

const MAX_PROMPT_SIZE = 100 * 1024; // 100 KB
const MAX_METADATA_DEPTH = 5;
const SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const RUNS_DIR = ".neo/runs";
const WORKTREES_DIR = ".neo/worktrees";
const DEFAULT_JOURNAL_DIR = ".neo/journals";
const textEncoder = new TextEncoder();

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
  private _paused = false;
  private _costToday = 0;
  private _startedAt = 0;
  private _drainResolve: (() => void) | null = null;

  constructor(config: NeoConfig, options: OrchestratorOptions = {}) {
    super();
    this.config = config;
    this.userMiddleware = options.middleware ?? [];
    this.journalDir = options.journalDir ?? DEFAULT_JOURNAL_DIR;
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

    for (const repo of this.config.repos) {
      const worktreeBase = path.join(repo.path, WORKTREES_DIR);
      await cleanupOrphanedWorktrees(worktreeBase).catch(() => {});
    }
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
    let worktreePath: string | undefined;

    try {
      // Create worktree if writable agent
      if (agent.sandbox === "writable") {
        const branchName = getBranchName(repoConfig, runId);
        const worktreeDir = path.join(input.repo, WORKTREES_DIR, runId);
        const info = await createWorktree({
          repoPath: input.repo,
          branch: branchName,
          baseBranch: repoConfig.defaultBranch,
          worktreeDir,
        });
        worktreePath = info.path;
        activeSession.worktreePath = worktreePath;
      }

      const stepResult = await this.runAgentSession(ctx, worktreePath);
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
      this.semaphore.release(sessionId);
      this._activeSessions.delete(sessionId);
      this.abortControllers.delete(sessionId);

      if (this._activeSessions.size === 0 && this._drainResolve) {
        this._drainResolve();
        this._drainResolve = null;
      }
    }
  }

  private async runAgentSession(
    ctx: DispatchContext,
    worktreePath: string | undefined,
  ): Promise<StepResult> {
    const { input, runId, sessionId, stepName, stepDef, agent, activeSession } = ctx;

    const sandboxConfig = buildSandboxConfig(agent, worktreePath);
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

    const recoveryOpts = stepDef.recovery;
    const sessionResult = await runWithRecovery({
      agent,
      prompt: stepDef.prompt ?? input.prompt,
      sandboxConfig,
      hooks,
      initTimeoutMs: this.config.sessions.initTimeoutMs,
      maxDurationMs: this.config.sessions.maxDurationMs,
      maxRetries: recoveryOpts?.maxRetries ?? this.config.recovery.maxRetries,
      backoffBaseMs: this.config.recovery.backoffBaseMs,
      ...(worktreePath ? { worktreePath } : {}),
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

    return {
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
  }

  private async finalizeDispatch(
    ctx: DispatchContext,
    stepResult: StepResult,
    idempotencyKey: string | null,
  ): Promise<TaskResult> {
    const { input, runId, stepName, repoConfig, activeSession } = ctx;

    const taskResult: TaskResult = {
      runId,
      workflow: input.workflow,
      repo: input.repo,
      status: stepResult.status === "success" ? "success" : "failure",
      steps: { [stepName]: stepResult },
      branch:
        stepResult.status === "success" && activeSession.worktreePath
          ? getBranchName(repoConfig, runId)
          : undefined,
      costUsd: stepResult.costUsd,
      durationMs: Date.now() - ctx.startedAt,
      timestamp: new Date().toISOString(),
      metadata: input.metadata,
    };

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
      autoCreatePr: false,
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

  // ─── Private: Run persistence ──────────────────────────

  private async persistRun(run: PersistedRun): Promise<void> {
    try {
      const runsDir = path.join(run.repo, RUNS_DIR);
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
    for (const repo of this.config.repos) {
      const runsDir = path.join(repo.path, RUNS_DIR);
      if (!existsSync(runsDir)) continue;

      try {
        const files = await readdir(runsDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;

          const filePath = path.join(runsDir, file);
          const content = await readFile(filePath, "utf-8");
          const run = JSON.parse(content) as PersistedRun;

          if (run.status === "running") {
            run.status = "failed";
            run.updatedAt = new Date().toISOString();
            await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
          }
        }
      } catch {
        // Non-critical — continue with other repos
      }
    }
  }
}

// ─── Utility functions ─────────────────────────────────

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
