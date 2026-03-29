import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { removeSessionClone } from "@/isolation/clone";
import type { PersistedRun } from "@/types";
import type { ActivityLog } from "./activity-log.js";

// ─── Constants ──────────────────────────────────────────

const GRACEFUL_TIMEOUT_MS = 30_000; // 30 seconds for graceful shutdown
const FORCE_KILL_DELAY_MS = 5_000; // 5 seconds before SIGKILL after SIGTERM

// ─── Types ──────────────────────────────────────────────

export interface ShutdownOptions {
  /** Activity log for recording shutdown events */
  activityLog?: ActivityLog | undefined;
  /** Callback to invoke before shutdown begins */
  onShutdownStart?: () => void | Promise<void>;
  /** Callback to invoke after shutdown completes */
  onShutdownComplete?: () => void | Promise<void>;
  /** Timeout in milliseconds for graceful shutdown (default: 30s) */
  timeoutMs?: number | undefined;
}

export interface ShutdownContext {
  /** Active child processes to terminate */
  childProcesses: Set<ChildProcess>;
  /** Active session clone paths to clean up */
  sessionPaths: Set<string>;
  /** Pending write operations to flush */
  pendingWrites: Set<Promise<void>>;
  /** Runs directory for marking runs as failed */
  runsDir?: string | undefined;
}

export type ShutdownHandler = () => Promise<void>;

// ─── ShutdownManager ────────────────────────────────────

/**
 * Manages graceful shutdown for daemon and supervisor processes.
 *
 * Handles:
 * - SIGTERM and SIGINT signals
 * - Session clone cleanup
 * - Flushing pending writes
 * - Graceful child process termination
 *
 * Usage:
 * ```ts
 * const shutdown = new ShutdownManager({ activityLog });
 * shutdown.registerChildProcess(child);
 * shutdown.registerSession('/path/to/session');
 * shutdown.trackWrite(writePromise);
 * shutdown.install();
 * ```
 */
export class ShutdownManager {
  private readonly options: ShutdownOptions;
  private readonly context: ShutdownContext;
  private readonly handlers: Set<ShutdownHandler> = new Set();
  private isShuttingDown = false;
  private signalHandlersInstalled = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: ShutdownOptions = {}) {
    this.options = {
      timeoutMs: GRACEFUL_TIMEOUT_MS,
      ...options,
    };
    this.context = {
      childProcesses: new Set(),
      sessionPaths: new Set(),
      pendingWrites: new Set(),
    };
  }

  // ─── Registration ──────────────────────────────────────

  /**
   * Register a child process for graceful termination during shutdown.
   */
  registerChildProcess(child: ChildProcess): void {
    this.context.childProcesses.add(child);
    child.once("exit", () => {
      this.context.childProcesses.delete(child);
    });
  }

  /**
   * Unregister a child process (e.g., after it has been terminated elsewhere).
   */
  unregisterChildProcess(child: ChildProcess): void {
    this.context.childProcesses.delete(child);
  }

  /**
   * Register a session clone path for cleanup during shutdown.
   */
  registerSession(sessionPath: string): void {
    this.context.sessionPaths.add(sessionPath);
  }

  /**
   * Unregister a session clone (e.g., after it has been cleaned up elsewhere).
   */
  unregisterSession(sessionPath: string): void {
    this.context.sessionPaths.delete(sessionPath);
  }

  /**
   * Track a pending write operation to flush during shutdown.
   * The promise is automatically removed when it settles.
   */
  trackWrite(writePromise: Promise<void>): void {
    this.context.pendingWrites.add(writePromise);
    writePromise.finally(() => {
      this.context.pendingWrites.delete(writePromise);
    });
  }

  /**
   * Register a custom shutdown handler.
   * Handlers are called in registration order during shutdown.
   */
  registerHandler(handler: ShutdownHandler): void {
    this.handlers.add(handler);
  }

  /**
   * Unregister a custom shutdown handler.
   */
  unregisterHandler(handler: ShutdownHandler): void {
    this.handlers.delete(handler);
  }

  /**
   * Set the runs directory for marking orphaned runs as failed.
   */
  setRunsDir(dir: string): void {
    this.context.runsDir = dir;
  }

  // ─── Installation ──────────────────────────────────────

  /**
   * Install signal handlers for SIGTERM and SIGINT.
   * Safe to call multiple times; handlers are only installed once.
   */
  install(): void {
    if (this.signalHandlersInstalled) return;

    const handler = (signal: string) => {
      this.initiateShutdown(signal).catch((error) => {
        // biome-ignore lint/suspicious/noConsole: Intentional daemon logging for shutdown errors
        console.error(`Shutdown error (${signal}):`, error);
        process.exit(1);
      });
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));

    this.signalHandlersInstalled = true;
  }

  /**
   * Manually trigger shutdown (e.g., from a stop() method).
   * Returns a promise that resolves when shutdown is complete.
   */
  async shutdown(): Promise<void> {
    return this.initiateShutdown("manual");
  }

  // ─── Status ────────────────────────────────────────────

  /**
   * Check if shutdown is in progress.
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  // ─── Internal ──────────────────────────────────────────

  private async initiateShutdown(signal: string): Promise<void> {
    // Ensure shutdown only runs once
    if (this.isShuttingDown) {
      return this.shutdownPromise ?? Promise.resolve();
    }

    this.isShuttingDown = true;
    this.shutdownPromise = this.executeShutdown(signal);
    return this.shutdownPromise;
  }

  private async executeShutdown(signal: string): Promise<void> {
    const { activityLog, onShutdownStart, onShutdownComplete, timeoutMs } = this.options;

    await activityLog?.log("event", `Shutdown initiated (${signal})`);
    await onShutdownStart?.();

    // Race shutdown tasks against timeout
    const shutdownTasks = this.runShutdownTasks();
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        activityLog?.log("error", `Shutdown timeout (${timeoutMs}ms) exceeded, forcing exit`);
        resolve();
      }, timeoutMs);
    });

    await Promise.race([shutdownTasks, timeout]);

    await activityLog?.log("event", "Shutdown complete");
    await onShutdownComplete?.();
  }

  private async runShutdownTasks(): Promise<void> {
    const { activityLog } = this.options;
    const { childProcesses, sessionPaths, pendingWrites, runsDir } = this.context;

    // Phase 1: Run custom handlers
    for (const handler of this.handlers) {
      try {
        await handler();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await activityLog?.log("error", `Shutdown handler failed: ${msg}`);
      }
    }

    // Phase 2: Flush pending writes
    if (pendingWrites.size > 0) {
      await activityLog?.log("event", `Flushing ${pendingWrites.size} pending write(s)`);
      await Promise.allSettled([...pendingWrites]);
    }

    // Phase 3: Mark orphaned runs as failed
    if (runsDir) {
      await this.markOrphanedRunsFailed(runsDir, activityLog);
    }

    // Phase 4: Terminate child processes gracefully
    if (childProcesses.size > 0) {
      await activityLog?.log("event", `Terminating ${childProcesses.size} child process(es)`);
      await this.terminateChildProcesses([...childProcesses], activityLog);
    }

    // Phase 5: Clean up session clones
    if (sessionPaths.size > 0) {
      await activityLog?.log("event", `Cleaning up ${sessionPaths.size} session clone(s)`);
      await this.cleanupSessions([...sessionPaths], activityLog);
    }
  }

  private async terminateChildProcesses(
    processes: ChildProcess[],
    activityLog?: ActivityLog,
  ): Promise<void> {
    const terminations = processes.map(async (child) => {
      if (child.killed || child.exitCode !== null) {
        return; // Already terminated
      }

      const pid = child.pid;

      // Send SIGTERM first
      child.kill("SIGTERM");

      // Wait for graceful exit or force kill
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            activityLog?.log("event", `Force killing child process ${pid}`);
            child.kill("SIGKILL");
          }
          resolve();
        }, FORCE_KILL_DELAY_MS);

        child.once("exit", () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    });

    await Promise.allSettled(terminations);
  }

  private async cleanupSessions(paths: string[], activityLog?: ActivityLog): Promise<void> {
    const cleanups = paths.map(async (sessionPath) => {
      try {
        await removeSessionClone(sessionPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await activityLog?.log("error", `Failed to cleanup session clone ${sessionPath}: ${msg}`);
      }
    });

    await Promise.allSettled(cleanups);
  }

  private async markOrphanedRunsFailed(runsDir: string, activityLog?: ActivityLog): Promise<void> {
    if (!existsSync(runsDir)) return;

    try {
      const entries = await readdir(runsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const subDir = path.join(runsDir, entry.name);
        const files = await readdir(subDir);

        for (const file of files) {
          if (!file.endsWith(".json")) continue;

          const filePath = path.join(subDir, file);
          await this.markRunAsFailed(filePath, activityLog);
        }
      }
    } catch {
      // Non-critical — best effort cleanup, silently ignore
    }
  }

  private async markRunAsFailed(filePath: string, activityLog?: ActivityLog): Promise<void> {
    try {
      const content = await readFile(filePath, "utf-8");
      const run = JSON.parse(content) as PersistedRun;

      if (run.status !== "running") return;

      // Only mark as failed if this process owns the run
      if (run.pid && run.pid !== process.pid) return;

      run.status = "failed";
      run.updatedAt = new Date().toISOString();
      await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");

      await activityLog?.log("event", `Marked orphaned run ${run.runId} as failed`);
    } catch {
      // Non-critical — file may be corrupt or locked, silently ignore
    }
  }
}

// ─── Utility Functions ──────────────────────────────────

/**
 * Create and install a shutdown manager with the given options.
 * Returns the manager for registration of resources.
 */
export function createShutdownManager(options: ShutdownOptions = {}): ShutdownManager {
  const manager = new ShutdownManager(options);
  manager.install();
  return manager;
}

/**
 * Wait for a child process to exit with a timeout.
 * Returns true if the process exited, false if timeout was reached.
 */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Send SIGTERM to a child process and wait for exit, then SIGKILL if needed.
 * Returns true if the process exited gracefully, false if force killed.
 */
export async function terminateGracefully(
  child: ChildProcess,
  gracePeriodMs: number = FORCE_KILL_DELAY_MS,
): Promise<boolean> {
  if (child.killed || child.exitCode !== null) {
    return true;
  }

  child.kill("SIGTERM");
  const exited = await waitForExit(child, gracePeriodMs);

  if (!exited) {
    child.kill("SIGKILL");
    await waitForExit(child, 1000);
    return false;
  }

  return true;
}
