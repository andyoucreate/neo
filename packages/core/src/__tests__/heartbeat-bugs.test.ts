import { describe, expect, it, vi } from "vitest";
import { isRunActive, STALE_GRACE_PERIOD_MS } from "@/supervisor/heartbeat";
import { activityEntrySchema } from "@/supervisor/schemas";
import { heartbeatFailureEventSchema } from "@/supervisor/webhookEvents";
import type { PersistedRun } from "@/types";

// ─── Helpers ───────────────────────────────────────────

function makeRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    version: 1,
    runId: "run-123",
    agent: "test-agent",
    repo: "/tmp/test-repo",
    prompt: "Test prompt",
    status: "running",
    steps: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── isRunActive (T2: Ghost run filtering) ─────────────

describe("isRunActive", () => {
  describe("status filtering", () => {
    it("returns false for completed runs", () => {
      const run = makeRun({ status: "completed" });
      expect(isRunActive(run)).toBe(false);
    });

    it("returns false for failed runs", () => {
      const run = makeRun({ status: "failed" });
      expect(isRunActive(run)).toBe(false);
    });

    it("returns true for paused runs (always active)", () => {
      const run = makeRun({ status: "paused" });
      expect(isRunActive(run)).toBe(true);
    });

    it("returns true for paused runs regardless of PID or age", () => {
      const oldPausedRun = makeRun({
        status: "paused",
        pid: 99999, // Non-existent PID
        createdAt: new Date(Date.now() - 100_000).toISOString(), // Old run
      });
      expect(isRunActive(oldPausedRun, () => false)).toBe(true);
    });
  });

  describe("running status with PID validation", () => {
    it("returns true when PID exists and process is alive", () => {
      const run = makeRun({ status: "running", pid: 12345 });
      const isAlive = vi.fn().mockReturnValue(true);

      expect(isRunActive(run, isAlive)).toBe(true);
      expect(isAlive).toHaveBeenCalledWith(12345);
    });

    it("returns false when PID exists but process is dead (ghost run)", () => {
      const run = makeRun({ status: "running", pid: 12345 });
      const isAlive = vi.fn().mockReturnValue(false);

      expect(isRunActive(run, isAlive)).toBe(false);
      expect(isAlive).toHaveBeenCalledWith(12345);
    });

    it("filters out stale ghost runs with dead PID", () => {
      const run = makeRun({
        status: "running",
        pid: 99999, // Dead PID
        createdAt: new Date(Date.now() - 5000).toISOString(), // Recent
      });

      // Simulating ghost run: PID exists but process is dead
      expect(isRunActive(run, () => false)).toBe(false);
    });
  });

  describe("running status without PID (grace period)", () => {
    it("returns true when run is within grace period (no PID)", () => {
      const now = Date.now();
      const recentRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date(now - 10_000).toISOString(), // 10s old
      });

      expect(isRunActive(recentRun, () => false, now)).toBe(true);
    });

    it("returns false when run is past grace period (no PID)", () => {
      const now = Date.now();
      const staleRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date(now - STALE_GRACE_PERIOD_MS - 1000).toISOString(), // Past grace
      });

      expect(isRunActive(staleRun, () => false, now)).toBe(false);
    });

    it("uses default 30s grace period", () => {
      expect(STALE_GRACE_PERIOD_MS).toBe(30_000);
    });

    it("returns true at exact grace period boundary", () => {
      const now = Date.now();
      const boundaryRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date(now - STALE_GRACE_PERIOD_MS + 1).toISOString(),
      });

      expect(isRunActive(boundaryRun, () => false, now)).toBe(true);
    });

    it("returns false exactly at grace period expiry", () => {
      const now = Date.now();
      const expiredRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date(now - STALE_GRACE_PERIOD_MS).toISOString(),
      });

      expect(isRunActive(expiredRun, () => false, now)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles run just created (0ms age)", () => {
      const now = Date.now();
      const brandNewRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date(now).toISOString(),
      });

      expect(isRunActive(brandNewRun, () => false, now)).toBe(true);
    });

    it("handles very old stale run without PID", () => {
      const now = Date.now();
      const veryOldRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date(now - 1_000_000).toISOString(), // Very old
      });

      expect(isRunActive(veryOldRun, () => false, now)).toBe(false);
    });

    it("prioritizes PID check over grace period when PID exists", () => {
      const now = Date.now();
      const runWithDeadPid = makeRun({
        status: "running",
        pid: 12345,
        createdAt: new Date(now - 1000).toISOString(), // Within grace period
      });

      // Even though within grace period, dead PID means ghost run
      expect(isRunActive(runWithDeadPid, () => false, now)).toBe(false);
    });
  });
});

// ─── ActivityEntry "warning" type (T3: Warning log for turnCount===0) ─────────

describe("activityEntrySchema warning type", () => {
  it("accepts 'warning' as a valid activity type", () => {
    const warningEntry = {
      id: "test-id",
      type: "warning",
      summary: "Heartbeat #5 completed with turnCount=0. SDK stream may have timed out.",
      detail: { heartbeatId: "hb-123" },
      timestamp: new Date().toISOString(),
    };

    const result = activityEntrySchema.safeParse(warningEntry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("warning");
    }
  });

  it("includes warning in the enum of valid types", () => {
    // Test by validating each expected type including warning
    const expectedTypes = [
      "heartbeat",
      "decision",
      "action",
      "error",
      "warning",
      "event",
      "message",
      "thinking",
      "plan",
      "dispatch",
      "tool_use",
    ];

    for (const type of expectedTypes) {
      const entry = {
        id: "test-id",
        type,
        summary: "Test summary",
        timestamp: new Date().toISOString(),
      };
      const result = activityEntrySchema.safeParse(entry);
      expect(result.success, `Type '${type}' should be valid`).toBe(true);
    }
  });

  it("validates turnCount warning message format", () => {
    const turnCountWarning = {
      id: "warn-001",
      type: "warning",
      summary:
        "Heartbeat #42 completed with turnCount=0. SDK stream may have timed out before any turns completed.",
      detail: { heartbeatId: "abc-123" },
      timestamp: "2026-03-19T10:30:00.000Z",
    };

    const result = activityEntrySchema.safeParse(turnCountWarning);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toContain("turnCount=0");
      expect(result.data.summary).toContain("SDK stream may have timed out");
    }
  });

  it("rejects invalid activity types", () => {
    const invalidEntry = {
      id: "test-id",
      type: "invalid_type",
      summary: "Test",
      timestamp: new Date().toISOString(),
    };

    const result = activityEntrySchema.safeParse(invalidEntry);
    expect(result.success).toBe(false);
  });
});

// ─── HeartbeatFailureEvent (T4: Error boundary) ─────────────────

describe("heartbeatFailureEventSchema", () => {
  it("validates a properly structured heartbeat failure event", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: new Date().toISOString(),
      error: "adapter.query() failed: Connection refused",
      consecutiveFailures: 1,
    };

    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("heartbeat_failure");
      expect(result.data.consecutiveFailures).toBe(1);
    }
  });

  it("rejects error messages longer than 1000 characters", () => {
    const longError = "x".repeat(1001);
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: new Date().toISOString(),
      error: longError,
      consecutiveFailures: 1,
    };

    // Schema should reject errors longer than 1000 chars
    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("requires consecutiveFailures to be at least 1", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: new Date().toISOString(),
      error: "Some error",
      consecutiveFailures: 0,
    };

    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("includes heartbeatId for traceability", () => {
    const heartbeatId = "hb-unique-123";
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId,
      timestamp: new Date().toISOString(),
      error: "Test error",
      consecutiveFailures: 2,
    };

    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.heartbeatId).toBe(heartbeatId);
    }
  });

  it("accepts error messages from various failure scenarios", () => {
    const errorMessages = [
      "adapter.query() failed: Connection refused",
      "SDK timeout exceeded",
      "ECONNRESET: Connection reset by peer",
      "AbortError: The operation was aborted",
      "Rate limit exceeded: 429 Too Many Requests",
    ];

    for (const error of errorMessages) {
      const event = {
        type: "heartbeat_failure",
        supervisorId: "sup-123",
        heartbeatId: "hb-456",
        timestamp: new Date().toISOString(),
        error,
        consecutiveFailures: 1,
      };

      const result = heartbeatFailureEventSchema.safeParse(event);
      expect(result.success, `Error message "${error}" should be valid`).toBe(true);
    }
  });
});

// ─── Abort signal handling tests (T1: Non-blocking abort) ─────────

describe("abort signal handling patterns", () => {
  it("AbortController can be created and used for abort pattern", () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);

    controller.abort(new Error("Test abort"));
    expect(controller.signal.aborted).toBe(true);
  });

  it("abort promise resolves when signal fires", async () => {
    const controller = new AbortController();
    let abortResolved = false;

    const abortPromise = new Promise<{ aborted: true }>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        abortResolved = true;
        resolve({ aborted: true });
      });
    });

    // Start race but don't await yet
    const racePromise = Promise.race([
      new Promise((resolve) => setTimeout(() => resolve({ value: "data" }), 1000)),
      abortPromise,
    ]);

    // Abort should trigger immediately
    controller.abort();

    const result = await racePromise;
    expect(abortResolved).toBe(true);
    expect(result).toEqual({ aborted: true });
  });

  it("abort promise handles already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(); // Abort before creating promise

    const abortPromise = new Promise<{ aborted: true }>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ aborted: true });
        return;
      }
      controller.signal.addEventListener("abort", () => resolve({ aborted: true }));
    });

    const result = await abortPromise;
    expect(result).toEqual({ aborted: true });
  });

  it("Promise.race pattern exits immediately on abort", async () => {
    const controller = new AbortController();

    const slowPromise = new Promise((resolve) => {
      setTimeout(() => resolve("slow"), 10000);
    });

    const abortPromise = new Promise<{ aborted: true }>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
    });

    // Start race
    const racePromise = Promise.race([slowPromise, abortPromise]);

    // Abort immediately
    controller.abort();

    const startTime = Date.now();
    const result = await racePromise;
    const elapsed = Date.now() - startTime;

    // Should resolve almost immediately (not wait 10s)
    expect(elapsed).toBeLessThan(100);
    expect(result).toEqual({ aborted: true });
  });

  it("abort with custom error message", () => {
    const controller = new AbortController();
    const errorMessage = "Heartbeat timeout exceeded";

    controller.abort(new Error(errorMessage));

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect((controller.signal.reason as Error).message).toBe(errorMessage);
  });

  it("simulates iterator abort pattern used in callSdk", async () => {
    // Simulate an async iterator that yields values slowly
    async function* slowIterator(): AsyncGenerator<{ value: number }> {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield { value: i };
      }
    }

    const controller = new AbortController();
    const collected: number[] = [];

    const abortPromise = new Promise<{ aborted: true }>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
    });

    const iterator = slowIterator();

    // Simulate the race pattern from callSdk
    let aborted = false;
    try {
      while (true) {
        const raceResult = await Promise.race([iterator.next(), abortPromise]);

        if ("aborted" in raceResult) {
          aborted = true;
          break;
        }

        const iterResult = raceResult as IteratorResult<{ value: number }>;
        if (iterResult.done) break;

        collected.push(iterResult.value.value);

        // Abort after collecting 2 values
        if (collected.length === 2) {
          controller.abort();
        }
      }
    } finally {
      // Cleanup iterator (return requires an argument for the return value)
      await iterator.return?.(undefined);
    }

    expect(aborted).toBe(true);
    expect(collected).toHaveLength(2);
    expect(collected).toEqual([0, 1]);
  });
});
