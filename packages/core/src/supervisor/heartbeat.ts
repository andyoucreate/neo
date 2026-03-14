import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { GlobalConfig } from "@/config";
import type { ActivityLog } from "./activity-log.js";
import type { EventQueue } from "./event-queue.js";
import { checkMemorySize, extractMemoryFromResponse, loadMemory, saveMemory } from "./memory.js";
import { buildHeartbeatPrompt } from "./prompt-builder.js";
import type { SupervisorDaemonState } from "./schemas.js";

// ─── SDK message shapes (same as runner/session.ts) ──────

interface SDKStreamMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

// ─── HeartbeatLoop ───────────────────────────────────────

export interface HeartbeatLoopOptions {
  config: GlobalConfig;
  supervisorDir: string;
  statePath: string;
  sessionId: string;
  eventQueue: EventQueue;
  activityLog: ActivityLog;
}

/**
 * The core autonomous loop. At each iteration:
 * 1. Drain events from the queue
 * 2. Build a prompt with context + memory + events
 * 3. Call sdk.query() for Claude to reason and act
 * 4. Extract and save updated memory
 * 5. Log activity
 * 6. Wait for the next event or idle timeout
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

  constructor(options: HeartbeatLoopOptions) {
    this.config = options.config;
    this.supervisorDir = options.supervisorDir;
    this.statePath = options.statePath;
    this.sessionId = options.sessionId;
    this.eventQueue = options.eventQueue;
    this.activityLog = options.activityLog;
  }

  async start(): Promise<void> {
    await this.activityLog.log("heartbeat", "Supervisor heartbeat loop started");

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
            this.config.supervisor.idleIntervalMs *
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
      await this.eventQueue.waitForEvent(this.config.supervisor.idleIntervalMs);
    }

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

    // Check supervisor daily budget
    const state = await this.readState();
    const today = new Date().toISOString().slice(0, 10);
    const todayCost = state?.costResetDate === today ? (state.todayCostUsd ?? 0) : 0;

    if (todayCost >= this.config.supervisor.dailyCapUsd) {
      await this.activityLog.log(
        "error",
        `Supervisor daily budget exceeded ($${todayCost.toFixed(2)} / $${this.config.supervisor.dailyCapUsd}). Skipping heartbeat.`,
      );
      await this.sleep(this.config.supervisor.idleIntervalMs);
      return;
    }

    // Drain events
    const events = this.eventQueue.drain();

    // Load memory
    const memory = await loadMemory(this.supervisorDir);
    const memoryCheck = checkMemorySize(memory);

    // Build prompt
    const mcpServerNames = this.config.mcpServers ? Object.keys(this.config.mcpServers) : [];

    const prompt = buildHeartbeatPrompt({
      repos: this.config.repos,
      memory,
      memorySizeKB: memoryCheck.sizeKB,
      events,
      budgetStatus: {
        todayUsd: todayCost,
        capUsd: this.config.supervisor.dailyCapUsd,
        remainingPct:
          ((this.config.supervisor.dailyCapUsd - todayCost) / this.config.supervisor.dailyCapUsd) *
          100,
      },
      activeRuns: [], // TODO: read from persisted runs
      heartbeatCount: state?.heartbeatCount ?? 0,
      mcpServerNames,
    });

    await this.activityLog.log("heartbeat", `Heartbeat #${state?.heartbeatCount ?? 0} starting`, {
      heartbeatId,
      eventCount: events.length,
      triggeredBy: events.map((e) => e.kind),
    });

    // Call SDK with timeout + shutdown abort
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

      const queryOptions: Record<string, unknown> = {
        cwd: homedir(),
        maxTurns: 50,
        allowedTools: ["Bash", "Read"],
      };

      // Resume session if we have one (not on first heartbeat)
      if (state?.heartbeatCount && state.heartbeatCount > 0) {
        queryOptions.resume = this.sessionId;
      } else {
        queryOptions.sessionId = this.sessionId;
      }

      // Pass MCP servers if configured
      if (this.config.mcpServers) {
        const servers = Object.entries(this.config.mcpServers).map(([name, cfg]) => ({
          name,
          ...cfg,
        }));
        if (servers.length > 0) {
          queryOptions.mcpServers = servers;
        }
      }

      const stream = sdk.query({ prompt, options: queryOptions as never });

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        const msg = message as SDKStreamMessage;

        if (msg.type === "system" && msg.subtype === "init") {
          this.sessionId = msg.session_id as string;
        }

        if (msg.type === "result") {
          output = (msg.result as string) ?? "";
          costUsd = (msg.total_cost_usd as number) ?? 0;
          turnCount = (msg.num_turns as number) ?? 0;
        }

        // Log streaming events for TUI visibility
        if (msg.type === "assistant" && msg.subtype === "tool_use") {
          await this.activityLog.log("action", `Tool use: ${String(msg.tool ?? "unknown")}`, {
            heartbeatId,
            tool: msg.tool,
          });
        }
      }
    } finally {
      clearTimeout(timeout);
      this.activeAbort = null;
    }

    // Extract and save memory
    const newMemory = extractMemoryFromResponse(output);
    if (newMemory) {
      await saveMemory(this.supervisorDir, newMemory);
    }

    // Update state
    const durationMs = Date.now() - startTime;
    await this.updateState({
      sessionId: this.sessionId,
      lastHeartbeat: new Date().toISOString(),
      heartbeatCount: (state?.heartbeatCount ?? 0) + 1,
      totalCostUsd: (state?.totalCostUsd ?? 0) + costUsd,
      todayCostUsd: todayCost + costUsd,
      costResetDate: today,
    });

    await this.activityLog.log(
      "heartbeat",
      `Heartbeat #${(state?.heartbeatCount ?? 0) + 1} complete`,
      {
        heartbeatId,
        costUsd,
        durationMs,
        turnCount,
        memoryUpdated: !!newMemory,
        responseSummary: output.slice(0, 500),
      },
    );
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
