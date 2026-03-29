import { describe, expect, it, vi } from "vitest";
import type { ActivityLog } from "@/supervisor/activity-log";
import {
  type ErrorBoundaryConfig,
  type ErrorContext,
  HeartbeatErrorBoundary,
} from "@/supervisor/heartbeat-error-boundary";
import type { SupervisorWebhookEvent } from "@/supervisor/webhookEvents";

// ─── Mock ActivityLog ────────────────────────────────────────

function createMockActivityLog(): ActivityLog {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    tail: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    getPath: vi.fn().mockReturnValue("/test/activity.jsonl"),
  } as unknown as ActivityLog;
}

// ─── Test configuration ──────────────────────────────────────

const DEFAULT_CONFIG: ErrorBoundaryConfig = {
  maxConsecutiveFailures: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 15 * 60 * 1000,
};

// ─── HeartbeatErrorBoundary tests ────────────────────────────

describe("HeartbeatErrorBoundary", () => {
  describe("evaluateCircuitBreaker", () => {
    it("returns shouldBackoff: false when consecutive failures below threshold", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      const result = boundary.evaluateCircuitBreaker(1);

      expect(result.shouldBackoff).toBe(false);
      expect(result.backoffMs).toBe(0);
    });

    it("returns shouldBackoff: false when at threshold minus one", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      const result = boundary.evaluateCircuitBreaker(2);

      expect(result.shouldBackoff).toBe(false);
      expect(result.backoffMs).toBe(0);
    });

    it("returns shouldBackoff: true when consecutive failures at threshold", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      const result = boundary.evaluateCircuitBreaker(3);

      expect(result.shouldBackoff).toBe(true);
      expect(result.backoffMs).toBe(1000); // baseBackoffMs * 2^0
    });

    it("uses exponential backoff for consecutive failures above threshold", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      // At threshold: 2^0 = 1
      expect(boundary.evaluateCircuitBreaker(3).backoffMs).toBe(1000);

      // One above threshold: 2^1 = 2
      expect(boundary.evaluateCircuitBreaker(4).backoffMs).toBe(2000);

      // Two above threshold: 2^2 = 4
      expect(boundary.evaluateCircuitBreaker(5).backoffMs).toBe(4000);
    });

    it("caps backoff at maxBackoffMs", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      // Very high consecutive failures should still cap at maxBackoffMs
      const result = boundary.evaluateCircuitBreaker(100);

      expect(result.shouldBackoff).toBe(true);
      expect(result.backoffMs).toBe(15 * 60 * 1000);
    });
  });

  describe("handleHeartbeatError", () => {
    it("emits webhook event with correct structure", async () => {
      const activityLog = createMockActivityLog();
      const webhookEvents: SupervisorWebhookEvent[] = [];
      const onWebhookEvent = vi.fn((event: SupervisorWebhookEvent) => {
        webhookEvents.push(event);
      });

      const boundary = new HeartbeatErrorBoundary(
        activityLog,
        DEFAULT_CONFIG,
        "supervisor-123",
        onWebhookEvent,
      );

      const context: ErrorContext = {
        heartbeatId: "heartbeat-456",
        consecutiveFailures: 2,
        error: new Error("Test error"),
        source: "runHeartbeat",
      };

      await boundary.handleHeartbeatError(context);

      expect(onWebhookEvent).toHaveBeenCalledTimes(1);
      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0]).toMatchObject({
        type: "heartbeat_failure",
        supervisorId: "supervisor-123",
        heartbeatId: "heartbeat-456",
        error: "Test error",
        consecutiveFailures: 2,
      });
    });

    it("logs error to activity log", async () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      const context: ErrorContext = {
        heartbeatId: "heartbeat-456",
        consecutiveFailures: 1,
        error: "String error message",
        source: "runHeartbeat",
      };

      await boundary.handleHeartbeatError(context);

      expect(activityLog.log).toHaveBeenCalledWith(
        "error",
        "Heartbeat failed: String error message",
        expect.objectContaining({
          heartbeatId: "heartbeat-456",
          source: "runHeartbeat",
          consecutiveFailures: 1,
        }),
      );
    });

    it("truncates long error messages to 1000 characters in webhook", async () => {
      const activityLog = createMockActivityLog();
      const webhookEvents: SupervisorWebhookEvent[] = [];
      const onWebhookEvent = vi.fn((event: SupervisorWebhookEvent) => {
        webhookEvents.push(event);
      });

      const boundary = new HeartbeatErrorBoundary(
        activityLog,
        DEFAULT_CONFIG,
        "supervisor-123",
        onWebhookEvent,
      );

      const longError = "x".repeat(2000);
      const context: ErrorContext = {
        heartbeatId: "heartbeat-456",
        consecutiveFailures: 1,
        error: new Error(longError),
        source: "runHeartbeat",
      };

      await boundary.handleHeartbeatError(context);

      expect(webhookEvents[0]).toMatchObject({
        type: "heartbeat_failure",
      });
      // Check the error is truncated to 1000 chars
      const event = webhookEvents[0] as { error: string };
      expect(event.error.length).toBe(1000);
    });

    it("continues if webhook emission fails", async () => {
      const activityLog = createMockActivityLog();
      const onWebhookEvent = vi.fn().mockRejectedValue(new Error("Webhook failed"));

      const boundary = new HeartbeatErrorBoundary(
        activityLog,
        DEFAULT_CONFIG,
        "supervisor-123",
        onWebhookEvent,
      );

      const context: ErrorContext = {
        heartbeatId: "heartbeat-456",
        consecutiveFailures: 1,
        error: "Test error",
        source: "runHeartbeat",
      };

      // Should not throw
      await expect(boundary.handleHeartbeatError(context)).resolves.not.toThrow();

      // Should still log to activity log
      expect(activityLog.log).toHaveBeenCalled();
    });
  });

  describe("handleSilentError", () => {
    it("logs to console.debug without throwing", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      // Should not throw
      expect(() => {
        boundary.handleSilentError("readState", new Error("ENOENT"));
      }).not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[neo] Silent error in readState: ENOENT"),
      );

      consoleSpy.mockRestore();
    });

    it("handles non-Error objects", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      boundary.handleSilentError("updateState", "string error");
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("string error"));

      consoleSpy.mockRestore();
    });
  });

  describe("handleRecoverableError", () => {
    it("logs to activity log with error level", async () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      await boundary.handleRecoverableError("getActiveRuns", new Error("Permission denied"));

      expect(activityLog.log).toHaveBeenCalledWith(
        "error",
        "getActiveRuns failed: Permission denied",
        undefined,
      );
    });

    it("includes detail object if provided", async () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      await boundary.handleRecoverableError("loadInstructions", "Not found", {
        path: "/test/SUPERVISOR.md",
      });

      expect(activityLog.log).toHaveBeenCalledWith("error", "loadInstructions failed: Not found", {
        path: "/test/SUPERVISOR.md",
      });
    });
  });

  describe("logCircuitBreaker", () => {
    it("logs circuit breaker activation to activity log", async () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      await boundary.logCircuitBreaker(5, 8000);

      expect(activityLog.log).toHaveBeenCalledWith(
        "error",
        "Circuit breaker: backing off 8s after 5 failures",
        undefined,
      );
    });
  });

  describe("classifyError", () => {
    it("classifies SDK errors as critical", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      expect(boundary.classifyError("sdk", new Error("Connection refused"))).toBe("critical");
      expect(boundary.classifyError("runHeartbeat", "Timeout")).toBe("critical");
    });

    it("classifies store errors as silent", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      expect(boundary.classifyError("readState", new Error("ENOENT"))).toBe("silent");
      expect(boundary.classifyError("updateState", "Parse error")).toBe("silent");
      expect(boundary.classifyError("getMemoryStore", new Error("DB locked"))).toBe("silent");
      expect(boundary.classifyError("getTaskStore", "Init failed")).toBe("silent");
      expect(boundary.classifyError("getDirectiveStore", new Error("Path not found"))).toBe(
        "silent",
      );
    });

    it("classifies ENOENT/EACCES as recoverable", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      expect(boundary.classifyError("loadFile", new Error("ENOENT: no such file"))).toBe(
        "recoverable",
      );
      expect(boundary.classifyError("writeFile", new Error("EACCES: permission denied"))).toBe(
        "recoverable",
      );
    });

    it("defaults unknown errors to recoverable", () => {
      const activityLog = createMockActivityLog();
      const boundary = new HeartbeatErrorBoundary(activityLog, DEFAULT_CONFIG, "supervisor-123");

      expect(boundary.classifyError("unknownSource", new Error("Random error"))).toBe(
        "recoverable",
      );
    });
  });
});
