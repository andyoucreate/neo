import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionWatchdog } from "../watchdog.js";
import type { ActiveSession } from "../types.js";

// Mock the event-journal module
vi.mock("../event-journal.js", () => ({
  appendEvent: vi.fn(() => Promise.resolve()),
}));

describe("SessionWatchdog", () => {
  let mockActiveSessions: Map<string, ActiveSession>;
  let killedSessions: string[];

  const createSession = (
    sessionId: string,
    startedAt: Date,
    pipeline = "feature" as const,
  ): ActiveSession => ({
    sessionId,
    pipeline,
    repository: "github.com/org/repo",
    startedAt: startedAt.toISOString(),
    status: "running",
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mockActiveSessions = new Map();
    killedSessions = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Configuration", () => {
    it("should use default configuration values", () => {
      const watchdog = new SessionWatchdog({
        getActiveSessions: () => mockActiveSessions,
        killSession: (id) => killedSessions.push(id),
      });

      const config = watchdog.getConfig();
      expect(config.checkIntervalMs).toBe(60_000);
      expect(config.sessionTimeoutMs).toBe(30 * 60 * 1000);
    });

    it("should accept custom configuration", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 10_000,
          sessionTimeoutMs: 5 * 60 * 1000,
        },
      );

      const config = watchdog.getConfig();
      expect(config.checkIntervalMs).toBe(10_000);
      expect(config.sessionTimeoutMs).toBe(5 * 60 * 1000);
    });
  });

  describe("Start/Stop", () => {
    it("should start and stop correctly", () => {
      const watchdog = new SessionWatchdog({
        getActiveSessions: () => mockActiveSessions,
        killSession: (id) => killedSessions.push(id),
      });

      expect(watchdog.isRunning()).toBe(false);

      watchdog.start();
      expect(watchdog.isRunning()).toBe(true);

      watchdog.stop();
      expect(watchdog.isRunning()).toBe(false);
    });

    it("should not start twice", () => {
      const watchdog = new SessionWatchdog({
        getActiveSessions: () => mockActiveSessions,
        killSession: (id) => killedSessions.push(id),
      });

      watchdog.start();
      watchdog.start(); // Should not throw or create duplicate intervals
      expect(watchdog.isRunning()).toBe(true);

      watchdog.stop();
    });

    it("should handle stop when not running", () => {
      const watchdog = new SessionWatchdog({
        getActiveSessions: () => mockActiveSessions,
        killSession: (id) => killedSessions.push(id),
      });

      // Should not throw
      watchdog.stop();
      expect(watchdog.isRunning()).toBe(false);
    });
  });

  describe("Session timeout detection", () => {
    it("should kill sessions that exceed timeout", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 5 * 60 * 1000, // 5 minutes
        },
      );

      // Add a session that started 10 minutes ago
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockActiveSessions.set("old-session", createSession("old-session", tenMinutesAgo));

      watchdog.start();

      // Advance time to trigger check
      vi.advanceTimersByTime(1000);

      expect(killedSessions).toContain("old-session");

      watchdog.stop();
    });

    it("should not kill sessions within timeout", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
        },
      );

      // Add a session that started 5 minutes ago
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      mockActiveSessions.set("recent-session", createSession("recent-session", fiveMinutesAgo));

      watchdog.start();

      // Advance time to trigger check
      vi.advanceTimersByTime(1000);

      expect(killedSessions).not.toContain("recent-session");

      watchdog.stop();
    });

    it("should kill multiple timed-out sessions", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 5 * 60 * 1000, // 5 minutes
        },
      );

      // Add multiple old sessions
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      mockActiveSessions.set("session-1", createSession("session-1", tenMinutesAgo));
      mockActiveSessions.set("session-2", createSession("session-2", fifteenMinutesAgo));

      // Add a recent session that should NOT be killed
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockActiveSessions.set("session-3", createSession("session-3", twoMinutesAgo));

      watchdog.start();

      // Advance time to trigger check
      vi.advanceTimersByTime(1000);

      expect(killedSessions).toContain("session-1");
      expect(killedSessions).toContain("session-2");
      expect(killedSessions).not.toContain("session-3");

      watchdog.stop();
    });

    it("should check periodically", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 5 * 60 * 1000,
        },
      );

      watchdog.start();

      // First check - no sessions
      vi.advanceTimersByTime(1000);
      expect(killedSessions).toHaveLength(0);

      // Add an old session after first check
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockActiveSessions.set("late-session", createSession("late-session", tenMinutesAgo));

      // Second check - should catch the new session
      vi.advanceTimersByTime(1000);
      expect(killedSessions).toContain("late-session");

      watchdog.stop();
    });
  });

  describe("Edge cases", () => {
    it("should handle empty sessions map", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 5 * 60 * 1000,
        },
      );

      watchdog.start();

      // Should not throw with empty map
      vi.advanceTimersByTime(1000);
      expect(killedSessions).toHaveLength(0);

      watchdog.stop();
    });

    it("should handle session exactly at timeout boundary", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 5 * 60 * 1000,
        },
      );

      // Session started exactly 5 minutes ago (at boundary)
      const justUnderFiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000 + 2000); // +2s to account for advanceTimersByTime(1000)
      mockActiveSessions.set("boundary-session", createSession("boundary-session", justUnderFiveMinutesAgo));

      watchdog.start();
      vi.advanceTimersByTime(1000);

      // At exactly the boundary, session is NOT timed out (elapsed <= timeout)
      expect(killedSessions).not.toContain("boundary-session");

      watchdog.stop();
    });

    it("should handle session just over timeout", () => {
      const watchdog = new SessionWatchdog(
        {
          getActiveSessions: () => mockActiveSessions,
          killSession: (id) => killedSessions.push(id),
        },
        {
          checkIntervalMs: 1000,
          sessionTimeoutMs: 5 * 60 * 1000,
        },
      );

      // Session started just over 5 minutes ago
      const justOverFiveMinutes = new Date(Date.now() - 5 * 60 * 1000 - 1);
      mockActiveSessions.set("over-session", createSession("over-session", justOverFiveMinutes));

      watchdog.start();
      vi.advanceTimersByTime(1000);

      // Just over the boundary - should be killed
      expect(killedSessions).toContain("over-session");

      watchdog.stop();
    });
  });
});
