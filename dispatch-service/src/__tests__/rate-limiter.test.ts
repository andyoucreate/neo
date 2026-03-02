import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter(0.8, [1000, 2000, 5000]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recordRateLimitHit", () => {
    it("should return first backoff tier on first hit", () => {
      const backoff = limiter.recordRateLimitHit();
      expect(backoff).toBe(1000);
    });

    it("should escalate backoff on consecutive hits", () => {
      limiter.recordRateLimitHit();
      const backoff2 = limiter.recordRateLimitHit();
      expect(backoff2).toBe(2000);

      const backoff3 = limiter.recordRateLimitHit();
      expect(backoff3).toBe(5000);
    });

    it("should cap at max backoff tier", () => {
      limiter.recordRateLimitHit();
      limiter.recordRateLimitHit();
      limiter.recordRateLimitHit();
      const backoff = limiter.recordRateLimitHit();
      expect(backoff).toBe(5000);
    });

    it("should increment total hits", () => {
      limiter.recordRateLimitHit();
      limiter.recordRateLimitHit();
      expect(limiter.getState().totalHits).toBe(2);
    });
  });

  describe("shouldThrottle", () => {
    it("should not throttle when no rate limit history", () => {
      expect(limiter.shouldThrottle(4, 5)).toBe(false);
    });

    it("should throttle when actively in backoff", () => {
      limiter.recordRateLimitHit();
      expect(limiter.shouldThrottle(0, 5)).toBe(true);
    });

    it("should stop throttling after backoff expires", () => {
      limiter.recordRateLimitHit(); // 1000ms backoff
      vi.advanceTimersByTime(1001);
      expect(limiter.shouldThrottle(0, 5)).toBe(false);
    });

    it("should proactively throttle at high utilization with rate limit history", () => {
      limiter.recordRateLimitHit(); // 1000ms backoff
      vi.advanceTimersByTime(1001); // Let backoff expire
      // shouldThrottle clears isThrottled, but totalHits remains > 0
      limiter.shouldThrottle(0, 5); // clear throttle

      // Now: not actively throttled, but totalHits > 0
      // High utilization (4/5 = 80%) + rate limit history → should throttle
      expect(limiter.shouldThrottle(4, 5)).toBe(true);
    });

    it("should not throttle at low utilization even with rate limit history", () => {
      limiter.recordRateLimitHit(); // 1000ms backoff
      vi.advanceTimersByTime(1001);
      limiter.shouldThrottle(0, 5); // clear throttle

      // Low utilization (1/5 = 20%) — should not trigger proactive throttle
      expect(limiter.shouldThrottle(1, 5)).toBe(false);
    });
  });

  describe("waitForClearance", () => {
    it("should resolve immediately when not throttled", async () => {
      await limiter.waitForClearance();
      // No assertion needed — just verifying it doesn't hang
    });

    it("should wait until throttle expires", async () => {
      limiter.recordRateLimitHit(); // 1000ms backoff

      const promise = limiter.waitForClearance();
      vi.advanceTimersByTime(1001);
      await promise;

      expect(limiter.getState().isThrottled).toBe(false);
    });
  });

  describe("getState", () => {
    it("should return a snapshot of current state", () => {
      const state = limiter.getState();
      expect(state.isThrottled).toBe(false);
      expect(state.consecutiveHits).toBe(0);
      expect(state.totalHits).toBe(0);
    });

    it("should reflect state after hits", () => {
      limiter.recordRateLimitHit();
      const state = limiter.getState();
      expect(state.isThrottled).toBe(true);
      expect(state.consecutiveHits).toBe(1);
      expect(state.totalHits).toBe(1);
    });
  });

  describe("reset", () => {
    it("should clear all state", () => {
      limiter.recordRateLimitHit();
      limiter.recordRateLimitHit();
      limiter.reset();

      const state = limiter.getState();
      expect(state.isThrottled).toBe(false);
      expect(state.consecutiveHits).toBe(0);
      expect(state.totalHits).toBe(0);
    });
  });
});
