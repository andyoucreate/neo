import { CONCURRENCY_LIMITS } from "./config.js";
import { appendEvent } from "./event-journal.js";
import { logger } from "./logger.js";
import type { ActiveSession } from "./types.js";

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface WatchdogConfig {
  checkIntervalMs: number;
  sessionTimeoutMs: number;
}

export interface WatchdogCallbacks {
  getActiveSessions: () => Map<string, ActiveSession>;
  killSession: (sessionId: string) => void;
}

/**
 * Session timeout watchdog.
 * Periodically checks for sessions that have exceeded the timeout
 * and kills them to prevent resource exhaustion.
 */
export class SessionWatchdog {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly config: WatchdogConfig;
  private readonly callbacks: WatchdogCallbacks;

  constructor(callbacks: WatchdogCallbacks, config?: Partial<WatchdogConfig>) {
    this.callbacks = callbacks;
    this.config = {
      checkIntervalMs: config?.checkIntervalMs ?? 60_000, // Check every minute
      sessionTimeoutMs: config?.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    };
  }

  /**
   * Start the watchdog timer.
   */
  start(): void {
    if (this.intervalId !== null) {
      logger.warn("Watchdog already running");
      return;
    }

    logger.info(
      `Starting session watchdog (timeout: ${this.config.sessionTimeoutMs}ms, interval: ${this.config.checkIntervalMs}ms)`,
    );

    this.intervalId = setInterval(() => {
      this.checkSessions();
    }, this.config.checkIntervalMs);

    // Don't prevent process from exiting
    this.intervalId.unref();
  }

  /**
   * Stop the watchdog timer.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("Session watchdog stopped");
    }
  }

  /**
   * Check all active sessions for timeout.
   */
  private checkSessions(): void {
    const sessions = this.callbacks.getActiveSessions();
    const now = Date.now();
    let timedOutCount = 0;

    for (const [sessionId, session] of sessions) {
      const startTime = new Date(session.startedAt).getTime();
      const elapsed = now - startTime;

      if (elapsed > this.config.sessionTimeoutMs) {
        timedOutCount++;
        this.handleTimeout(sessionId, session, elapsed);
      }
    }

    if (timedOutCount > 0) {
      logger.warn(`Watchdog killed ${timedOutCount} timed-out session(s)`);
    }
  }

  /**
   * Handle a session that has timed out.
   */
  private handleTimeout(
    sessionId: string,
    session: ActiveSession,
    elapsedMs: number,
  ): void {
    logger.error(
      `Session ${sessionId} timed out after ${Math.round(elapsedMs / 1000 / 60)}min ` +
        `(pipeline: ${session.pipeline}, repo: ${session.repository})`,
    );

    appendEvent("session.timeout", {
      sessionId,
      pipeline: session.pipeline,
      repository: session.repository,
      ticketId: session.ticketId,
      prNumber: session.prNumber,
      elapsedMs,
      timeoutMs: this.config.sessionTimeoutMs,
    }).catch(() => {});

    this.callbacks.killSession(sessionId);
  }

  /**
   * Get the current watchdog configuration.
   */
  getConfig(): WatchdogConfig {
    return { ...this.config };
  }

  /**
   * Check if the watchdog is running.
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }
}

/**
 * Create a watchdog with default production settings.
 */
export function createWatchdog(callbacks: WatchdogCallbacks): SessionWatchdog {
  return new SessionWatchdog(callbacks, {
    sessionTimeoutMs: CONCURRENCY_LIMITS.sessionTimeoutMs,
  });
}
