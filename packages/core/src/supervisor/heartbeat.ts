import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigStore, ConfigWatcher, type GlobalConfig } from "@/config";
import { getDataDir } from "@/paths";
import { isInitMessage, isResultMessage, type SDKStreamMessage } from "@/sdk-types";
import type { ActivityLog } from "./activity-log.js";
import { type Decision, DecisionStore } from "./decisions.js";
import type { EventQueue, GroupedEvents } from "./event-queue.js";
import { processDecisions } from "./heartbeat-decisions.js";
import {
  emitHeartbeatCompleted,
  emitRunCompletedEvent,
  emitRunDispatchedEvent,
  emitSupervisorStarted,
  emitSupervisorStopped,
  logStreamMessage,
  type WebhookEventEmitter,
} from "./heartbeat-logging.js";
import { determineHeartbeatMode } from "./heartbeat-mode.js";
import {
  buildStateUpdate,
  getActiveRuns,
  readPersistedRun,
  readState,
  updateState,
} from "./heartbeat-state.js";
import { type IdleContext, IdleDetector } from "./idle-detector.js";
import { compactLogBuffer, markConsolidated } from "./log-buffer.js";
import type { MemoryEntry } from "./memory/entry.js";
import { MemoryStore } from "./memory/store.js";
import {
  buildCompactionPrompt,
  buildConsolidationPrompt,
  buildIdlePrompt,
  buildStandardPrompt,
  isIdleHeartbeat,
} from "./prompt-builder.js";
import type {
  ActivityEntry,
  LogBufferEntry,
  QueuedEvent,
  SupervisorDaemonState,
} from "./schemas.js";

export type { WebhookEventEmitter } from "./heartbeat-logging.js";
// Re-export for backward compatibility
export { shouldCompact, shouldConsolidate } from "./heartbeat-mode.js";
export { isRunActive, STALE_GRACE_PERIOD_MS } from "./heartbeat-state.js";

// ─── Helper types for runHeartbeat refactoring ───────────

interface BudgetCheckResult {
  todayCost: number;
  exceeded: boolean;
}

interface EventContext {
  grouped: GroupedEvents;
  rawEvents: QueuedEvent[];
  totalEventCount: number;
  activeRuns: string[];
  memories: MemoryEntry[];
  recentActions: ActivityEntry[];
  mcpServerNames: string[];
}

interface PostSdkProcessingInput {
  rawEvents: QueuedEvent[];
  isConsolidation: boolean;
  unconsolidatedIds: string[];
}

interface CompletionEventsInput {
  heartbeatCount: number;
  activeRuns: string[];
  todayCost: number;
  costUsd: number;
  rawEvents: QueuedEvent[];
}

interface SkipLogicInput {
  state: SupervisorDaemonState | null;
  totalEventCount: number;
  activeRuns: string[];
  hasPendingConsolidation: boolean;
  hasExpiredDecisions: boolean;
}

interface SkipLogicResult {
  shouldSkip: boolean;
  resetCounters: boolean;
}

// ─── HeartbeatLoop ───────────────────────────────────────

export interface HeartbeatLoopOptions {
  config: GlobalConfig;
  supervisorDir: string;
  statePath: string;
  sessionId: string;
  eventQueue: EventQueue;
  activityLog: ActivityLog;
  /** Path to the inbox/events directory for markProcessed() calls */
  eventsPath: string;
  /** Path to bundled default SUPERVISOR.md (e.g. from @neotx/agents) */
  defaultInstructionsPath?: string | undefined;
  memoryDbPath?: string | undefined;
  /** Optional callback to emit webhook events at lifecycle points */
  onWebhookEvent?: WebhookEventEmitter | undefined;
  /** Repository path for config watching (enables hot-reload) */
  repoPath?: string | undefined;
  /** Debounce time in ms for config file changes (default: 500) */
  configWatcherDebounceMs?: number | undefined;
}

/**
 * The core autonomous loop. At each iteration:
 * 1. Drain events from the queue
 * 2. Read log buffer entries
 * 3. Determine standard vs consolidation mode
 * 4. Build the appropriate prompt
 * 5. Call sdk.query() for Claude to reason and act
 * 6. Mark entries consolidated and compact log buffer (consolidation only)
 * 7. Log activity
 * 8. Wait for the next event or idle timeout
 */
export class HeartbeatLoop {
  private stopping = false;
  private consecutiveFailures = 0;
  private activeAbort: AbortController | null = null;
  private config: GlobalConfig;
  private readonly supervisorDir: string;
  private readonly statePath: string;
  private sessionId: string;
  private readonly eventQueue: EventQueue;
  private readonly activityLog: ActivityLog;
  private readonly _eventsPath: string;

  private customInstructions: string | undefined;
  private readonly defaultInstructionsPath: string | undefined;
  private memoryStore: MemoryStore | null = null;
  private readonly memoryDbPath: string | undefined;
  private readonly onWebhookEvent: WebhookEventEmitter | undefined;
  private decisionStore: DecisionStore | null = null;

  /** ConfigWatcher for hot-reload support */
  private configWatcher: ConfigWatcher | null = null;
  private configStore: ConfigStore | null = null;
  private readonly repoPath: string | undefined;
  private readonly configWatcherDebounceMs: number | undefined;

  constructor(options: HeartbeatLoopOptions) {
    this.config = options.config;
    this.supervisorDir = options.supervisorDir;
    this.statePath = options.statePath;
    this.sessionId = options.sessionId;
    this.eventQueue = options.eventQueue;
    this.activityLog = options.activityLog;
    this._eventsPath = options.eventsPath;
    this.defaultInstructionsPath = options.defaultInstructionsPath;
    this.memoryDbPath = options.memoryDbPath;
    this.onWebhookEvent = options.onWebhookEvent;
    this.repoPath = options.repoPath;
    this.configWatcherDebounceMs = options.configWatcherDebounceMs;
  }

  /** Path to the inbox/events directory for markProcessed() calls */
  get eventsPath(): string {
    return this._eventsPath;
  }

  private getMemoryStore(): MemoryStore | null {
    if (!this.memoryStore && this.memoryDbPath) {
      try {
        this.memoryStore = new MemoryStore(this.memoryDbPath);
      } catch {
        // Memory store unavailable — continue without it
      }
    }
    return this.memoryStore;
  }

  private getDecisionStore(): DecisionStore {
    if (!this.decisionStore) {
      this.decisionStore = new DecisionStore(path.join(this.supervisorDir, "decisions.jsonl"));
    }
    return this.decisionStore;
  }

  async start(): Promise<void> {
    this.customInstructions = await this.loadInstructions();

    // Initialize and start config watcher for hot-reload
    await this.initConfigWatcher();

    await this.activityLog.log("heartbeat", "Supervisor heartbeat loop started");
    await emitSupervisorStarted(this.sessionId, this.onWebhookEvent, this.activityLog);

    while (!this.stopping) {
      try {
        await this.runHeartbeat();
        this.consecutiveFailures = 0;
      } catch (error) {
        this.consecutiveFailures++;
        const msg = error instanceof Error ? error.message : String(error);
        await this.activityLog.log("error", `Heartbeat failed: ${msg}`, { error: msg });

        // Circuit breaker: exponential backoff after consecutive failures
        if (this.consecutiveFailures >= this.config.supervisor.maxConsecutiveFailures) {
          const backoffMs = Math.min(
            this.config.supervisor.eventTimeoutMs *
              2 ** (this.consecutiveFailures - this.config.supervisor.maxConsecutiveFailures),
            15 * 60 * 1000, // max 15 minutes
          );
          await this.activityLog.log(
            "error",
            `Circuit breaker: backing off ${Math.round(backoffMs / 1000)}s after ${this.consecutiveFailures} failures`,
          );
          await this.sleep(backoffMs);
          continue;
        }
      }

      if (this.stopping) break;

      // Wait for next event or idle timeout
      await this.eventQueue.waitForEvent(this.config.supervisor.eventTimeoutMs);
    }

    await emitSupervisorStopped(this.sessionId, "shutdown", this.onWebhookEvent, this.activityLog);
    await this.activityLog.log("heartbeat", "Supervisor heartbeat loop stopped");
  }

  stop(): void {
    this.stopping = true;
    this.activeAbort?.abort(new Error("Supervisor shutting down"));
    this.eventQueue.interrupt();

    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.stop();
      this.configWatcher = null;
    }
  }

  /**
   * Initialize and start the ConfigWatcher for hot-reload support.
   * Subscribes to config file changes and logs reload events.
   */
  private async initConfigWatcher(): Promise<void> {
    // Create a ConfigStore for the watcher
    this.configStore = new ConfigStore(this.repoPath);
    await this.configStore.load();

    // Build options only with defined values to satisfy exactOptionalPropertyTypes
    const watcherOptions =
      this.configWatcherDebounceMs !== undefined
        ? { debounceMs: this.configWatcherDebounceMs }
        : undefined;

    this.configWatcher = new ConfigWatcher(this.configStore, watcherOptions);

    // Subscribe to config changes
    this.configWatcher.on("change", () => {
      this.handleConfigChange();
    });

    this.configWatcher.start();
    await this.activityLog.log("event", "ConfigWatcher started for hot-reload");
  }

  /**
   * Handle config file changes. Propagates reloaded config to the running
   * loop and triggers an immediate heartbeat.
   */
  private handleConfigChange(): void {
    // Propagate reloaded config to the running loop
    if (this.configStore) {
      this.config = this.configStore.getAll();
    }

    // Log the config change
    this.activityLog.log("event", "Configuration reloaded (hot-reload)").catch((err) => {
      // biome-ignore lint/suspicious/noConsole: Debug logging for config reload errors
      console.debug("[neo] Config reload log failed:", err);
    });

    // Interrupt the event queue wait to trigger an immediate heartbeat
    // This ensures the supervisor reacts quickly to config changes
    this.eventQueue.interrupt();
  }

  private async runHeartbeat(): Promise<void> {
    const startTime = Date.now();
    const heartbeatId = randomUUID();
    const state = await readState(this.statePath);
    const today = new Date().toISOString().slice(0, 10);

    // Check budget and return early if exceeded
    const budgetCheck = await this.checkBudgetExceeded(state, today);
    if (budgetCheck.exceeded) return;

    // Gather event context
    const eventCtx = await this.gatherEventContext();

    // Process decision answers and expiry
    const { pendingDecisions, answeredDecisions, hasExpiredDecisions } = await processDecisions(
      eventCtx.rawEvents,
      state?.lastHeartbeat,
      this.getDecisionStore(),
      this.activityLog,
      this.config.supervisor.autoDecide,
    );

    // Determine heartbeat mode
    const modeResult = await determineHeartbeatMode(this.supervisorDir, state);

    // Check for pending consolidation entries
    const hasPendingConsolidation = modeResult.unconsolidated.length > 0;

    // Handle skip logic for idle/active-work scenarios
    const skipResult = await this.handleSkipLogic({
      state,
      totalEventCount: eventCtx.totalEventCount,
      activeRuns: eventCtx.activeRuns,
      hasPendingConsolidation,
      hasExpiredDecisions,
    });
    if (skipResult.shouldSkip) return;
    if (skipResult.resetCounters) {
      await updateState(this.statePath, { idleSkipCount: 0, activeWorkSkipCount: 0 });
    }

    // Build prompt and log start
    const { prompt, modeLabel } = await this.buildHeartbeatModePrompt({
      grouped: eventCtx.grouped,
      todayCost: budgetCheck.todayCost,
      heartbeatCount: modeResult.heartbeatCount,
      unconsolidated: modeResult.unconsolidated,
      isCompaction: modeResult.isCompaction,
      isConsolidation: modeResult.isConsolidation,
      activeRuns: eventCtx.activeRuns,
      pendingDecisions,
      answeredDecisions,
      lastHeartbeat: state?.lastHeartbeat,
      lastConsolidationTimestamp: modeResult.lastConsolidationTs,
      memories: eventCtx.memories,
      recentActions: eventCtx.recentActions,
      mcpServerNames: eventCtx.mcpServerNames,
    });
    await this.activityLog.log(
      "heartbeat",
      `Heartbeat #${modeResult.heartbeatCount} starting (${modeLabel})`,
      {
        heartbeatId,
        eventCount: eventCtx.totalEventCount,
        messages: eventCtx.grouped.messages.length,
        webhooks: eventCtx.grouped.webhooks.length,
        runCompletions: eventCtx.grouped.runCompletions.length,
        isConsolidation: modeResult.isConsolidation,
      },
    );

    // Call SDK with timeout + shutdown abort
    const { costUsd, turnCount } = await this.callSdk(prompt, heartbeatId);

    // Warn if SDK stream completed without any turns — indicates silent timeout
    if (turnCount === 0) {
      await this.activityLog.log(
        "warning",
        `Heartbeat #${modeResult.heartbeatCount} completed with turnCount=0. SDK stream may have timed out before any turns completed.`,
        { heartbeatId },
      );
    }

    // Handle post-SDK processing
    const unconsolidatedIds = modeResult.unconsolidated.map((e) => e.id);
    await this.handlePostSdkProcessing({
      rawEvents: eventCtx.rawEvents,
      isConsolidation: modeResult.isConsolidation,
      unconsolidatedIds,
    });

    // Build and apply state update
    const durationMs = Date.now() - startTime;
    const { stateUpdate } = buildStateUpdate({
      state,
      sessionId: this.sessionId,
      today,
      todayCost: budgetCheck.todayCost,
      costUsd,
      heartbeatCount: modeResult.heartbeatCount,
      isConsolidation: modeResult.isConsolidation,
      isCompaction: modeResult.isCompaction,
    });
    await updateState(this.statePath, stateUpdate);

    await this.activityLog.log(
      "heartbeat",
      `Heartbeat #${modeResult.heartbeatCount + 1} complete (${modeLabel})`,
      {
        heartbeatId,
        costUsd,
        durationMs,
        turnCount,
        isConsolidation: modeResult.isConsolidation,
      },
    );

    // Emit completion webhook events
    await this.emitCompletionEvents({
      heartbeatCount: modeResult.heartbeatCount,
      activeRuns: eventCtx.activeRuns,
      todayCost: budgetCheck.todayCost,
      costUsd,
      rawEvents: eventCtx.rawEvents,
    });
  }

  /**
   * Check if supervisor daily budget is exceeded.
   */
  private async checkBudgetExceeded(
    state: SupervisorDaemonState | null,
    today: string,
  ): Promise<BudgetCheckResult> {
    const todayCost = state?.costResetDate === today ? (state.todayCostUsd ?? 0) : 0;

    if (todayCost >= this.config.supervisor.dailyCapUsd) {
      await this.activityLog.log(
        "error",
        `Supervisor daily budget exceeded ($${todayCost.toFixed(2)} / $${this.config.supervisor.dailyCapUsd}). Skipping heartbeat.`,
      );
      await this.sleep(this.config.supervisor.eventTimeoutMs);
      return { todayCost, exceeded: true };
    }

    return { todayCost, exceeded: false };
  }

  /**
   * Gather event context: drain queue, fetch active runs, memories, and recent actions.
   */
  private async gatherEventContext(): Promise<EventContext> {
    const { grouped, rawEvents } = this.eventQueue.drainAndGroup();
    const totalEventCount =
      grouped.messages.length + grouped.webhooks.length + grouped.runCompletions.length;
    const activeRuns = await getActiveRuns();

    const mcpServerNames = this.config.mcpServers ? Object.keys(this.config.mcpServers) : [];
    const store = this.getMemoryStore();
    const memories: MemoryEntry[] = store ? store.query({ limit: 40, sortBy: "relevance" }) : [];
    const recentActions = await this.activityLog.tail(20);

    return {
      grouped,
      rawEvents,
      totalEventCount,
      activeRuns,
      memories,
      recentActions,
      mcpServerNames,
    };
  }

  /**
   * Handle post-SDK processing: mark events as processed, consolidate log buffer.
   */
  private async handlePostSdkProcessing(input: PostSdkProcessingInput): Promise<void> {
    // Mark events as processed so they are not replayed on restart
    if (input.rawEvents.length > 0) {
      const inboxPath = path.join(this.supervisorDir, "inbox.jsonl");
      await this.eventQueue.markProcessed(inboxPath, this.eventsPath, input.rawEvents);
    }

    // Post-response: mark entries consolidated and compact log buffer
    if (input.isConsolidation) {
      if (input.unconsolidatedIds.length > 0) {
        await markConsolidated(this.supervisorDir, input.unconsolidatedIds);
      }
      await compactLogBuffer(this.supervisorDir);
    }
  }

  /**
   * Emit completion webhook events: heartbeat completed and run completed events.
   */
  private async emitCompletionEvents(input: CompletionEventsInput): Promise<void> {
    // Emit heartbeat completed webhook event
    await emitHeartbeatCompleted(
      this.sessionId,
      {
        heartbeatNumber: input.heartbeatCount + 1,
        runsActive: input.activeRuns.length,
        todayUsd: input.todayCost + input.costUsd,
        limitUsd: this.config.supervisor.dailyCapUsd,
      },
      this.onWebhookEvent,
      this.activityLog,
    );

    // Emit run completed events for any run completions processed
    for (const event of input.rawEvents) {
      if (event.kind === "run_complete") {
        const runData = await readPersistedRun(event.runId);
        const emitOpts: {
          runId: string;
          status: "completed" | "failed" | "cancelled";
          output?: string;
          costUsd: number;
          durationMs: number;
        } = {
          runId: event.runId,
          status: (runData?.status === "failed" ? "failed" : "completed") as
            | "completed"
            | "failed"
            | "cancelled",
          costUsd: runData?.totalCostUsd ?? 0,
          durationMs: runData?.durationMs ?? 0,
        };
        if (runData?.output) {
          emitOpts.output = runData.output;
        }
        await emitRunCompletedEvent(
          this.sessionId,
          emitOpts,
          this.onWebhookEvent,
          this.activityLog,
        );
      }
    }
  }

  /**
   * Handle skip logic for idle and active-work scenarios.
   * Uses IdleDetector to make skip decisions based on context.
   */
  private async handleSkipLogic(opts: SkipLogicInput): Promise<SkipLogicResult> {
    const { state, totalEventCount, activeRuns, hasPendingConsolidation, hasExpiredDecisions } =
      opts;
    const idleSkipCount = state?.idleSkipCount ?? 0;
    const activeWorkSkipCount = state?.activeWorkSkipCount ?? 0;
    const hasActiveWork = activeRuns.length > 0;

    // Calculate time since last heartbeat
    const lastHeartbeatMs = state?.lastHeartbeat
      ? new Date(state.lastHeartbeat).getTime()
      : Date.now();
    const timeSinceLastHeartbeatMs = Date.now() - lastHeartbeatMs;

    // Build context for IdleDetector
    const context: IdleContext = {
      eventCount: totalEventCount,
      activeRuns: activeRuns.length,
      hasPendingConsolidation,
      hasExpiredDecisions,
      timeSinceLastHeartbeatMs,
      idleSkipCount,
      activeWorkSkipCount,
    };

    // Create detector with current config values
    const detector = new IdleDetector({
      idleSkipMax: this.config.supervisor.idleSkipMax,
      activeWorkSkipMax: this.config.supervisor.activeWorkSkipMax,
    });

    const result = detector.shouldSkip(context);

    if (result.shouldSkip) {
      // Update skip counters based on whether there's active work
      if (hasActiveWork) {
        await updateState(this.statePath, {
          activeWorkSkipCount: activeWorkSkipCount + 1,
          idleSkipCount: 0,
        });
        await this.activityLog.log(
          "heartbeat",
          `Active-work skip #${activeWorkSkipCount + 1}/${this.config.supervisor.activeWorkSkipMax} — ${result.reason}`,
        );
      } else {
        await updateState(this.statePath, {
          idleSkipCount: idleSkipCount + 1,
          activeWorkSkipCount: 0,
        });
        await this.activityLog.log(
          "heartbeat",
          `Idle skip #${idleSkipCount + 1}/${this.config.supervisor.idleSkipMax} — ${result.reason}`,
        );
      }
      return { shouldSkip: true, resetCounters: false };
    }

    const needsReset = idleSkipCount > 0 || activeWorkSkipCount > 0;
    return { shouldSkip: false, resetCounters: needsReset };
  }

  /**
   * Build the prompt for the current heartbeat mode.
   */
  private async buildHeartbeatModePrompt(opts: {
    grouped: GroupedEvents;
    todayCost: number;
    heartbeatCount: number;
    unconsolidated: LogBufferEntry[];
    isCompaction: boolean;
    isConsolidation: boolean;
    activeRuns: string[];
    pendingDecisions: Decision[];
    answeredDecisions: Decision[];
    lastHeartbeat: string | undefined;
    lastConsolidationTimestamp: string | undefined;
    memories: MemoryEntry[];
    recentActions: ActivityEntry[];
    mcpServerNames: string[];
  }): Promise<{ prompt: string; modeLabel: string }> {
    const sharedOpts = {
      repos: this.config.repos,
      grouped: opts.grouped,
      budgetStatus: {
        todayUsd: opts.todayCost,
        capUsd: this.config.supervisor.dailyCapUsd,
        remainingPct:
          ((this.config.supervisor.dailyCapUsd - opts.todayCost) /
            this.config.supervisor.dailyCapUsd) *
          100,
      },
      activeRuns: opts.activeRuns,
      heartbeatCount: opts.heartbeatCount,
      mcpServerNames: opts.mcpServerNames,
      customInstructions: this.customInstructions,
      supervisorDir: this.supervisorDir,
      memories: opts.memories,
      recentActions: opts.recentActions,
      pendingDecisions: opts.pendingDecisions,
      answeredDecisions: opts.answeredDecisions,
      autoDecide: this.config.supervisor.autoDecide,
    };

    if (opts.isCompaction) {
      return {
        prompt: buildCompactionPrompt({
          ...sharedOpts,
          lastConsolidationTimestamp: opts.lastConsolidationTimestamp,
        }),
        modeLabel: "compaction",
      };
    }

    if (opts.isConsolidation) {
      return {
        prompt: buildConsolidationPrompt({
          ...sharedOpts,
          lastConsolidationTimestamp: opts.lastConsolidationTimestamp,
        }),
        modeLabel: "consolidation",
      };
    }

    if (isIdleHeartbeat(sharedOpts)) {
      return {
        prompt: buildIdlePrompt(sharedOpts),
        modeLabel: "idle",
      };
    }

    return {
      prompt: buildStandardPrompt(sharedOpts),
      modeLabel: "standard",
    };
  }

  /**
   * Call the Claude SDK and stream results.
   *
   * Uses Promise.race to enable non-blocking abort detection. The standard
   * `for await (const message of stream)` pattern only checks the abort signal
   * AFTER each yield — if the SDK hangs (no messages), the abort never executes.
   * This implementation races each iterator.next() against an abort promise,
   * allowing immediate response to shutdown/timeout signals.
   */
  private async callSdk(
    prompt: string,
    heartbeatId: string,
  ): Promise<{ output: string; costUsd: number; turnCount: number }> {
    const abortController = new AbortController();
    this.activeAbort = abortController;
    const timeout = setTimeout(() => {
      abortController.abort(new Error("Heartbeat timeout exceeded"));
    }, this.config.supervisor.heartbeatTimeoutMs);

    let output = "";
    let costUsd = 0;
    let turnCount = 0;

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");

      // Build allowed tools list — include MCP tool patterns for configured servers
      const allowedTools: string[] = ["Bash", "Read"];
      if (this.config.mcpServers) {
        for (const name of Object.keys(this.config.mcpServers)) {
          allowedTools.push(`mcp__${name}__*`);
        }
      }

      const queryOptions: Record<string, unknown> = {
        cwd: homedir(),
        allowedTools,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: this.config.mcpServers ?? {},
        // Don't persist session history — each heartbeat is a fresh conversation.
        // Without this, supervisor restarts could replay old messages.
        persistSession: false,
      };

      const stream = sdk.query({ prompt, options: queryOptions as never });

      // Create abort promise that resolves when signal fires
      const abortPromise = new Promise<{ aborted: true }>((resolve) => {
        if (abortController.signal.aborted) {
          resolve({ aborted: true });
          return;
        }
        abortController.signal.addEventListener("abort", () => resolve({ aborted: true }), {
          once: true,
        });
      });

      // Use Promise.race pattern for abortable stream iteration
      const iterator = stream[Symbol.asyncIterator]();
      try {
        while (true) {
          const raceResult = await Promise.race([iterator.next(), abortPromise]);

          // Check if abort triggered
          if ("aborted" in raceResult) {
            await this.activityLog.log("heartbeat", "Heartbeat aborted", { heartbeatId });
            break;
          }

          // Normal iterator result
          const iterResult = raceResult as IteratorResult<unknown>;
          if (iterResult.done) break;

          const msg = iterResult.value as SDKStreamMessage;

          if (isInitMessage(msg)) {
            this.sessionId = msg.session_id;
          }

          if (isResultMessage(msg)) {
            output = msg.result ?? "";
            costUsd = msg.total_cost_usd ?? 0;
            turnCount = msg.num_turns ?? 0;
          }

          await logStreamMessage(msg, heartbeatId, this.activityLog, (opts) =>
            this.emitRunDispatched(opts),
          );
        }
      } finally {
        // Properly cleanup iterator when done or aborted
        await iterator.return?.();
      }
    } finally {
      clearTimeout(timeout);
      this.activeAbort = null;
    }

    return { output, costUsd, turnCount };
  }

  /**
   * Load custom instructions from SUPERVISOR.md.
   * Resolution order:
   * 1. Explicit path via `supervisor.instructions` in config
   * 2. User default: ~/.neo/SUPERVISOR.md
   * 3. Bundled default from @neotx/agents (if path provided)
   */
  private async loadInstructions(): Promise<string | undefined> {
    const candidates: string[] = [];

    if (this.config.supervisor.instructions) {
      candidates.push(path.resolve(this.config.supervisor.instructions));
    }

    candidates.push(path.join(getDataDir(), "SUPERVISOR.md"));

    if (this.defaultInstructionsPath) {
      candidates.push(this.defaultInstructionsPath);
    }

    for (const filePath of candidates) {
      try {
        const content = await readFile(filePath, "utf-8");
        await this.activityLog.log("event", `Loaded instructions from ${filePath}`);
        return content;
      } catch {
        // File not found — try next candidate
      }
    }

    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Emit RunDispatchedEvent from tool result detection (wrapper for heartbeat-logging)
   */
  private async emitRunDispatched(opts: {
    runId: string;
    agent: string;
    repo: string;
    branch: string;
    prompt: string;
  }): Promise<void> {
    await emitRunDispatchedEvent(this.sessionId, opts, this.onWebhookEvent, this.activityLog);
  }
}
