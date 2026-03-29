import { describe, expect, it } from "vitest";
import {
  heartbeatEventSchema,
  heartbeatFailureEventSchema,
  runCompletedEventSchema,
  runDispatchedEventSchema,
  supervisorStartedEventSchema,
  supervisorStoppedEventSchema,
  supervisorWebhookEventSchema,
} from "@/supervisor/webhookEvents";

describe("supervisorStartedEventSchema", () => {
  it("accepts valid supervisor started event", () => {
    const event = {
      type: "supervisor_started",
      supervisorId: "sup-123",
      startedAt: "2026-03-15T10:00:00.000Z",
    };
    const result = supervisorStartedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects missing supervisorId", () => {
    const event = {
      type: "supervisor_started",
      startedAt: "2026-03-15T10:00:00.000Z",
    };
    const result = supervisorStartedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects invalid datetime format", () => {
    const event = {
      type: "supervisor_started",
      supervisorId: "sup-123",
      startedAt: "not-a-date",
    };
    const result = supervisorStartedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects wrong event type", () => {
    const event = {
      type: "wrong_type",
      supervisorId: "sup-123",
      startedAt: "2026-03-15T10:00:00.000Z",
    };
    const result = supervisorStartedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("heartbeatEventSchema", () => {
  it("accepts valid heartbeat event", () => {
    const event = {
      type: "heartbeat",
      supervisorId: "sup-123",
      heartbeatNumber: 42,
      timestamp: "2026-03-15T10:00:00.000Z",
      runsActive: 3,
      budget: {
        todayUsd: 5.5,
        limitUsd: 50.0,
      },
    };
    const result = heartbeatEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects negative heartbeatNumber", () => {
    const event = {
      type: "heartbeat",
      supervisorId: "sup-123",
      heartbeatNumber: -1,
      timestamp: "2026-03-15T10:00:00.000Z",
      runsActive: 0,
      budget: { todayUsd: 0, limitUsd: 50 },
    };
    const result = heartbeatEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects negative budget values", () => {
    const event = {
      type: "heartbeat",
      supervisorId: "sup-123",
      heartbeatNumber: 1,
      timestamp: "2026-03-15T10:00:00.000Z",
      runsActive: 0,
      budget: { todayUsd: -5, limitUsd: 50 },
    };
    const result = heartbeatEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects missing budget object", () => {
    const event = {
      type: "heartbeat",
      supervisorId: "sup-123",
      heartbeatNumber: 1,
      timestamp: "2026-03-15T10:00:00.000Z",
      runsActive: 0,
    };
    const result = heartbeatEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("heartbeatFailureEventSchema", () => {
  it("accepts valid heartbeat failure event", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: "2026-03-15T10:00:00.000Z",
      error: "Connection refused: adapter.query() failed",
      consecutiveFailures: 1,
    };
    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects consecutiveFailures less than 1", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: "2026-03-15T10:00:00.000Z",
      error: "Some error",
      consecutiveFailures: 0,
    };
    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects error longer than 1000 characters", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: "2026-03-15T10:00:00.000Z",
      error: "x".repeat(1001),
      consecutiveFailures: 1,
    };
    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects missing heartbeatId", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      timestamp: "2026-03-15T10:00:00.000Z",
      error: "Some error",
      consecutiveFailures: 1,
    };
    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("accepts high consecutiveFailures count", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-456",
      timestamp: "2026-03-15T10:00:00.000Z",
      error: "Persistent failure",
      consecutiveFailures: 100,
    };
    const result = heartbeatFailureEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});

describe("runDispatchedEventSchema", () => {
  it("accepts valid run dispatched event", () => {
    const event = {
      type: "run_dispatched",
      supervisorId: "sup-123",
      runId: "run-456",
      agent: "developer",
      repo: "owner/repo",
      branch: "feat/new-feature",
      prompt: "Implement the new feature",
    };
    const result = runDispatchedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects prompt longer than 500 characters", () => {
    const event = {
      type: "run_dispatched",
      supervisorId: "sup-123",
      runId: "run-456",
      agent: "developer",
      repo: "owner/repo",
      branch: "main",
      prompt: "x".repeat(501),
    };
    const result = runDispatchedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const event = {
      type: "run_dispatched",
      supervisorId: "sup-123",
      runId: "run-456",
      // missing agent, repo, branch, prompt
    };
    const result = runDispatchedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("runCompletedEventSchema", () => {
  it("accepts valid completed run event", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "completed",
      costUsd: 2.5,
      durationMs: 120000,
    };
    const result = runCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts failed status", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "failed",
      output: "Error: something went wrong",
      costUsd: 1.0,
      durationMs: 30000,
    };
    const result = runCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts cancelled status", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "cancelled",
      costUsd: 0.5,
      durationMs: 5000,
    };
    const result = runCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "pending",
      costUsd: 0,
      durationMs: 0,
    };
    const result = runCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects negative costUsd", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "completed",
      costUsd: -1,
      durationMs: 1000,
    };
    const result = runCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects output longer than 1000 characters", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "completed",
      output: "x".repeat(1001),
      costUsd: 1,
      durationMs: 1000,
    };
    const result = runCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("supervisorStoppedEventSchema", () => {
  it("accepts valid supervisor stopped event", () => {
    const event = {
      type: "supervisor_stopped",
      supervisorId: "sup-123",
      stoppedAt: "2026-03-15T12:00:00.000Z",
      reason: "shutdown",
    };
    const result = supervisorStoppedEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts all valid reasons", () => {
    const reasons = ["shutdown", "budget_exceeded", "error", "manual"] as const;
    for (const reason of reasons) {
      const event = {
        type: "supervisor_stopped",
        supervisorId: "sup-123",
        stoppedAt: "2026-03-15T12:00:00.000Z",
        reason,
      };
      const result = supervisorStoppedEventSchema.safeParse(event);
      expect(result.success, `reason "${reason}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid reason", () => {
    const event = {
      type: "supervisor_stopped",
      supervisorId: "sup-123",
      stoppedAt: "2026-03-15T12:00:00.000Z",
      reason: "unknown_reason",
    };
    const result = supervisorStoppedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("supervisorWebhookEventSchema (discriminated union)", () => {
  it("accepts supervisor_started event", () => {
    const event = {
      type: "supervisor_started",
      supervisorId: "sup-123",
      startedAt: "2026-03-15T10:00:00.000Z",
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("supervisor_started");
    }
  });

  it("accepts heartbeat event", () => {
    const event = {
      type: "heartbeat",
      supervisorId: "sup-123",
      heartbeatNumber: 1,
      timestamp: "2026-03-15T10:00:00.000Z",
      runsActive: 0,
      budget: { todayUsd: 0, limitUsd: 50 },
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts run_dispatched event", () => {
    const event = {
      type: "run_dispatched",
      supervisorId: "sup-123",
      runId: "run-456",
      agent: "dev",
      repo: "owner/repo",
      branch: "main",
      prompt: "Do the thing",
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts run_completed event", () => {
    const event = {
      type: "run_completed",
      supervisorId: "sup-123",
      runId: "run-456",
      status: "completed",
      costUsd: 1,
      durationMs: 1000,
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts supervisor_stopped event", () => {
    const event = {
      type: "supervisor_stopped",
      supervisorId: "sup-123",
      stoppedAt: "2026-03-15T12:00:00.000Z",
      reason: "shutdown",
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("accepts heartbeat_failure event", () => {
    const event = {
      type: "heartbeat_failure",
      supervisorId: "sup-123",
      heartbeatId: "hb-789",
      timestamp: "2026-03-15T10:30:00.000Z",
      error: "SDK query failed: timeout",
      consecutiveFailures: 3,
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("heartbeat_failure");
    }
  });

  it("rejects unknown event type", () => {
    const event = {
      type: "unknown_event",
      supervisorId: "sup-123",
    };
    const result = supervisorWebhookEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});
