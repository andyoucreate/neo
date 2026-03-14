import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GlobalConfig } from "@/config";
import { getDataDir } from "@/paths";
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

  private customInstructions: string | undefined;

  constructor(options: HeartbeatLoopOptions) {
    this.config = options.config;
    this.supervisorDir = options.supervisorDir;
    this.statePath = options.statePath;
    this.sessionId = options.sessionId;
    this.eventQueue = options.eventQueue;
    this.activityLog = options.activityLog;
  }

  async start(): Promise<void> {
    this.customInstructions = await this.loadInstructions();
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
      customInstructions: this.customInstructions,
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

      // Build allowed tools list — include MCP tool patterns for configured servers
      const allowedTools: string[] = ["Bash", "Read"];
      if (this.config.mcpServers) {
        for (const name of Object.keys(this.config.mcpServers)) {
          allowedTools.push(`mcp__${name}__*`);
        }
      }

      const queryOptions: Record<string, unknown> = {
        cwd: homedir(),
        maxTurns: 50,
        allowedTools,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      };

      // Each heartbeat starts a fresh session — resume is unreliable
      // because the previous query completed and the session may not
      // be resumable. The prompt already contains memory for continuity.

      // Pass MCP servers if configured
      if (this.config.mcpServers) {
        queryOptions.mcpServers = this.config.mcpServers;
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

        await this.logStreamMessage(msg, heartbeatId);
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

  /**
   * Load custom instructions from SUPERVISOR.md.
   * Resolution order:
   * 1. Explicit path via `supervisor.instructions` in config
   * 2. Default: ~/.neo/SUPERVISOR.md
   */
  private async loadInstructions(): Promise<string | undefined> {
    const candidates: string[] = [];

    if (this.config.supervisor.instructions) {
      candidates.push(path.resolve(this.config.supervisor.instructions));
    }

    candidates.push(path.join(getDataDir(), "SUPERVISOR.md"));

    for (const filePath of candidates) {
      try {
        const content = await readFile(filePath, "utf-8");
        await this.activityLog.log("event", `Loaded custom instructions from ${filePath}`);
        return content;
      } catch {
        // File not found — try next candidate
      }
    }

    return undefined;
  }

  /** Route a single SDK stream message to the appropriate log handler. */
  private async logStreamMessage(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    if (msg.type !== "assistant") return;

    if (!msg.subtype) {
      await this.logContentBlocks(msg, heartbeatId);
    } else if (msg.subtype === "tool_use") {
      await this.logToolUse(msg, heartbeatId);
    } else if (msg.subtype === "tool_result") {
      await this.logToolResult(msg, heartbeatId);
    }
  }

  /** Log thinking and plan blocks from assistant content. */
  private async logContentBlocks(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    const content = (
      msg.message as
        | { content?: Array<{ type: string; thinking?: string; text?: string }> }
        | undefined
    )?.content;
    if (!content) return;

    for (const block of content) {
      if (block.type === "thinking" && block.thinking) {
        await this.activityLog.log("thinking", block.thinking.slice(0, 500), { heartbeatId });
      }
      if (block.type === "text" && block.text) {
        await this.activityLog.log("plan", block.text.slice(0, 500), { heartbeatId });
        break; // Only log first text block per message
      }
    }
  }

  /** Log tool use events — distinguish MCP tools from built-in tools. */
  private async logToolUse(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    const toolName = String(msg.tool ?? "unknown");
    const isMcp = toolName.startsWith("mcp__");
    await this.activityLog.log(
      isMcp ? "tool_use" : "action",
      isMcp ? toolName : `Tool use: ${toolName}`,
      { heartbeatId, tool: toolName, input: msg.input },
    );
  }

  /** Detect agent dispatches from bash tool results. */
  private async logToolResult(msg: SDKStreamMessage, heartbeatId: string): Promise<void> {
    const result = String(msg.result ?? "");
    const runMatch = /Run\s+(\S+)\s+dispatched/i.exec(result);
    if (runMatch) {
      await this.activityLog.log("dispatch", `Agent dispatched: ${runMatch[1]}`, {
        heartbeatId,
        runId: runMatch[1],
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
