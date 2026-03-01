import {
  RATE_LIMIT_WARNING_THRESHOLD,
  RATE_LIMIT_BACKOFF_MS,
} from "./config.js";
import { logger } from "./logger.js";

interface RateLimitState {
  isThrottled: boolean;
  throttledUntil: number;
  consecutiveHits: number;
  lastHitAt: number;
  totalHits: number;
}

/**
 * Proactive rate limiter for the Claude Agent SDK.
 * Monitors rate limit signals and applies progressive backoff.
 */
export class RateLimiter {
  private readonly warningThreshold: number;
  private readonly backoffSchedule: readonly number[];
  private state: RateLimitState = {
    isThrottled: false,
    throttledUntil: 0,
    consecutiveHits: 0,
    lastHitAt: 0,
    totalHits: 0,
  };

  constructor(
    warningThreshold = RATE_LIMIT_WARNING_THRESHOLD,
    backoffSchedule = RATE_LIMIT_BACKOFF_MS,
  ) {
    this.warningThreshold = warningThreshold;
    this.backoffSchedule = backoffSchedule;
  }

  /**
   * Record a rate limit signal from the SDK.
   * Returns the recommended backoff time in ms.
   */
  recordRateLimitHit(): number {
    const now = Date.now();
    this.state.lastHitAt = now;
    this.state.totalHits++;

    // Reset consecutive count if last hit was >5 min ago
    if (now - this.state.lastHitAt > 300_000) {
      this.state.consecutiveHits = 0;
    }
    this.state.consecutiveHits++;

    const backoffIndex = Math.min(
      this.state.consecutiveHits - 1,
      this.backoffSchedule.length - 1,
    );
    const backoffMs = this.backoffSchedule[backoffIndex]!;

    this.state.isThrottled = true;
    this.state.throttledUntil = now + backoffMs;

    logger.warn(
      `Rate limit hit #${this.state.consecutiveHits}. Backing off ${backoffMs}ms`,
    );

    return backoffMs;
  }

  /**
   * Check if we should proactively throttle new dispatches.
   * Uses warning threshold to preempt actual rate limits.
   */
  shouldThrottle(currentLoad: number, maxCapacity: number): boolean {
    // If actively throttled, check if cooldown expired
    if (this.state.isThrottled) {
      if (Date.now() >= this.state.throttledUntil) {
        this.state.isThrottled = false;
        this.state.consecutiveHits = 0;
        logger.info("Rate limit throttle expired");
      } else {
        return true;
      }
    }

    // Proactive throttling at warning threshold
    const utilization = maxCapacity > 0 ? currentLoad / maxCapacity : 0;
    if (utilization >= this.warningThreshold && this.state.totalHits > 0) {
      logger.info(
        `Proactive throttle: ${(utilization * 100).toFixed(0)}% capacity with rate limit history`,
      );
      return true;
    }

    return false;
  }

  /**
   * Wait for the current throttle to expire.
   */
  async waitForClearance(): Promise<void> {
    if (!this.state.isThrottled) return;

    const waitMs = this.state.throttledUntil - Date.now();
    if (waitMs <= 0) {
      this.state.isThrottled = false;
      return;
    }

    logger.info(`Waiting ${waitMs}ms for rate limit clearance`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.state.isThrottled = false;
    this.state.consecutiveHits = 0;
  }

  /**
   * Get current rate limiter state for status reporting.
   */
  getState(): Readonly<RateLimitState> {
    return { ...this.state };
  }

  /**
   * Reset state (for testing).
   */
  reset(): void {
    this.state = {
      isThrottled: false,
      throttledUntil: 0,
      consecutiveHits: 0,
      lastHitAt: 0,
      totalHits: 0,
    };
  }
}
