import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigStore, ConfigWatcher, type GlobalConfig } from "@/config";
import { RunStore } from "@/orchestrator/run-store";
import { getDataDir, getRunsDir } from "@/paths";
import {
  isAssistantMessage,
  isInitMessage,
  isResultMessage,
  isToolResultMessage,
  isToolUseMessage,
  type SDKStreamMessage,
} from "@/sdk-types";
import { isProcessAlive } from "@/shared/process";
import { type TaskEntry, TaskStore } from "@/supervisor/task-store";
import type { PersistedRun } from "@/types";
import type { ActivityLog } from "./activity-log.js";
import { parseChildCommand, parseChildSpawnCommand } from "./child-command-parser.js";
import type { ChildRegistry } from "./child-registry.js";
import { spawnChildSupervisor } from "./child-spawner.js";
import { type Decision, DecisionStore } from "./decisions.js";
import { type Directive, DirectiveStore } from "./directive-store.js";
import type { EventQueue, GroupedEvents } from "./event-queue.js";
import { createFailureReport, writeFailureReport } from "./failure-report.js";
import { type IdleContext, IdleDetector } from "./idle-detector.js";
import { compactLogBuffer, markConsolidated, readUnconsolidated } from "./log-buffer.js";
import type { MemoryEntry } from "./memory/entry.js";
import { MemoryStore } from "./memory/store.js";
import {
  buildCompactionPrompt,
  buildConsolidationPrompt,
  buildIdlePrompt,
  buildStandardPrompt,
  isIdleHeartbeat,
} from "./prompt-builder.js";
import {
  type ActivityEntry,
  type LogBufferEntry,
  type QueuedEvent,
  type SupervisorDaemonState,
  supervisorDaemonStateSchema,
} from "./schemas.js";
import {
  type GhostRunRecoveredEvent,
  ghostRunRecoveredEventSchema,
  type HeartbeatEvent,
  type HeartbeatFailureEvent,
  heartbeatEventSchema,
  heartbeatFailureEventSchema,
  type RunCompletedEvent,
  type RunDispatchedEvent,
  runCompletedEventSchema,
  runDispatchedEventSchema,
  type SupervisorStartedEvent,
  type SupervisorStoppedEvent,
  type SupervisorWebhookEvent,
  supervisorStartedEventSchema,
  supervisorStoppedEventSchema,
} from "./webhookEvents.js";

/** Consolidation runs every N heartbeats */
const DEFAULT_CONSOLIDATION_INTERVAL = 5;

// ─── Consolidation logic ────────────────────────────────

/**
 * Determine whether this heartbeat should be a consolidation cycle.
 * Consolidation runs every `consolidationInterval` heartbeats,
 * or earlier if there are pending unconsolidated entries (after at least 2 heartbeats).
 */
export function shouldConsolidate(
  heartbeatCount: number,
  lastConsolidationHeartbeat: number,
  consolidationInterval: number,
  hasPendingEntries: boolean,
): boolean {
  const since = heartbeatCount - lastConsolidationHeartbeat;
  if (since >= consolidationInterval) return true;
  if (hasPendingEntries && since >= 2) return true;
  return false;
}

/**
 * Determine whether this heartbeat should run compaction.
 * Compaction is a deep cleanup pass that runs every ~50 heartbeats.
 */
export function shouldCompact(
  heartbeatCount: number,
  lastCompactionHeartbeat: number,
  compactionInterval = 50,
): boolean {
  const since = heartbeatCount - lastCompactionHeartbeat;
  return since >= compactionInterval;
}

/** Grace period before a run without PID can be considered stale (ms). */
export const STALE_GRACE_PERIOD_MS = 30_000;

/**
 * Determine if a persisted run is actually active (not stale).
 *
 * For "running" status, validates:
 * - If PID exists and process is alive → active
 * - If PID exists but process is dead → stale (ghost run)
 * - If no PID and within grace period → active (still starting up)
 * - If no PID and past grace period → stale (ghost run)
 *
 * For "paused" status: always considered active (waiting for user action).
 * For "blocked" status: always considered active (waiting for blocker resolution).
 */
export function isRunActive(
  run: PersistedRun,
  isAlive: (pid: number) => boolean = isProcessAlive,
  now: number = Date.now(),
): boolean {
  // Skip terminal statuses
  if (run.status === "completed" || run.status === "failed") {
    return false;
  }

  // Paused and blocked runs are always considered active (waiting for resolution)
  if (run.status === "paused" || run.status === "blocked") {
    return true;
  }

  // For running status, validate the run is actually alive
  // If PID exists and process is alive, it's active
  if (run.pid && isAlive(run.pid)) {
    return true;
  }

  // If PID exists but process is dead, it's a stale ghost run
  if (run.pid) {
    return false;
  }

  // No PID: check grace period (run may still be starting up)
  const ageMs = now - new Date(run.createdAt).getTime();

  return ageMs < STALE_GRACE_PERIOD_MS;
}

// ─── Helper types for runHeartbeat refactoring ───────────

interface BudgetCheckResult {
  todayCost: number;
  exceeded: boolean;
}

interface ProcessDecisionsResult {
  pendingDecisions: Decision[];
  answeredDecisions: Decision[];
  hasExpiredDecisions: boolean;
  /** Always reflects reality — used for idle-check even in non-autoDecide mode */
  hasPendingDecisions: boolean;
}

interface EventContext {
  grouped: GroupedEvents;
  rawEvents: QueuedEvent[];
  totalEventCount: number;
  activeRuns: string[];
  memories: MemoryEntry[];
  tasks: TaskEntry[];
  recentActions: ActivityEntry[];
  mcpServerNames: string[];
  activeDirectives: Directive[];
}

interface PostSdkProcessingInput {
  rawEvents: QueuedEvent[];
  isConsolidation: boolean;
  isCompaction: boolean;
  unconsolidated: LogBufferEntry[];
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

interface HeartbeatModeResult {
  isConsolidation: boolean;
  isCompaction: boolean;
  unconsolidated: LogBufferEntry[];
  heartbeatCount: number;
  lastConsolidationTs: string | undefined;
}

interface StateUpdateResult {
  stateUpdate: Partial<SupervisorDaemonState>;
}

// ─── HeartbeatLoop ───────────────────────────────────────

/** Callback for emitting webhook events */
export type WebhookEventEmitter = (event: SupervisorWebhookEvent) => void | Promise<void>;

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
  /** Optional child registry for focused supervisor IPC integration */
  childRegistry?: ChildRegistry | undefined;
  /** Path to child-supervisor-worker.js for spawning child processes */
  workerPath?: string | undefined;
  /** Name of this supervisor instance (for child spawn registration) */
  supervisorName?: string | undefined;
  /** Path to directives storage */
  directivesPath?: string | undefined;
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
  /** Cache of decision IDs already answered in this session to prevent re-answer spam */
  private readonly answeredDecisionIds = new Set<string>();

  /** ConfigWatcher for hot-reload support */
  private configWatcher: ConfigWatcher | null = null;
  private configStore: ConfigStore | null = null;
  private readonly repoPath: string | undefined;
  private readonly configWatcherDebounceMs: number | undefined;
  private readonly childRegistry: ChildRegistry | undefined;
  private readonly workerPath: string | undefined;
  private readonly supervisorName: string | undefined;
  private directiveStore: DirectiveStore | null = null;
  private readonly directivesPath: string | undefined;

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
    this.childRegistry = options.childRegistry;
    this.workerPath = options.workerPath;
    this.supervisorName = options.supervisorName;
    this.directivesPath = options.directivesPath;
  }

  /** Path to the inbox/events directory for markProcessed() calls */
  get eventsPath(): string {
    return this._eventsPath;
  }

  /** Track store initialization failures for health reporting */
  private storeInitErrors: Map<string, string> = new Map();

  private getMemoryStore(): MemoryStore | null {
    if (!this.memoryStore && this.memoryDbPath) {
      try {
        this.memoryStore = new MemoryStore(this.memoryDbPath);
        this.storeInitErrors.delete("memory");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.storeInitErrors.set("memory", msg);
        this.activityLog
          .log("warning", `MemoryStore initialization failed: ${msg}`, {
            store: "memory",
            error: msg,
          })
          .catch((logErr) => {
            // Best-effort logging — don't let logging failure cascade
            // biome-ignore lint/suspicious/noConsole: Fallback for when activity log itself fails
            console.debug(`[HeartbeatLoop] Activity log failed: ${logErr}`);
          });
      }
    }
    return this.memoryStore;
  }

  private taskStore: TaskStore | null = null;

  private getTaskStore(): TaskStore | null {
    if (!this.taskStore && this.memoryDbPath) {
      try {
        this.taskStore = new TaskStore(this.memoryDbPath);
        this.storeInitErrors.delete("task");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.storeInitErrors.set("task", msg);
        this.activityLog
          .log("warning", `TaskStore initialization failed: ${msg}`, {
            store: "task",
            error: msg,
          })
          .catch((logErr) => {
            // Best-effort logging — don't let logging failure cascade
            // biome-ignore lint/suspicious/noConsole: Fallback for when activity log itself fails
            console.debug(`[HeartbeatLoop] Activity log failed: ${logErr}`);
          });
      }
    }
    return this.taskStore;
  }

  private getDecisionStore(): DecisionStore {
    if (!this.decisionStore) {
      this.decisionStore = new DecisionStore(path.join(this.supervisorDir, "decisions.jsonl"));
    }
    return this.decisionStore;
  }

  private getDirectiveStore(): DirectiveStore | null {
    if (!this.directiveStore && this.directivesPath) {
      try {
        this.directiveStore = new DirectiveStore(this.directivesPath);
        this.storeInitErrors.delete("directive");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.storeInitErrors.set("directive", msg);
        this.activityLog
          .log("warning", `DirectiveStore initialization failed: ${msg}`, {
            store: "directive",
            error: msg,
          })
          .catch((logErr) => {
            // Best-effort logging — don't let logging failure cascade
            // biome-ignore lint/suspicious/noConsole: Fallback for when activity log itself fails
            console.debug(`[HeartbeatLoop] Activity log failed: ${logErr}`);
          });
      }
    }
    return this.directiveStore;
  }

  /**
   * Returns the health status of all stores.
   * Useful for diagnostics and monitoring degraded mode.
   */
  getStoreHealth(): {
    memory: { available: boolean; error: string | undefined };
    task: { available: boolean; error: string | undefined };
    directive: { available: boolean; error: string | undefined };
    decision: { available: boolean };
  } {
    return {
      memory: {
        available: this.memoryStore !== null,
        error: this.storeInitErrors.get("memory"),
      },
      task: {
        available: this.taskStore !== null,
        error: this.storeInitErrors.get("task"),
      },
      directive: {
        available: this.directiveStore !== null,
        error: this.storeInitErrors.get("directive"),
      },
      decision: {
        available: this.decisionStore !== null,
      },
    };
  }

  async start(): Promise<void> {
    this.customInstructions = await this.loadInstructions();

    // Initialize and start config watcher for hot-reload
    await this.initConfigWatcher();

    // Scan for and recover ghost runs from crashed supervisors
    await this.recoverGhostRuns();

    await this.activityLog.log("heartbeat", "Supervisor heartbeat loop started");
    await this.emitSupervisorStarted();

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

    await this.emitSupervisorStopped("shutdown");
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

    // Stop all child supervisors
    this.childRegistry?.stopAll();
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

    try {
      const state = await this.readState();
      const today = new Date().toISOString().slice(0, 10);

      // Check budget and return early if exceeded
      const budgetCheck = await this.checkBudgetExceeded(state, today);
      if (budgetCheck.exceeded) return;

      // Gather event context
      const eventCtx = await this.gatherEventContext();

      // Process decision answers and expiry
      const { pendingDecisions, answeredDecisions, hasExpiredDecisions, hasPendingDecisions } =
        await this.processDecisions(eventCtx.rawEvents, state?.lastHeartbeat);

      // Check for pending consolidation entries
      const unconsolidatedEntries = await readUnconsolidated(this.supervisorDir);
      const hasPendingConsolidation = unconsolidatedEntries.length > 0;

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
        await this.updateState({ idleSkipCount: 0, activeWorkSkipCount: 0 });
      }

      // Determine heartbeat mode
      const modeResult = await this.determineHeartbeatMode(state);

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
        hasPendingDecisions,
        lastHeartbeat: state?.lastHeartbeat,
        lastConsolidationTimestamp: modeResult.lastConsolidationTs,
        memories: eventCtx.memories,
        tasks: eventCtx.tasks,
        recentActions: eventCtx.recentActions,
        mcpServerNames: eventCtx.mcpServerNames,
        activeDirectives: eventCtx.activeDirectives,
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
      await this.handlePostSdkProcessing({
        rawEvents: eventCtx.rawEvents,
        isConsolidation: modeResult.isConsolidation,
        isCompaction: modeResult.isCompaction,
        unconsolidated: modeResult.unconsolidated,
      });

      // Build and apply state update
      const durationMs = Date.now() - startTime;
      const { stateUpdate } = this.buildStateUpdate({
        state,
        today,
        todayCost: budgetCheck.todayCost,
        costUsd,
        heartbeatCount: modeResult.heartbeatCount,
        isConsolidation: modeResult.isConsolidation,
        isCompaction: modeResult.isCompaction,
      });
      await this.updateState(stateUpdate);

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
    } catch (error) {
      // Global error boundary: emit heartbeat:failure event and re-throw
      // This ensures the daemon's outer catch handles circuit-breaker logic
      // while also providing visibility via webhook events
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Emit failure event before re-throwing (best-effort, don't let emission failure mask original error)
      try {
        await this.emitHeartbeatFailure({
          heartbeatId,
          error: errorMsg,
          consecutiveFailures: this.consecutiveFailures + 1,
        });
      } catch {
        // Emission failed — log and continue to re-throw original error
      }

      throw error;
    }
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
   * Process decision answers from inbox and expire old decisions.
   * Returns pending, answered, and expiry status for prompt context.
   */
  private async processDecisions(
    rawEvents: QueuedEvent[],
    lastHeartbeat: string | undefined,
  ): Promise<ProcessDecisionsResult> {
    const decisionStore = this.getDecisionStore();

    // Process decision answers from inbox messages
    await this.processDecisionAnswers(rawEvents, decisionStore);
    await this.processChildCommands(rawEvents);
    await this.processChildSpawnCommands(rawEvents);

    // Auto-answer expired decisions
    const expiredDecisions = await decisionStore.expire();
    const hasExpiredDecisions = expiredDecisions.length > 0;

    // Always fetch pending count for idle-check (determines whether to dispatch scout).
    // Only pass the full list to the prompt in autoDecide mode (supervisor answers them).
    const allPending = await decisionStore.pending();
    const hasPendingDecisions = allPending.length > 0;
    const pendingDecisions = this.config.supervisor.autoDecide ? allPending : [];
    const answeredDecisions = this.config.supervisor.autoDecide
      ? await decisionStore.answered(lastHeartbeat)
      : [];

    return { pendingDecisions, answeredDecisions, hasExpiredDecisions, hasPendingDecisions };
  }

  /**
   * Gather event context: drain queue, fetch active runs, memories, tasks, recent actions, and active directives.
   */
  private async gatherEventContext(): Promise<EventContext> {
    const { grouped, rawEvents } = this.eventQueue.drainAndGroup();
    const totalEventCount =
      grouped.messages.length + grouped.webhooks.length + grouped.runCompletions.length;

    const mcpServerNames = this.config.mcpServers ? Object.keys(this.config.mcpServers) : [];

    // Synchronous store reads (better-sqlite3 is sync)
    const memoryStore = this.getMemoryStore();
    const memories: MemoryEntry[] = memoryStore
      ? memoryStore.query({ limit: 40, sortBy: "relevance" })
      : [];
    const taskStore = this.getTaskStore();
    const tasks: TaskEntry[] = taskStore ? taskStore.getTasks() : [];

    // Parallel async reads to reduce latency
    const directiveStore = this.getDirectiveStore();
    const [activeRuns, recentActions, activeDirectives] = await Promise.all([
      this.getActiveRuns(),
      this.activityLog.tail(20),
      directiveStore ? directiveStore.active("idle") : Promise.resolve([] as Directive[]),
    ]);

    return {
      grouped,
      rawEvents,
      totalEventCount,
      activeRuns,
      memories,
      tasks,
      recentActions,
      mcpServerNames,
      activeDirectives,
    };
  }

  /**
   * Handle post-SDK processing: mark events as processed, consolidate log buffer, clean up old directives.
   */
  private async handlePostSdkProcessing(input: PostSdkProcessingInput): Promise<void> {
    // Mark events as processed so they are not replayed on restart
    if (input.rawEvents.length > 0) {
      const inboxPath = path.join(this.supervisorDir, "inbox.jsonl");
      await this.eventQueue.markProcessed(inboxPath, this.eventsPath, input.rawEvents);
    }

    // Post-response: mark entries consolidated and compact log buffer
    if (input.isConsolidation) {
      const allIds = input.unconsolidated.map((e) => e.id);
      if (allIds.length > 0) {
        await markConsolidated(this.supervisorDir, allIds);
      }
      await compactLogBuffer(this.supervisorDir);
    }

    // Clean up old expired directives during compaction
    if (input.isCompaction) {
      const directiveStore = this.getDirectiveStore();
      if (directiveStore) {
        const expired = await directiveStore.expireOld();
        if (expired.length > 0) {
          await this.activityLog.log("event", `Cleaned up ${expired.length} expired directive(s)`, {
            expiredIds: expired,
          });
        }
      }
    }
  }

  /**
   * Emit completion webhook events: heartbeat completed and run completed events.
   */
  private async emitCompletionEvents(input: CompletionEventsInput): Promise<void> {
    // Emit heartbeat completed webhook event
    await this.emitHeartbeatCompleted({
      heartbeatNumber: input.heartbeatCount + 1,
      runsActive: input.activeRuns.length,
      todayUsd: input.todayCost + input.costUsd,
      limitUsd: this.config.supervisor.dailyCapUsd,
    });

    // Emit run completed events for any run completions processed
    for (const event of input.rawEvents) {
      if (event.kind === "run_complete") {
        const runData = await this.readPersistedRun(event.runId);
        const emitOpts: Parameters<typeof this.emitRunCompleted>[0] = {
          runId: event.runId,
          status: runData?.status === "failed" ? "failed" : "completed",
          costUsd: runData?.totalCostUsd ?? 0,
          durationMs: runData?.durationMs ?? 0,
          attemptCount: runData?.attemptCount ?? 1,
        };
        if (runData?.output !== undefined) {
          emitOpts.output = runData.output;
        }
        if (runData?.task !== undefined) {
          emitOpts.task = runData.task;
        }
        await this.emitRunCompleted(emitOpts);
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
        await this.updateState({
          activeWorkSkipCount: activeWorkSkipCount + 1,
          idleSkipCount: 0,
        });
        await this.activityLog.log(
          "heartbeat",
          `Active-work skip #${activeWorkSkipCount + 1}/${this.config.supervisor.activeWorkSkipMax} — ${result.reason}`,
        );
      } else {
        await this.updateState({
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
   * Determine heartbeat mode: compaction > consolidation > standard.
   */
  private async determineHeartbeatMode(
    state: SupervisorDaemonState | null,
  ): Promise<HeartbeatModeResult> {
    const heartbeatCount = state?.heartbeatCount ?? 0;
    const lastConsolidation = state?.lastConsolidationHeartbeat ?? 0;
    const lastCompaction = state?.lastCompactionHeartbeat ?? 0;
    const lastConsolidationTs = state?.lastConsolidationTimestamp;
    const unconsolidated = await readUnconsolidated(this.supervisorDir);

    const hasNewEntriesSinceLastConsolidation = lastConsolidationTs
      ? unconsolidated.some((e) => e.timestamp > lastConsolidationTs)
      : unconsolidated.length > 0;

    const hasPendingEntries = unconsolidated.length > 0;
    const isCompaction = shouldCompact(heartbeatCount, lastCompaction);
    const wouldConsolidate = shouldConsolidate(
      heartbeatCount,
      lastConsolidation,
      DEFAULT_CONSOLIDATION_INTERVAL,
      hasPendingEntries,
    );
    const isConsolidation =
      isCompaction || (wouldConsolidate && hasNewEntriesSinceLastConsolidation);

    return {
      isConsolidation,
      isCompaction,
      unconsolidated,
      heartbeatCount,
      lastConsolidationTs,
    };
  }

  /**
   * Build the state update object after heartbeat completion.
   */
  private buildStateUpdate(opts: {
    state: SupervisorDaemonState | null;
    today: string;
    todayCost: number;
    costUsd: number;
    heartbeatCount: number;
    isConsolidation: boolean;
    isCompaction: boolean;
  }): StateUpdateResult {
    const stateUpdate: Partial<SupervisorDaemonState> = {
      sessionId: this.sessionId,
      lastHeartbeat: new Date().toISOString(),
      heartbeatCount: opts.heartbeatCount + 1,
      totalCostUsd: (opts.state?.totalCostUsd ?? 0) + opts.costUsd,
      todayCostUsd: opts.todayCost + opts.costUsd,
      costResetDate: opts.today,
    };

    if (opts.isConsolidation) {
      stateUpdate.lastConsolidationHeartbeat = opts.heartbeatCount + 1;
      stateUpdate.lastConsolidationTimestamp = new Date().toISOString();
    }

    if (opts.isCompaction) {
      stateUpdate.lastCompactionHeartbeat = opts.heartbeatCount + 1;
    }

    return { stateUpdate };
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
    hasPendingDecisions: boolean;
    lastHeartbeat: string | undefined;
    lastConsolidationTimestamp: string | undefined;
    memories: MemoryEntry[];
    tasks: TaskEntry[];
    recentActions: ActivityEntry[];
    mcpServerNames: string[];
    activeDirectives: Directive[];
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
      tasks: opts.tasks,
      recentActions: opts.recentActions,
      pendingDecisions: opts.pendingDecisions,
      answeredDecisions: opts.answeredDecisions,
      hasPendingDecisions: opts.hasPendingDecisions,
      autoDecide: this.config.supervisor.autoDecide,
      activeDirectives: opts.activeDirectives,
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

          await this.logStreamMessage(msg, heartbeatId);
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

  private async readState(): Promise<SupervisorDaemonState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw);
      const result = supervisorDaemonStateSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async updateState(updates: Partial<SupervisorDaemonState>): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw);
      const result = supervisorDaemonStateSchema.safeParse(parsed);
      if (!result.success) return;
      const state = result.data;
      Object.assign(state, updates);
      await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Non-critical
    }
  }

  /**
   * Read persisted run files and return summaries of active (running/paused) runs.
   * Validates that "running" runs are actually alive by checking their PID.
   * Stale runs (dead PID past grace period) are filtered out to prevent ghost runs.
   */
  private async getActiveRuns(): Promise<string[]> {
    const runsDir = getRunsDir();
    if (!existsSync(runsDir)) return [];

    try {
      const entries = await readdir(runsDir, { withFileTypes: true });
      const active: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(runsDir, entry.name);
        const files = await readdir(subDir);

        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          try {
            const raw = await readFile(path.join(subDir, f), "utf-8");
            const run = JSON.parse(raw) as PersistedRun;

            if (isRunActive(run)) {
              active.push(
                `${run.runId} [${run.status}] ${run.agent} on ${path.basename(run.repo)}`,
              );
            }
          } catch {
            // Corrupted or partial file — skip
          }
        }
      }

      return active;
    } catch {
      return [];
    }
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

  /** Route a single SDK stream message to the appropriate log handler. */
  private async logStreamMessage(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    if (isAssistantMessage(msg)) {
      await this.logContentBlocks(msg, heartbeatId);
    } else if (isToolUseMessage(msg)) {
      await this.logToolUse(msg, heartbeatId);
    } else if (isToolResultMessage(msg)) {
      await this.logToolResult(msg, heartbeatId);
    }
  }

  /** Log thinking and plan blocks from assistant content — no truncation. */
  private async logContentBlocks(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    if (!isAssistantMessage(msg)) return;
    const content = msg.message?.content;
    if (!content) return;

    for (const block of content) {
      if (block.type === "thinking" && block.thinking) {
        await this.activityLog.log("thinking", block.thinking, { heartbeatId });
      }
      if (block.type === "text" && block.text) {
        await this.activityLog.log("plan", block.text, { heartbeatId });
        break; // Only log first text block per message
      }
    }
  }

  /** Log tool use events — distinguish MCP tools from built-in tools. */
  private async logToolUse(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    if (!isToolUseMessage(msg)) return;
    const toolName = msg.tool;
    const isMcp = toolName.startsWith("mcp__");
    await this.activityLog.log(
      isMcp ? "tool_use" : "action",
      isMcp ? toolName : `Tool use: ${toolName}`,
      { heartbeatId, tool: toolName, input: msg.input },
    );
  }

  /** Detect agent dispatches from bash tool results. */
  private async logToolResult(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    if (!isToolResultMessage(msg)) return;
    const result = msg.result ?? "";
    const runMatch = /Run\s+(\S+)\s+dispatched/i.exec(result);
    const runId = runMatch?.[1];
    if (runId) {
      await this.activityLog.log("dispatch", `Agent dispatched: ${runId}`, {
        heartbeatId,
        runId,
      });

      // Emit run dispatched webhook event
      // Extract additional info from the result if available.
      //
      // Expected tool result formats from `neo run` command output:
      //   - "Run <runId> dispatched"
      //   - "agent: <name>" or "Agent: <name>" or "agent <name>"
      //   - "repo: <path>" or "Repo: <path>" or "repo <path>"
      //   - "branch: <name>" or "Branch: <name>" or "branch <name>"
      //
      // These patterns are best-effort extraction. If the format changes,
      // values will default to "unknown" without breaking the event emission.
      const agentMatch = /agent[:\s]+(\S+)/i.exec(result);
      const repoMatch = /repo[:\s]+(\S+)/i.exec(result);
      const branchMatch = /branch[:\s]+(\S+)/i.exec(result);

      const agent = agentMatch?.[1] ?? "unknown";
      const repo = repoMatch?.[1] ?? "unknown";
      const branch = branchMatch?.[1] ?? "unknown";

      await this.emitRunDispatched({
        runId,
        agent,
        repo,
        branch,
        prompt: result.slice(0, 500),
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Process decision:answer events from inbox messages.
   * Expected format: "decision:answer <decisionId> <answer>"
   *
   * Uses an in-memory deduplication cache to prevent re-answering decisions
   * that have already been processed, avoiding the "already answered" error spam.
   */
  private async processDecisionAnswers(
    rawEvents: QueuedEvent[],
    store: DecisionStore,
  ): Promise<void> {
    for (const event of rawEvents) {
      const parsed = parseDecisionAnswerEvent(event);
      if (!parsed) continue;
      await this.applyDecisionAnswer(parsed.decisionId, parsed.answer, store);
    }
  }

  /**
   * Process child:* commands from inbox messages.
   * Routes inject/unblock/stop to the ChildRegistry via IPC.
   * These messages are consumed here and not forwarded to the AI prompt.
   */
  private async processChildCommands(rawEvents: QueuedEvent[]): Promise<void> {
    if (!this.childRegistry) return;
    for (const event of rawEvents) {
      if (event.kind !== "message") continue;
      const command = parseChildCommand(event.data.text ?? "");
      if (!command) continue;
      switch (command.type) {
        case "inject":
          this.childRegistry.send(command.supervisorId, {
            type: "inject",
            context: command.context,
          });
          break;
        case "unblock":
          this.childRegistry.send(command.supervisorId, {
            type: "unblock",
            answer: command.answer,
          });
          break;
        case "stop":
          this.childRegistry.send(command.supervisorId, { type: "stop" });
          break;
      }
    }
  }

  /**
   * Process child:spawn commands from inbox messages.
   * These come from `neo supervise --parent=X` CLI invocations.
   */
  private async processChildSpawnCommands(rawEvents: QueuedEvent[]): Promise<void> {
    if (!this.childRegistry || !this.workerPath || !this.supervisorName) return;

    for (const event of rawEvents) {
      if (event.kind !== "message") continue;
      const text = event.data.text ?? "";
      const parsed = parseChildSpawnCommand(text);
      if (!parsed) continue;

      try {
        const spawnOptions: Parameters<typeof spawnChildSupervisor>[0] = {
          objective: parsed.objective,
          acceptanceCriteria: parsed.acceptanceCriteria,
          registry: this.childRegistry,
          workerPath: this.workerPath,
          parentName: this.supervisorName,
          depth: 0,
        };
        if (parsed.maxCostUsd !== undefined) {
          spawnOptions.maxCostUsd = parsed.maxCostUsd;
        }
        const result = await spawnChildSupervisor(spawnOptions);

        await this.activityLog.log(
          "dispatch",
          `Child supervisor spawned from CLI: ${result.supervisorId}`,
          {
            supervisorId: result.supervisorId,
            objective: parsed.objective,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.activityLog.log("error", `Failed to spawn child supervisor: ${msg}`);
      }
    }
  }

  private async applyDecisionAnswer(
    decisionId: string,
    answer: string,
    store: DecisionStore,
  ): Promise<void> {
    if (this.answeredDecisionIds.has(decisionId)) return;

    const alreadyAnswered = await store.isAnswered(decisionId);
    if (alreadyAnswered) {
      this.answeredDecisionIds.add(decisionId);
      return;
    }

    try {
      await store.answer(decisionId, answer);
      this.answeredDecisionIds.add(decisionId);
      await this.activityLog.log("event", `Decision answered: ${decisionId}`, {
        decisionId,
        answer,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("already answered")) {
        this.answeredDecisionIds.add(decisionId);
      } else {
        await this.activityLog.log("error", `Failed to answer decision ${decisionId}: ${msg}`, {
          decisionId,
          answer,
        });
      }
    }
  }

  /**
   * Read persisted run data to extract actual status, cost, and duration.
   * Returns null if the run file cannot be found or parsed.
   */
  private async readPersistedRun(runId: string): Promise<{
    status: PersistedRun["status"];
    totalCostUsd: number;
    durationMs: number;
    output: string | undefined;
    task: string | undefined;
    attemptCount: number;
  } | null> {
    const runsDir = getRunsDir();
    if (!existsSync(runsDir)) return null;

    try {
      const entries = await readdir(runsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(runsDir, entry.name);
        const runPath = path.join(subDir, `${runId}.json`);

        if (existsSync(runPath)) {
          const raw = await readFile(runPath, "utf-8");
          const run = JSON.parse(raw) as PersistedRun;

          // Calculate total cost from all steps
          const totalCostUsd = Object.values(run.steps).reduce(
            (sum, step) => sum + (step.costUsd ?? 0),
            0,
          );

          // Calculate duration from createdAt to updatedAt
          const durationMs = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();

          // Get output from the last completed step
          const completedSteps = Object.values(run.steps).filter(
            (s) => s.status === "success" || s.status === "failure",
          );
          const lastStep = completedSteps[completedSteps.length - 1];
          const output =
            typeof lastStep?.rawOutput === "string" ? lastStep.rawOutput.slice(0, 1000) : undefined;

          // Extract task from run prompt or use fallback
          const task = run.prompt?.slice(0, 200) ?? "Unknown task";

          return {
            status: run.status,
            totalCostUsd,
            durationMs,
            output,
            task,
            attemptCount: Object.keys(run.steps).length,
          };
        }
      }
    } catch {
      // Non-critical — return null if we can't read run data
    }

    return null;
  }

  // ─── Webhook event emission ───────────────────────────────

  /**
   * Emit a webhook event if a callback is configured.
   * Validates the event against its schema before emission.
   */
  private async emitWebhookEvent(event: SupervisorWebhookEvent): Promise<void> {
    if (!this.onWebhookEvent) return;

    try {
      // Validate event against schema before emission
      switch (event.type) {
        case "supervisor_started":
          supervisorStartedEventSchema.parse(event);
          break;
        case "heartbeat":
          heartbeatEventSchema.parse(event);
          break;
        case "heartbeat_failure":
          heartbeatFailureEventSchema.parse(event);
          break;
        case "run_dispatched":
          runDispatchedEventSchema.parse(event);
          break;
        case "run_completed":
          runCompletedEventSchema.parse(event);
          break;
        case "ghost_run_recovered":
          ghostRunRecoveredEventSchema.parse(event);
          break;
        case "supervisor_stopped":
          supervisorStoppedEventSchema.parse(event);
          break;
      }

      await this.onWebhookEvent(event);
    } catch (error) {
      // Log validation/emission errors but don't fail the heartbeat
      const msg = error instanceof Error ? error.message : String(error);
      await this.activityLog.log("error", `Webhook event emission failed: ${msg}`, {
        eventType: event.type,
      });
    }
  }

  /** Emit SupervisorStartedEvent */
  private async emitSupervisorStarted(): Promise<void> {
    const event: SupervisorStartedEvent = {
      type: "supervisor_started",
      supervisorId: this.sessionId,
      startedAt: new Date().toISOString(),
    };
    await this.emitWebhookEvent(event);
  }

  /** Emit SupervisorStoppedEvent */
  private async emitSupervisorStopped(
    reason: "shutdown" | "budget_exceeded" | "error" | "manual",
  ): Promise<void> {
    const event: SupervisorStoppedEvent = {
      type: "supervisor_stopped",
      supervisorId: this.sessionId,
      stoppedAt: new Date().toISOString(),
      reason,
    };
    await this.emitWebhookEvent(event);
  }

  /** Emit HeartbeatEvent */
  private async emitHeartbeatCompleted(opts: {
    heartbeatNumber: number;
    runsActive: number;
    todayUsd: number;
    limitUsd: number;
  }): Promise<void> {
    const event: HeartbeatEvent = {
      type: "heartbeat",
      supervisorId: this.sessionId,
      heartbeatNumber: opts.heartbeatNumber,
      timestamp: new Date().toISOString(),
      runsActive: opts.runsActive,
      budget: {
        todayUsd: opts.todayUsd,
        limitUsd: opts.limitUsd,
      },
    };
    await this.emitWebhookEvent(event);
  }

  /** Emit RunDispatchedEvent from tool result detection */
  private async emitRunDispatched(opts: {
    runId: string;
    agent: string;
    repo: string;
    branch: string;
    prompt: string;
  }): Promise<void> {
    const event: RunDispatchedEvent = {
      type: "run_dispatched",
      supervisorId: this.sessionId,
      runId: opts.runId,
      agent: opts.agent,
      repo: opts.repo,
      branch: opts.branch,
      prompt: opts.prompt.slice(0, 500), // Truncate to schema max
    };
    await this.emitWebhookEvent(event);
  }

  /** Emit RunCompletedEvent when processing run_complete events */
  private async emitRunCompleted(opts: {
    runId: string;
    status: "completed" | "failed" | "cancelled";
    output?: string;
    costUsd: number;
    durationMs: number;
    task?: string;
    attemptCount?: number;
  }): Promise<void> {
    const event: RunCompletedEvent = {
      type: "run_completed",
      supervisorId: this.sessionId,
      runId: opts.runId,
      status: opts.status,
      output: opts.output?.slice(0, 1000), // Truncate to schema max
      costUsd: opts.costUsd,
      durationMs: opts.durationMs,
    };
    await this.emitWebhookEvent(event);

    // Write structured failure report for failed runs
    if (opts.status === "failed") {
      try {
        const report = createFailureReport({
          runId: opts.runId,
          task: opts.task ?? "Unknown task",
          reason: opts.output ?? "Unknown error",
          attemptCount: opts.attemptCount ?? 1,
          costUsd: opts.costUsd,
        });
        await writeFailureReport(this.supervisorDir, report);
      } catch {
        // Best-effort: failure report errors should never crash daemon
      }
    }
  }

  /** Emit HeartbeatFailureEvent when runHeartbeat encounters an uncaught error */
  private async emitHeartbeatFailure(opts: {
    heartbeatId: string;
    error: string;
    consecutiveFailures: number;
  }): Promise<void> {
    const event: HeartbeatFailureEvent = {
      type: "heartbeat_failure",
      supervisorId: this.sessionId,
      heartbeatId: opts.heartbeatId,
      timestamp: new Date().toISOString(),
      error: opts.error.slice(0, 1000), // Truncate to schema max
      consecutiveFailures: opts.consecutiveFailures,
    };
    await this.emitWebhookEvent(event);
  }

  /** Emit GhostRunRecoveredEvent when a ghost run is detected and marked failed */
  private async emitGhostRunRecovered(opts: {
    runId: string;
    agent: string;
    repo: string;
  }): Promise<void> {
    const event: GhostRunRecoveredEvent = {
      type: "ghost_run_recovered",
      supervisorId: this.sessionId,
      runId: opts.runId,
      agent: opts.agent,
      repo: opts.repo,
      timestamp: new Date().toISOString(),
      reason: "supervisor crashed",
    };
    await this.emitWebhookEvent(event);
  }

  /**
   * Scan for ghost runs from crashed supervisors on startup.
   * Marks them as failed and emits events for logging/debugging.
   */
  private async recoverGhostRuns(): Promise<void> {
    try {
      const runStore = new RunStore();
      const ghostRuns = await runStore.scanForStaleRuns();

      if (ghostRuns.length === 0) return;

      await this.activityLog.log(
        "event",
        `Recovered ${ghostRuns.length} ghost run(s) from crashed supervisor`,
        { runIds: ghostRuns.map((r) => r.runId) },
      );

      // Emit events for each recovered ghost run
      for (const run of ghostRuns) {
        await this.emitGhostRunRecovered({
          runId: run.runId,
          agent: run.agent,
          repo: run.repo,
        });
      }
    } catch (error) {
      // Non-critical — best effort recovery
      const msg = error instanceof Error ? error.message : String(error);
      await this.activityLog.log("error", `Ghost run recovery failed: ${msg}`);
    }
  }
}

/**
 * Parse a queued event into a decision answer if it matches the expected format.
 * Expected message format: "decision:answer <decisionId> <answer>"
 */
function parseDecisionAnswerEvent(
  event: QueuedEvent,
): { decisionId: string; answer: string } | null {
  if (event.kind !== "message") return null;
  if (!event.data.text) return null;
  const text = event.data.text.trim();
  const match = /^decision:answer\s+(\S+)\s+(.+)$/i.exec(text);
  if (!match) return null;
  const decisionId = match[1];
  const answer = match[2];
  if (!decisionId || !answer) return null;
  return { decisionId, answer };
}
