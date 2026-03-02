import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { runWithRecovery } from "../recovery.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

// Mock the claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";

function createMockSuccessStream(sessionId = "test-session"): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "success",
      result: "Done!",
      total_cost_usd: 10.00,
      session_id: sessionId,
      is_error: false,
      duration_ms: 60000,
      num_turns: 10,
    } as SDKResultMessage,
  ];

  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

function createMockStreamWithoutResult(sessionId = "test-session"): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    // No result message - stream ends early
  ];

  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

describe("runWithRecovery", () => {
  const mockQuery = vi.mocked(query);
  const defaultOptions: Options = {
    permissionMode: "acceptEdits",
    tools: { type: "preset", preset: "claude_code" },
    cwd: "/tmp",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("should return result on first successful attempt", async () => {
    mockQuery.mockReturnValue(createMockSuccessStream());

    const result = await runWithRecovery("test", "Do something", defaultOptions);

    expect(result.subtype).toBe("success");
    expect(result.total_cost_usd).toBe(10.00);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should call onSessionId callback when session starts", async () => {
    mockQuery.mockReturnValue(createMockSuccessStream("callback-session"));

    const onSessionId = vi.fn();
    await runWithRecovery("test", "Do something", defaultOptions, { onSessionId });

    expect(onSessionId).toHaveBeenCalledWith("callback-session");
  });

  it("should call onCostRecord callback when result received", async () => {
    mockQuery.mockReturnValue(createMockSuccessStream());

    const onCostRecord = vi.fn();
    await runWithRecovery("test", "Do something", defaultOptions, { onCostRecord });

    expect(onCostRecord).toHaveBeenCalled();
    expect(onCostRecord.mock.calls[0]?.[0]?.total_cost_usd).toBe(10.00);
  });

  it("should retry on stream ending without result", async () => {
    mockQuery
      .mockReturnValueOnce(createMockStreamWithoutResult())
      .mockReturnValueOnce(createMockSuccessStream());

    const promise = runWithRecovery("test", "Do something", defaultOptions, undefined, 3);

    // Advance past the first backoff: attempt 1 * 30_000 = 30s
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;

    expect(result.subtype).toBe("success");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("should retry on SDK error", async () => {
    mockQuery
      .mockImplementationOnce(() => { throw new Error("SDK connection lost"); })
      .mockReturnValueOnce(createMockSuccessStream());

    const promise = runWithRecovery("test", "Do something", defaultOptions, undefined, 3);

    // Advance past the first backoff: attempt 1 * 30_000 = 30s
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;

    expect(result.subtype).toBe("success");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("should use resume option on retry (attempt 2)", async () => {
    mockQuery
      .mockReturnValueOnce(createMockStreamWithoutResult("session-to-resume"))
      .mockReturnValueOnce(createMockSuccessStream("session-to-resume"));

    const promise = runWithRecovery("test", "Do something", defaultOptions, undefined, 3);

    // Advance past the first backoff: attempt 1 * 30_000 = 30s
    await vi.advanceTimersByTimeAsync(30_000);

    await promise;

    // Attempt 2 should resume the session from attempt 1
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const secondCallOptions = mockQuery.mock.calls[1]?.[0]?.options;
    expect(secondCallOptions).toHaveProperty("resume", "session-to-resume");
  });

  it("should use fresh session on attempt 3+", async () => {
    mockQuery
      .mockReturnValueOnce(createMockStreamWithoutResult("session-1"))
      .mockReturnValueOnce(createMockStreamWithoutResult("session-2"))
      .mockReturnValueOnce(createMockSuccessStream("session-3"));

    const promise = runWithRecovery("test", "Do something", defaultOptions, undefined, 3);

    // Advance past first backoff: attempt 1 * 30_000 = 30s
    await vi.advanceTimersByTimeAsync(30_000);
    // Advance past second backoff: attempt 2 * 30_000 = 60s
    await vi.advanceTimersByTimeAsync(60_000);

    await promise;

    expect(mockQuery).toHaveBeenCalledTimes(3);

    // Attempt 2 should resume session from attempt 1
    const secondCallOptions = mockQuery.mock.calls[1]?.[0]?.options;
    expect(secondCallOptions).toHaveProperty("resume", "session-1");

    // Attempt 3 should use fresh session (no resume)
    const thirdCallOptions = mockQuery.mock.calls[2]?.[0]?.options;
    expect(thirdCallOptions).not.toHaveProperty("resume");
  });

  it("should throw after max retries exhausted", async () => {
    mockQuery.mockReturnValue(createMockStreamWithoutResult());

    const promise = runWithRecovery("test", "Do something", defaultOptions, undefined, 3);
    // Prevent unhandled rejection warning while we advance timers
    const assertion = expect(promise).rejects.toThrow("test failed after 3 attempts");

    // Advance past first backoff: 1 * 30_000 = 30s
    await vi.advanceTimersByTimeAsync(30_000);
    // Advance past second backoff: 2 * 30_000 = 60s
    await vi.advanceTimersByTimeAsync(60_000);

    await assertion;
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("should include error message in final error", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("Network timeout");
    });

    const promise = runWithRecovery("test", "Do something", defaultOptions, undefined, 3);
    // Prevent unhandled rejection warning while we advance timers
    const assertion = expect(promise).rejects.toThrow("Last error: Network timeout");

    // Advance past first backoff: 1 * 30_000 = 30s
    await vi.advanceTimersByTimeAsync(30_000);
    // Advance past second backoff: 2 * 30_000 = 60s
    await vi.advanceTimersByTimeAsync(60_000);

    await assertion;
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("should respect custom maxRetries", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("Fail");
    });

    await expect(
      runWithRecovery("test", "Do something", defaultOptions, undefined, 1)
    ).rejects.toThrow();

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
