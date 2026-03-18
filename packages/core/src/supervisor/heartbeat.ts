import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GlobalConfig } from "@/config";
import { getDataDir, getRunsDir } from "@/paths";
import {
  isAssistantMessage,
  isInitMessage,
  isResultMessage,
  isToolResultMessage,
  isToolUseMessage,
  type SDKStreamMessage,
} from "@/sdk-types";
import type { PersistedRun } from "@/types";
import type { ActivityLog } from "./activity-log.js";
import type { EventQueue, GroupedEvents } from "./event-queue.js";
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
import type { LogBufferEntry, SupervisorDaemonState } from "./schemas.js";
import {
  type HeartbeatEvent,
  heartbeatEventSchema,
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

// ─── Default values for deprecated config fields ─────────
// These maintain backward compatibility while allowing config removal.

/** Max idle heartbeats to skip before forcing a heartbeat (no events, no active work) */
const DEFAULT_IDLE_SKIP_MAX = 20;

/** Max heartbeats to skip when there's active work but no events */
const DEFAULT_ACTIVE_WORK_SKIP_MAX = 3;

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

// ─── Helper types for runHeartbeat refactoring ───────────

interface BudgetCheckResult {
  todayCost: number;
  exceeded: boolean;
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
  lastConsolidation: number;
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
  private readonly config: GlobalConfig;
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

  async start(): Promise<void> {
    this.customInstructions = await this.loadInstructions();
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
  }

  private async runHeartbeat(): Promise<void> {
    const startTime = Date.now();
    const heartbeatId = randomUUID();
    const state = await this.readState();
    const today = new Date().toISOString().slice(0, 10);

    // Check budget and return early if exceeded
    const budgetCheck = await this.checkBudgetExceeded(state, today);
    if (budgetCheck.exceeded) return;

    // Drain events and check for active work
    const { grouped, rawEvents } = this.eventQueue.drainAndGroup();
    const totalEventCount =
      grouped.messages.length + grouped.webhooks.length + grouped.runCompletions.length;
    const activeRuns = await this.getActiveRuns();

    // Handle skip logic for idle/active-work scenarios
    const skipResult = await this.handleSkipLogic({
      state,
      totalEventCount,
      activeRuns,
    });
    if (skipResult.shouldSkip) return;
    if (skipResult.resetCounters) {
      await this.updateState({ idleSkipCount: 0, activeWorkSkipCount: 0 });
    }

    // Determine heartbeat mode
    const modeResult = await this.determineHeartbeatMode(state);

    // Build prompt and log start
    const { prompt, modeLabel } = await this.buildHeartbeatModePrompt({
      grouped,
      todayCost: budgetCheck.todayCost,
      heartbeatCount: modeResult.heartbeatCount,
      unconsolidated: modeResult.unconsolidated,
      isCompaction: modeResult.isCompaction,
      isConsolidation: modeResult.isConsolidation,
      activeRuns,
      lastHeartbeat: state?.lastHeartbeat,
      lastConsolidationTimestamp: modeResult.lastConsolidationTs,
    });
    await this.activityLog.log(
      "heartbeat",
      `Heartbeat #${modeResult.heartbeatCount} starting (${modeLabel})`,
      {
        heartbeatId,
        eventCount: totalEventCount,
        messages: grouped.messages.length,
        webhooks: grouped.webhooks.length,
        runCompletions: grouped.runCompletions.length,
        isConsolidation: modeResult.isConsolidation,
      },
    );

    // Call SDK with timeout + shutdown abort
    const { costUsd, turnCount } = await this.callSdk(prompt, heartbeatId);

    // Mark events as processed so they are not replayed on restart
    if (rawEvents.length > 0) {
      const inboxPath = path.join(this.supervisorDir, "inbox.jsonl");
      await this.eventQueue.markProcessed(inboxPath, this.eventsPath, rawEvents);
    }

    // Post-response: mark entries consolidated and compact log buffer
    if (modeResult.isConsolidation) {
      const allIds = modeResult.unconsolidated.map((e) => e.id);
      if (allIds.length > 0) {
        await markConsolidated(this.supervisorDir, allIds);
      }
      await compactLogBuffer(this.supervisorDir);
    }

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

    // Emit heartbeat completed webhook event
    await this.emitHeartbeatCompleted({
      heartbeatNumber: modeResult.heartbeatCount + 1,
      runsActive: activeRuns.length,
      todayUsd: budgetCheck.todayCost + costUsd,
      limitUsd: this.config.supervisor.dailyCapUsd,
    });

    // Emit run completed events for any run completions processed
    for (const event of rawEvents) {
      if (event.kind === "run_complete") {
        const runData = await this.readPersistedRun(event.runId);
        const emitOpts: Parameters<typeof this.emitRunCompleted>[0] = {
          runId: event.runId,
          status: runData?.status === "failed" ? "failed" : "completed",
          costUsd: runData?.totalCostUsd ?? 0,
          durationMs: runData?.durationMs ?? 0,
        };
        if (runData?.output) {
          emitOpts.output = runData.output;
        }
        await this.emitRunCompleted(emitOpts);
      }
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
   * Handle skip logic for idle and active-work scenarios.
   */
  private async handleSkipLogic(opts: {
    state: SupervisorDaemonState | null;
    totalEventCount: number;
    activeRuns: string[];
  }): Promise<SkipLogicResult> {
    const { state, totalEventCount, activeRuns } = opts;
    const idleSkipCount = state?.idleSkipCount ?? 0;
    const activeWorkSkipCount = state?.activeWorkSkipCount ?? 0;
    const hasActiveWork = activeRuns.length > 0;

    if (totalEventCount === 0) {
      if (hasActiveWork) {
        if (activeWorkSkipCount < DEFAULT_ACTIVE_WORK_SKIP_MAX) {
          await this.updateState({
            activeWorkSkipCount: activeWorkSkipCount + 1,
            idleSkipCount: 0,
          });
          await this.activityLog.log(
            "heartbeat",
            `Active-work skip #${activeWorkSkipCount + 1}/${DEFAULT_ACTIVE_WORK_SKIP_MAX} — ${activeRuns.length} runs active, no events`,
          );
          return { shouldSkip: true, resetCounters: false };
        }
      } else {
        if (idleSkipCount < DEFAULT_IDLE_SKIP_MAX) {
          await this.updateState({
            idleSkipCount: idleSkipCount + 1,
            activeWorkSkipCount: 0,
          });
          await this.activityLog.log("heartbeat", `Idle skip #${idleSkipCount + 1} — no events`);
          return { shouldSkip: true, resetCounters: false };
        }
      }
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
      lastConsolidation,
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
    lastHeartbeat: string | undefined;
    lastConsolidationTimestamp: string | undefined;
  }): Promise<{ prompt: string; modeLabel: string }> {
    const mcpServerNames = this.config.mcpServers ? Object.keys(this.config.mcpServers) : [];
    const store = this.getMemoryStore();
    const memories: MemoryEntry[] = store ? store.query({ limit: 40, sortBy: "relevance" }) : [];
    const recentActions = await this.activityLog.tail(20);
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
      mcpServerNames,
      customInstructions: this.customInstructions,
      supervisorDir: this.supervisorDir,
      memories,
      recentActions,
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
      };

      const stream = sdk.query({ prompt, options: queryOptions as never });

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        const msg = message as SDKStreamMessage;

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
      clearTimeout(timeout);
      this.activeAbort = null;
    }

    return { output, costUsd, turnCount };
  }

  private async readState(): Promise<SupervisorDaemonState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      return JSON.parse(raw) as SupervisorDaemonState;
    } catch {
      return null;
    }
  }

  private async updateState(updates: Partial<SupervisorDaemonState>): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(raw) as SupervisorDaemonState;
      Object.assign(state, updates);
      await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Non-critical
    }
  }

  /** Read persisted run files and return summaries of active (running/paused) runs. */
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
            if (run.status === "running" || run.status === "paused") {
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
   * Read persisted run data to extract actual status, cost, and duration.
   * Returns null if the run file cannot be found or parsed.
   */
  private async readPersistedRun(runId: string): Promise<{
    status: PersistedRun["status"];
    totalCostUsd: number;
    durationMs: number;
    output: string | undefined;
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

          return { status: run.status, totalCostUsd, durationMs, output };
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
        case "run_dispatched":
          runDispatchedEventSchema.parse(event);
          break;
        case "run_completed":
          runCompletedEventSchema.parse(event);
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
  }
}
