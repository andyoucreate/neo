/**
 * HeartbeatErrorBoundary consolidates the 3 levels of error handling in HeartbeatLoop:
 *
 * 1. Global error boundary (runHeartbeat try/catch) - emits heartbeat:failure event
 * 2. Circuit breaker (start() loop) - exponential backoff after consecutive failures
 * 3. Helper error handling - silent catches for non-critical operations
 *
 * This class provides a unified interface for emit/log/escalate operations
 * while preserving the existing error recovery behavior (ADR-020 compliant).
 */

import type { ActivityLog } from "./activity-log.js";
import type { HeartbeatFailureEvent, SupervisorWebhookEvent } from "./webhookEvents.js";

/** Error severity levels for categorizing failures */
export type ErrorSeverity = "critical" | "recoverable" | "silent";

/** Context for error handling decisions */
export interface ErrorContext {
  heartbeatId: string;
  consecutiveFailures: number;
  error: unknown;
  source: string;
}

/** Result of circuit breaker evaluation */
export interface CircuitBreakerResult {
  shouldBackoff: boolean;
  backoffMs: number;
}

/** Configuration for the error boundary */
export interface ErrorBoundaryConfig {
  maxConsecutiveFailures: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

/** Callback for emitting webhook events */
export type WebhookEmitter = (event: SupervisorWebhookEvent) => void | Promise<void>;

/**
 * HeartbeatErrorBoundary provides centralized error handling for the HeartbeatLoop.
 *
 * It consolidates three levels of error handling:
 * - emit(): Emits webhook events for external visibility
 * - log(): Logs errors to activity log for observability
 * - escalate(): Determines circuit breaker behavior for recovery
 *
 * Usage:
 * ```ts
 * const boundary = new HeartbeatErrorBoundary(activityLog, config, onWebhookEvent);
 *
 * // In runHeartbeat catch block:
 * await boundary.handleHeartbeatError(context);
 *
 * // In start() loop for circuit breaker:
 * const result = boundary.evaluateCircuitBreaker(consecutiveFailures);
 *
 * // For silent helper errors:
 * boundary.handleSilentError('readState', error);
 * ```
 */
export class HeartbeatErrorBoundary {
  private readonly activityLog: ActivityLog;
  private readonly config: ErrorBoundaryConfig;
  private readonly onWebhookEvent: WebhookEmitter | undefined;
  private readonly supervisorId: string;

  constructor(
    activityLog: ActivityLog,
    config: ErrorBoundaryConfig,
    supervisorId: string,
    onWebhookEvent?: WebhookEmitter,
  ) {
    this.activityLog = activityLog;
    this.config = config;
    this.supervisorId = supervisorId;
    this.onWebhookEvent = onWebhookEvent;
  }

  /**
   * Handle a critical heartbeat error (Level 1 - Global error boundary).
   *
   * This is called when runHeartbeat() throws an error. It:
   * 1. Emits a heartbeat:failure webhook event for external visibility
   * 2. Logs the error to the activity log
   *
   * The error is NOT suppressed - it is re-thrown to allow the circuit
   * breaker in start() to handle recovery.
   */
  async handleHeartbeatError(context: ErrorContext): Promise<void> {
    const errorMsg = this.normalizeError(context.error);

    // Emit failure event for external visibility (best-effort)
    await this.emit({
      type: "heartbeat_failure",
      supervisorId: this.supervisorId,
      heartbeatId: context.heartbeatId,
      timestamp: new Date().toISOString(),
      error: errorMsg.slice(0, 1000), // Truncate to schema max
      consecutiveFailures: context.consecutiveFailures,
    });

    // Log to activity log
    await this.log("error", `Heartbeat failed: ${errorMsg}`, {
      heartbeatId: context.heartbeatId,
      source: context.source,
      consecutiveFailures: context.consecutiveFailures,
    });
  }

  /**
   * Evaluate circuit breaker state (Level 2 - Circuit breaker).
   *
   * Returns whether to back off and for how long based on consecutive failures.
   * Uses exponential backoff with a max cap.
   */
  evaluateCircuitBreaker(consecutiveFailures: number): CircuitBreakerResult {
    if (consecutiveFailures < this.config.maxConsecutiveFailures) {
      return { shouldBackoff: false, backoffMs: 0 };
    }

    const exponent = consecutiveFailures - this.config.maxConsecutiveFailures;
    const backoffMs = Math.min(this.config.baseBackoffMs * 2 ** exponent, this.config.maxBackoffMs);

    return { shouldBackoff: true, backoffMs };
  }

  /**
   * Log circuit breaker activation.
   */
  async logCircuitBreaker(consecutiveFailures: number, backoffMs: number): Promise<void> {
    await this.log(
      "error",
      `Circuit breaker: backing off ${Math.round(backoffMs / 1000)}s after ${consecutiveFailures} failures`,
    );
  }

  /**
   * Handle a silent/recoverable error from helpers (Level 3 - Silent catches).
   *
   * These errors are logged at debug level and don't affect the heartbeat flow.
   * Examples: memory store initialization, state file read/write, etc.
   */
  handleSilentError(source: string, error: unknown): void {
    const errorMsg = this.normalizeError(error);
    // Silent errors are logged to console.debug only - they don't propagate
    // biome-ignore lint/suspicious/noConsole: Debug logging for silent errors
    console.debug(`[neo] Silent error in ${source}: ${errorMsg}`);
  }

  /**
   * Handle a recoverable error that should be logged but not fail the heartbeat.
   *
   * These errors are logged to the activity log for visibility but don't
   * interrupt the heartbeat flow.
   */
  async handleRecoverableError(
    source: string,
    error: unknown,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const errorMsg = this.normalizeError(error);
    await this.log("error", `${source} failed: ${errorMsg}`, detail);
  }

  /**
   * Emit a webhook event (best-effort, never throws).
   */
  private async emit(event: HeartbeatFailureEvent): Promise<void> {
    if (!this.onWebhookEvent) return;

    try {
      await this.onWebhookEvent(event);
    } catch {
      // Emission failed - log to console.debug and continue
      // biome-ignore lint/suspicious/noConsole: Debug logging for emission failure
      console.debug(`[neo] Webhook event emission failed for ${event.type}`);
    }
  }

  /**
   * Log to the activity log (best-effort, never throws).
   */
  private async log(
    level: "error" | "warning",
    message: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.activityLog.log(level, message, detail);
    } catch {
      // Log failed - fallback to console.debug
      // biome-ignore lint/suspicious/noConsole: Debug fallback for log failure
      console.debug(`[neo] Activity log failed: ${message}`);
    }
  }

  /**
   * Normalize an error to a string message.
   */
  private normalizeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return String(error);
  }

  /**
   * Classify error severity based on the error type and source.
   *
   * This is used to determine the appropriate handling strategy:
   * - critical: Fails the heartbeat, triggers circuit breaker
   * - recoverable: Logged but heartbeat continues
   * - silent: Only debug logged, no interruption
   */
  classifyError(source: string, error: unknown): ErrorSeverity {
    const errorMsg = this.normalizeError(error);

    // SDK errors are critical - they prevent the heartbeat from completing
    if (source === "sdk" || source === "runHeartbeat") {
      return "critical";
    }

    // State/store errors are recoverable - heartbeat can continue with defaults
    if (
      source === "readState" ||
      source === "updateState" ||
      source === "getMemoryStore" ||
      source === "getTaskStore" ||
      source === "getDirectiveStore"
    ) {
      return "silent";
    }

    // File system errors might be transient
    if (errorMsg.includes("ENOENT") || errorMsg.includes("EACCES")) {
      return "recoverable";
    }

    // Default to recoverable for unknown errors
    return "recoverable";
  }
}
