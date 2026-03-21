import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Semaphore } from "@/concurrency/semaphore";
import type { McpServerConfig, NeoConfig, RepoConfig } from "@/config";
import { CostJournal } from "@/cost/journal";
import { NeoEventEmitter } from "@/events";
import { EventJournal } from "@/events/journal";
import { WebhookDispatcher } from "@/events/webhook";
import { createSessionClone, removeSessionClone } from "@/isolation/clone";
import { pushSessionBranch } from "@/isolation/git";
import { auditLog } from "@/middleware/audit-log";
import { budgetGuard } from "@/middleware/budget-guard";
import { loopDetection } from "@/middleware/loop-detection";
import { RunStore } from "@/orchestrator/run-store";
import { getJournalsDir, getSupervisorsDir } from "@/paths";
import { SessionExecutor } from "@/runner/session-executor";
import { isProcessAlive } from "@/shared/process";
import { formatMemoriesForPrompt, MemoryStore } from "@/supervisor/memory/index.js";
import type {
  ActiveSession,
  CostEntry,
  DispatchInput,
  Middleware,
  NeoEvent,
  OrchestratorStatus,
  PersistedRun,
  ResolvedAgent,
  StepResult,
  TaskResult,
} from "@/types";

// ─── Constants ─────────────────────────────────────────

const MAX_PROMPT_SIZE = 100 * 1024; // 100 KB
const MAX_METADATA_DEPTH = 5;
const SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const textEncoder = new TextEncoder();

// ─── Options ───────────────────────────────────────────

export interface OrchestratorOptions {
  middleware?: Middleware[] | undefined;
  journalDir?: string | undefined;
  /** Skip orphan recovery on start — workers should set this to true to avoid false orphan detection on concurrent launches. */
  skipOrphanRecovery?: boolean | undefined;
}

// ─── Internal dispatch context ─────────────────────────

interface DispatchContext {
  input: DispatchInput;
  runId: string;
  sessionId: string;
  startedAt: number;
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
  private readonly registeredAgents = new Map<string, ResolvedAgent>();
  private readonly _activeSessions = new Map<string, ActiveSession>();
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly repoIndex = new Map<string, RepoConfig>();
  private readonly runStore = new RunStore();
  private readonly journalDir: string;
  private costJournal: CostJournal | null = null;
  private eventJournal: EventJournal | null = null;
  private webhookDispatcher: WebhookDispatcher | null = null;
  private memoryStore: MemoryStore | null = null;
  private _paused = false;
  private _costToday = 0;
  private _startedAt = 0;
  private _drainResolve: (() => void) | null = null;

  private readonly skipOrphanRecovery: boolean;

  constructor(config: NeoConfig, options: OrchestratorOptions = {}) {
    super();
    this.config = config;
    this.userMiddleware = options.middleware ?? [];
    this.journalDir = options.journalDir ?? getJournalsDir();
    this.skipOrphanRecovery = options.skipOrphanRecovery ?? false;
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

    // Log supervisor webhook discovery for debugging connectivity
    if (supervisorWebhooks.length > 0) {
      // biome-ignore lint/suspicious/noConsole: Intentional logging for webhook discovery
      console.log(
        `[neo] Discovered ${supervisorWebhooks.length} supervisor webhook(s): ${supervisorWebhooks.map((w) => w.url).join(", ")}`,
      );
    }

    // Restore today's cost from journal
    this._costToday = await this.costJournal.getDayTotal();

    if (!this.skipOrphanRecovery) {
      await this.recoverOrphanedRuns();
    }

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

    // Flush pending webhook deliveries — ensures terminal events
    // (session:complete/fail) reach the supervisor before process exits
    if (this.webhookDispatcher) {
      await this.webhookDispatcher.flush();
    }
  }

  // ─── Emit override (journal events) ───────────────────

  override emit(event: NeoEvent): void {
    super.emit(event);
    // Fire-and-forget event journal append
    if (this.eventJournal) {
      this.eventJournal.append(event).catch((err) => {
        // biome-ignore lint/suspicious/noConsole: Log journal write failures for debugging
        console.debug("[neo] Event journal append failed:", err);
      });
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
    const agent = this.registeredAgents.get(input.agent);
    if (!agent) {
      const available = [...this.registeredAgents.keys()].join(", ") || "none";
      throw new Error(
        `Agent "${input.agent}" not found. Available agents: ${available}. Register the agent first.`,
      );
    }
    const repoConfig = this.resolveRepo(input.repo);

    const activeSession: ActiveSession = {
      sessionId,
      runId,
      step: "execute",
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
      agent: agent.name,
      repo: input.repo,
      prompt: input.prompt,
      pid: process.pid,
      status: "running",
      steps: {},
      createdAt: activeSession.startedAt,
      updatedAt: new Date().toISOString(),
      metadata: input.metadata,
    });

    try {
      // Create isolated clone for ALL agents.
      // Uses the explicit branch if provided, otherwise falls back to the base branch.
      const branchName = (input.branch as string) || repoConfig.defaultBranch;
      const sessionDir = path.join(this.config.sessions.dir, runId);
      const info = await createSessionClone({
        repoPath: input.repo,
        branch: branchName,
        baseBranch: repoConfig.defaultBranch,
        sessionDir,
      });
      sessionPath = info.path;
      activeSession.sessionPath = sessionPath;

      const stepResult = await this.runAgentSession(ctx, sessionPath);
      this.emitCostEvents(sessionId, stepResult.costUsd, ctx);
      this.emitSessionComplete(ctx, stepResult);
      return stepResult;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitSessionFail(ctx, errorMsg);

      const failResult: StepResult = {
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

      // Write episode to memory store
      try {
        const store = this.getMemoryStore();
        await store.write({
          type: "episode",
          scope: input.repo,
          content: `Run ${runId.slice(0, 8)} (${agent.name}): failed${failResult.error ? ` — ${failResult.error.slice(0, 150)}` : ""}`,
          source: agent.name,
          outcome: "failure",
          runId,
        });
      } catch {
        // Best-effort — don't fail the run if memory write fails
      }

      return failResult;
    } finally {
      // Auto-commit, push, and cleanup session clone
      if (sessionPath) {
        await this.finalizeSession(sessionPath, ctx);
      }

      // Cleanup middleware state for this session to prevent memory leaks
      for (const mw of this.userMiddleware) {
        if ("cleanup" in mw && typeof mw.cleanup === "function") {
          (mw as { cleanup: (id: string) => void }).cleanup(sessionId);
        }
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
   * Push the branch (writable only), then remove the session clone.
   * Runs in `finally` so it executes on both success and failure.
   */
  private async finalizeSession(sessionPath: string, ctx: DispatchContext): Promise<void> {
    // Only push for writable agents — readonly agents have no changes to push
    if (ctx.agent.sandbox === "writable") {
      const branch = ctx.input.branch as string;
      const remote = ctx.repoConfig.pushRemote ?? "origin";
      try {
        await pushSessionBranch(sessionPath, branch, remote).catch((err) => {
          // biome-ignore lint/suspicious/noConsole: Debug logging for push failures
          console.debug("[neo] Push failed:", err);
        });
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: Debug logging for finalization errors
        console.debug("[neo] Finalization error:", err);
      }
    }

    try {
      await removeSessionClone(sessionPath);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: Debug logging for session cleanup errors
      console.debug("[neo] Session cleanup failed:", err);
    }
  }

  private async runAgentSession(
    ctx: DispatchContext,
    sessionPath: string | undefined,
  ): Promise<StepResult> {
    const { input, runId, sessionId, agent, repoConfig, activeSession } = ctx;

    this.emit({
      type: "session:start",
      sessionId,
      runId,
      step: "execute",
      agent: agent.name,
      repo: input.repo,
      metadata: input.metadata,
      timestamp: new Date().toISOString(),
    });

    // Create SessionExecutor with config and context value getter
    const executor = new SessionExecutor(
      {
        initTimeoutMs: this.config.sessions.initTimeoutMs,
        maxDurationMs: this.config.sessions.maxDurationMs,
        maxRetries: this.config.recovery.maxRetries,
        backoffBaseMs: this.config.recovery.backoffBaseMs,
      },
      (key: string) => {
        if (key === "costToday") return this._costToday;
        if (key === "budgetCapUsd") return this.config.budget.dailyCapUsd;
        return undefined;
      },
    );

    // Build execution input
    const strategy = input.gitStrategy ?? repoConfig.gitStrategy ?? "branch";
    const mcpServers = this.resolveMcpServers(agent);
    const memoryContext = this.loadMemoryContext(input.repo);

    const result = await executor.execute(
      {
        runId,
        sessionId,
        agent,
        repoConfig,
        repoPath: input.repo,
        prompt: input.prompt,
        branch: input.branch,
        gitStrategy: strategy,
        sessionPath,
        metadata: input.metadata,
        startedAt: activeSession.startedAt,
      },
      {
        middleware: this.userMiddleware,
        mcpServers,
        memoryContext,
        onAttempt: (attempt, strategy) => {
          if (attempt > 1) {
            this.emit({
              type: "session:fail",
              sessionId,
              runId,
              error: `Retrying with strategy: ${strategy}`,
              attempt: attempt - 1,
              maxRetries: this.config.recovery.maxRetries,
              willRetry: true,
              metadata: input.metadata,
              timestamp: new Date().toISOString(),
            });
          }
        },
      },
    );

    // Write episode to memory store
    try {
      const store = this.getMemoryStore();
      const isSuccess = result.status === "success";
      await store.write({
        type: "episode",
        scope: input.repo,
        content: `Run ${runId.slice(0, 8)} (${agent.name}): ${isSuccess ? "completed" : "failed"}${result.error ? ` — ${result.error.slice(0, 150)}` : ""}`,
        source: agent.name,
        outcome: isSuccess ? "success" : "failure",
        runId,
      });
    } catch {
      // Best-effort — don't fail the run if memory write fails
    }

    return result;
  }

  private async finalizeDispatch(
    ctx: DispatchContext,
    stepResult: StepResult,
    idempotencyKey: string | null,
  ): Promise<TaskResult> {
    const { input, runId, agent, activeSession } = ctx;

    const taskResult: TaskResult = {
      runId,
      agent: agent.name,
      repo: input.repo,
      status: stepResult.status === "success" ? "success" : "failure",
      steps: { execute: stepResult },
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
      agent: agent.name,
      repo: input.repo,
      prompt: input.prompt,
      pid: process.pid,
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

  // ─── Private: Memory injection ──────────────────────────

  private getMemoryStore(): MemoryStore {
    if (!this.memoryStore) {
      const supervisorDir = path.join(getSupervisorsDir(), "supervisor");
      this.memoryStore = new MemoryStore(path.join(supervisorDir, "memory.sqlite"));
    }
    return this.memoryStore;
  }

  private loadMemoryContext(repoPath: string): string | undefined {
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

  // ─── Private: Event helpers ────────────────────────────

  private emitCostEvents(sessionId: string, sessionCost: number, ctx: DispatchContext): void {
    this._costToday += sessionCost;

    // Persist cost entry to journal (fire-and-forget)
    if (this.costJournal) {
      const costEntry: CostEntry = {
        timestamp: new Date().toISOString(),
        runId: ctx.runId,
        step: "execute",
        sessionId,
        agent: ctx.agent.name,
        costUsd: sessionCost,
        models: {},
        durationMs: Date.now() - ctx.startedAt,
        repo: ctx.input.repo,
      };
      this.costJournal.append(costEntry).catch((err) => {
        // biome-ignore lint/suspicious/noConsole: Log journal write failures for debugging
        console.debug("[neo] Cost journal append failed:", err);
      });
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

    if (!this.registeredAgents.has(input.agent)) {
      throw new Error(`Validation error: agent "${input.agent}" not found in registry`);
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
      return `${input.agent}:${input.repo}:${input.prompt}`;
    }
    return `${input.agent}:${input.repo}:${JSON.stringify(input.metadata ?? {})}`;
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

  private computeBudgetRemainingPct(): number {
    const cap = this.config.budget.dailyCapUsd;
    if (cap <= 0) return 0;
    return Math.max(0, ((cap - this._costToday) / cap) * 100);
  }

  // ─── Private: MCP server resolution ────────────────────

  private resolveMcpServers(agent: ResolvedAgent): Record<string, McpServerConfig> | undefined {
    const configServers = this.config.mcpServers;
    if (!configServers) return undefined;

    // Collect unique server names from agent definition
    const names = agent.definition.mcpServers;
    if (!names || names.length === 0) return undefined;

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
    await this.runStore.persistRun(run);
  }

  private async recoverOrphanedRuns(): Promise<void> {
    const orphanedRuns = await this.runStore.recoverOrphanedRuns();

    // Emit session:fail for each orphaned run so the supervisor learns about them
    for (const run of orphanedRuns) {
      this.emit({
        type: "session:fail",
        sessionId: run.runId,
        runId: run.runId,
        error: "Orphaned run: process died without completing",
        attempt: 1,
        maxRetries: this.config.recovery.maxRetries,
        willRetry: false,
        metadata: run.metadata,
        timestamp: new Date().toISOString(),
      });
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
