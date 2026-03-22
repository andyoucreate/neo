import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GlobalConfig } from "@/config";
import { getSupervisorDecisionsPath, getSupervisorDir } from "@/paths";
import { isProcessAlive } from "@/shared/process";
import { ActivityLog } from "./activity-log.js";
import { DecisionStore } from "./decisions.js";
import { EventQueue } from "./event-queue.js";
import { HeartbeatLoop } from "./heartbeat.js";
import type { SupervisorDaemonState, WebhookIncomingEvent } from "./schemas.js";
import { WebhookServer } from "./webhook-server.js";

export interface SupervisorDaemonOptions {
  name: string;
  config: GlobalConfig;
  /** Path to bundled default SUPERVISOR.md (e.g. from @neotx/agents) */
  defaultInstructionsPath?: string | undefined;
}

/**
 * Orchestrates all supervisor components: webhook server, event queue,
 * heartbeat loop, memory, and activity logging.
 */
export class SupervisorDaemon {
  private readonly name: string;
  private readonly config: GlobalConfig;
  private readonly dir: string;
  private readonly defaultInstructionsPath: string | undefined;
  private webhookServer: WebhookServer | null = null;
  private eventQueue: EventQueue | null = null;
  private heartbeatLoop: HeartbeatLoop | null = null;
  private activityLog: ActivityLog | null = null;
  private decisionStore: DecisionStore | null = null;
  private sessionId = "";

  constructor(options: SupervisorDaemonOptions) {
    this.name = options.name;
    this.config = options.config;
    this.dir = getSupervisorDir(options.name);
    this.defaultInstructionsPath = options.defaultInstructionsPath;
  }

  async start(): Promise<void> {
    // Create supervisor directory
    await mkdir(this.dir, { recursive: true });

    // Check lockfile for duplicate daemons
    const lockPath = path.join(this.dir, "daemon.lock");
    if (existsSync(lockPath)) {
      const lockPid = await this.readLockPid(lockPath);
      if (lockPid && isProcessAlive(lockPid)) {
        throw new Error(
          `Supervisor "${this.name}" already running (PID ${lockPid}). Use --kill first.`,
        );
      }
      // Stale lock — clean up
      await rm(lockPath, { force: true });
    }

    // Write lockfile atomically
    const tempLock = `${lockPath}.${process.pid}`;
    await writeFile(tempLock, String(process.pid), "utf-8");
    const { rename } = await import("node:fs/promises");
    await rename(tempLock, lockPath);

    // Recover session ID from previous state or generate new one
    const existingState = await this.readState();
    const isSessionContinuation = existingState?.sessionId && existingState.status !== "stopped";
    if (isSessionContinuation) {
      this.sessionId = existingState.sessionId;
    } else {
      this.sessionId = randomUUID();
      // SessionId changed — mark all running persisted runs as orphaned
      if (existingState?.sessionId && existingState.sessionId !== this.sessionId) {
        await this.markOrphanedRunsFromSessionMismatch(existingState.sessionId, this.sessionId);
      }
    }

    // Initialize activity log
    this.activityLog = new ActivityLog(this.dir);

    // Initialize decision store
    this.decisionStore = new DecisionStore(getSupervisorDecisionsPath(this.name));

    // Initialize event queue
    this.eventQueue = new EventQueue({
      maxEventsPerSec: this.config.supervisor.maxEventsPerSec,
    });

    // Replay unprocessed events from disk
    const inboxPath = path.join(this.dir, "inbox.jsonl");
    const eventsPath = path.join(this.dir, "events.jsonl");
    await this.eventQueue.replayUnprocessed(inboxPath, eventsPath);

    // Start file watching
    await this.eventQueue.startWatching(inboxPath, eventsPath);

    // Start webhook server
    this.webhookServer = new WebhookServer({
      port: this.config.supervisor.port,
      secret: this.config.supervisor.secret,
      eventsPath,
      onEvent: (event) => {
        this.eventQueue?.push({ kind: "webhook", data: event });

        // Handle decision:answer webhook events
        this.handleDecisionAnswer(event).catch((err) => {
          this.activityLog?.log(
            "error",
            `Failed to handle decision:answer: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        // Convert session:complete/session:fail webhooks into run_complete events
        // so the heartbeat gets a structured signal that a run finished
        if (
          (event.event === "session:complete" || event.event === "session:fail") &&
          event.payload
        ) {
          const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
          if (runId) {
            this.eventQueue?.push({
              kind: "run_complete",
              runId,
              timestamp: event.receivedAt,
            });
          }
        }
      },
      getHealth: () => this.getHealthInfo(),
    });
    await this.webhookServer.start();

    // Write initial state
    await this.writeState({
      pid: process.pid,
      sessionId: this.sessionId,
      port: this.config.supervisor.port,
      cwd: homedir(),
      startedAt: new Date().toISOString(),
      lastHeartbeat: existingState?.lastHeartbeat,
      heartbeatCount: existingState?.heartbeatCount ?? 0,
      totalCostUsd: existingState?.totalCostUsd ?? 0,
      todayCostUsd: existingState?.todayCostUsd ?? 0,
      costResetDate: existingState?.costResetDate,
      idleSkipCount: existingState?.idleSkipCount ?? 0,
      activeWorkSkipCount: existingState?.activeWorkSkipCount ?? 0,
      status: "running",
      lastConsolidationHeartbeat: existingState?.lastConsolidationHeartbeat ?? 0,
      lastCompactionHeartbeat: existingState?.lastCompactionHeartbeat ?? 0,
      lastConsolidationTimestamp: existingState?.lastConsolidationTimestamp,
    });

    // Install signal handlers
    const shutdown = () => {
      // biome-ignore lint/suspicious/noConsole: Intentional daemon logging for signal handler errors
      this.stop().catch(console.error);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await this.activityLog.log(
      "event",
      `Supervisor "${this.name}" started on port ${this.config.supervisor.port}`,
    );

    // Start heartbeat loop (blocks until stopped)
    const statePath = path.join(this.dir, "state.json");
    this.heartbeatLoop = new HeartbeatLoop({
      config: this.config,
      supervisorDir: this.dir,
      statePath,
      sessionId: this.sessionId,
      eventQueue: this.eventQueue,
      activityLog: this.activityLog,
      eventsPath,
      defaultInstructionsPath: this.defaultInstructionsPath,
    });

    await this.heartbeatLoop.start();
  }

  async stop(): Promise<void> {
    this.heartbeatLoop?.stop();
    this.eventQueue?.stopWatching();

    if (this.webhookServer) {
      await this.webhookServer.stop();
    }

    // Update state
    const state = await this.readState();
    if (state) {
      state.status = "stopped";
      await this.writeState(state);
    }

    // Remove lockfile
    const lockPath = path.join(this.dir, "daemon.lock");
    await rm(lockPath, { force: true });

    if (this.activityLog) {
      await this.activityLog.log("event", `Supervisor "${this.name}" stopped`);
    }
  }

  private getHealthInfo(): Record<string, unknown> {
    return {
      status: "ok",
      name: this.name,
      pid: process.pid,
      uptime: process.uptime(),
      sessionId: this.sessionId,
      port: this.config.supervisor.port,
    };
  }

  private async readState(): Promise<SupervisorDaemonState | null> {
    const statePath = path.join(this.dir, "state.json");
    try {
      const raw = await readFile(statePath, "utf-8");
      return JSON.parse(raw) as SupervisorDaemonState;
    } catch (err) {
      // State file not found or corrupted — treat as no previous state
      console.debug(
        `[SupervisorDaemon] Failed to read state: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async writeState(state: SupervisorDaemonState): Promise<void> {
    const statePath = path.join(this.dir, "state.json");
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  private async readLockPid(lockPath: string): Promise<number | null> {
    try {
      const raw = await readFile(lockPath, "utf-8");
      const pid = Number.parseInt(raw.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch (err) {
      // Lock file not found or unreadable — no lock exists
      console.debug(
        `[SupervisorDaemon] Failed to read lock PID from ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Handle decision:answer webhook events.
   * Extracts decisionId and answer from the payload and records the answer.
   */
  private async handleDecisionAnswer(event: WebhookIncomingEvent): Promise<void> {
    if (event.event !== "decision:answer") return;
    if (!this.decisionStore || !event.payload) return;

    const decisionId =
      typeof event.payload.decisionId === "string" ? event.payload.decisionId : undefined;
    const answer = typeof event.payload.answer === "string" ? event.payload.answer : undefined;

    if (!decisionId || !answer) {
      await this.activityLog?.log(
        "error",
        `decision:answer webhook missing required fields (decisionId: ${decisionId}, answer: ${answer})`,
      );
      return;
    }

    try {
      await this.decisionStore.answer(decisionId, answer);
      await this.activityLog?.log(
        "decision",
        `Decision ${decisionId} answered via webhook: "${answer}"`,
      );
    } catch (err) {
      await this.activityLog?.log(
        "error",
        `Failed to answer decision ${decisionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Mark all running persisted runs as orphaned when supervisor sessionId changes.
   * This handles the case where supervisor crashes and restarts with a new sessionId,
   * preventing ghost runs from being incorrectly marked as active.
   */
  private async markOrphanedRunsFromSessionMismatch(
    oldSessionId: string,
    newSessionId: string,
  ): Promise<void> {
    try {
      const { getRunsDir } = await import("@/paths");
      const runsDir = getRunsDir();
      if (!existsSync(runsDir)) return;

      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(runsDir, { withFileTypes: true });
      let orphanedCount = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(runsDir, entry.name);
        orphanedCount += await this.markOrphanedRunsInDirectory(subDir, oldSessionId);
      }

      if (orphanedCount > 0) {
        await this.activityLog?.log(
          "event",
          `SessionId mismatch detected (${oldSessionId} → ${newSessionId}): marked ${orphanedCount} runs as orphaned`,
        );
      }
    } catch {
      // Non-critical — don't fail startup
    }
  }

  /**
   * Mark orphaned runs in a single directory.
   */
  private async markOrphanedRunsInDirectory(
    dirPath: string,
    oldSessionId: string,
  ): Promise<number> {
    const { readdir, readFile, writeFile } = await import("node:fs/promises");
    const files = await readdir(dirPath);
    let count = 0;

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const filePath = path.join(dirPath, f);
        const raw = await readFile(filePath, "utf-8");
        const run = JSON.parse(raw) as import("@/types").PersistedRun;

        if (
          (run.status === "running" || run.status === "paused") &&
          run.supervisorSessionId === oldSessionId
        ) {
          run.status = "failed";
          run.updatedAt = new Date().toISOString();
          await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
          count++;
        }
      } catch {
        // Corrupted or partial file — skip
      }
    }

    return count;
  }
}
