import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallbackPayload, PipelineResult } from "../types.js";

// Mock fetch globally
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function makePipelineResult(
  overrides?: Partial<PipelineResult>,
): PipelineResult {
  return {
    sessionId: "dispatch-1234",
    pipeline: "feature",
    status: "success",
    costUsd: 25.5,
    durationMs: 180_000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("sendCallback", () => {
  it("should POST payload to CALLBACK_URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { sendCallback } = await import("../callback.js");
    const payload: CallbackPayload = {
      event: "pipeline.completed",
      timestamp: new Date().toISOString(),
      data: makePipelineResult(),
    };

    const result = await sendCallback(payload);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("dispatch-result"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("should include Authorization header when OPENCLAW_HOOKS_TOKEN_DISPATCH is set", async () => {
    vi.stubEnv("OPENCLAW_HOOKS_TOKEN_DISPATCH", "test-token-123");
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { sendCallback } = await import("../callback.js");
    await sendCallback({
      event: "pipeline.completed",
      timestamp: new Date().toISOString(),
      data: makePipelineResult(),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }),
      }),
    );
  });

  it("should retry once on failure then succeed", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce({ ok: true });

    const { sendCallback } = await import("../callback.js");
    const promise = sendCallback({
      event: "service.started",
      timestamp: new Date().toISOString(),
      data: { action: "started", version: "0.1.0", host: "127.0.0.1:3001" },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("should return false after all retries exhausted", async () => {
    vi.useFakeTimers();
    mockFetch.mockRejectedValue(new Error("Network error"));

    const { sendCallback } = await import("../callback.js");
    const promise = sendCallback({
      event: "pipeline.failed",
      timestamp: new Date().toISOString(),
      data: makePipelineResult({ status: "failure" }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe(false);
    // initial + 1 retry = 2 attempts
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("should return false on HTTP error response after retries", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const { sendCallback } = await import("../callback.js");
    const promise = sendCallback({
      event: "agent.notification",
      timestamp: new Date().toISOString(),
      data: { sessionId: "test-session", message: "Hello" },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("should send correct JSON body", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { sendCallback } = await import("../callback.js");
    const payload: CallbackPayload = {
      event: "pipeline.completed",
      timestamp: "2026-03-01T14:00:00.000Z",
      data: makePipelineResult({ ticketId: "PROJ-42" }),
    };

    await sendCallback(payload);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as CallbackPayload;
    expect(body.event).toBe("pipeline.completed");
    expect(body.timestamp).toBe("2026-03-01T14:00:00.000Z");
    expect(body.data).toMatchObject({ ticketId: "PROJ-42", pipeline: "feature" });
  });
});

describe("notifyPipelineResult", () => {
  it("should not throw on callback failure", async () => {
    mockFetch.mockRejectedValue(new Error("fail"));

    const { notifyPipelineResult } = await import("../callback.js");

    expect(() => notifyPipelineResult(makePipelineResult())).not.toThrow();
  });

  it("should send pipeline.completed for success status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { notifyPipelineResult } = await import("../callback.js");
    notifyPipelineResult(makePipelineResult({ status: "success" }));

    // Wait for fire-and-forget promise
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as CallbackPayload;
    expect(body.event).toBe("pipeline.completed");
  });

  it("should send pipeline.failed for failure status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { notifyPipelineResult } = await import("../callback.js");
    notifyPipelineResult(makePipelineResult({ status: "failure" }));

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as CallbackPayload;
    expect(body.event).toBe("pipeline.failed");
  });
});

describe("notifyServiceLifecycle", () => {
  it("should not throw on callback failure", async () => {
    mockFetch.mockRejectedValue(new Error("fail"));

    const { notifyServiceLifecycle } = await import("../callback.js");

    expect(() =>
      notifyServiceLifecycle("started", {
        version: "0.1.0",
        host: "127.0.0.1:3001",
      }),
    ).not.toThrow();
  });
});

describe("forwardAgentNotification", () => {
  it("should not throw on callback failure", async () => {
    mockFetch.mockRejectedValue(new Error("fail"));

    const { forwardAgentNotification } = await import("../callback.js");

    expect(() =>
      forwardAgentNotification("session-123", "Build completed"),
    ).not.toThrow();
  });

  it("should send agent.notification event", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { forwardAgentNotification } = await import("../callback.js");
    forwardAgentNotification("session-123", "Build completed");

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as CallbackPayload;
    expect(body.event).toBe("agent.notification");
    expect(body.data).toMatchObject({
      sessionId: "session-123",
      message: "Build completed",
    });
  });
});
