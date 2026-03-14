import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseOutput } from "../runner/output-parser.js";
import { runWithRecovery } from "../runner/recovery.js";
import { runSession, SessionError, type SessionOptions } from "../runner/session.js";

// ─── SDK Mock ───────────────────────────────────────────

interface MockMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

let mockMessages: MockMessage[] = [];
let mockQueryDelay = 0;
let capturedQueryArgs: unknown;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => {
    capturedQueryArgs = args;
    const messages = mockMessages;
    const delay = mockQueryDelay;
    return {
      async *[Symbol.asyncIterator]() {
        for (const msg of messages) {
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          yield msg;
        }
      },
    };
  },
}));

// ─── Helpers ────────────────────────────────────────────

function makeSessionOptions(overrides?: Partial<SessionOptions>): SessionOptions {
  return {
    agent: {
      name: "test-agent",
      definition: {
        description: "Test agent",
        prompt: "You are a test agent.",
        tools: ["Read", "Write"],
        model: "sonnet",
      },
      sandbox: "writable",
      source: "built-in",
    },
    prompt: "Do something",
    sandboxConfig: {
      allowedTools: ["Read", "Write"],
      readablePaths: ["/tmp/test"],
      writablePaths: ["/tmp/test"],
      writable: true,
    },
    initTimeoutMs: 5_000,
    maxDurationMs: 60_000,
    ...overrides,
  };
}

function successMessages(sessionId = "session-123"): MockMessage[] {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "Task completed successfully",
      total_cost_usd: 0.05,
      duration_ms: 1200,
      num_turns: 3,
    },
  ];
}

// ─── Setup / Teardown ───────────────────────────────────

beforeEach(() => {
  mockMessages = successMessages();
  mockQueryDelay = 0;
  capturedQueryArgs = undefined;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── runSession ─────────────────────────────────────────

describe("runSession", () => {
  it("runs a basic session and returns result", async () => {
    const result = await runSession(makeSessionOptions());

    expect(result.sessionId).toBe("session-123");
    expect(result.output).toBe("Task completed successfully");
    expect(result.costUsd).toBe(0.05);
    expect(result.turnCount).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits session:start and session:complete events", async () => {
    const events: unknown[] = [];
    const result = await runSession(makeSessionOptions({ onEvent: (e) => events.push(e) }));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "session:start",
      sessionId: "session-123",
    });
    expect(events[1]).toEqual({
      type: "session:complete",
      sessionId: "session-123",
      result,
    });
  });

  it("emits session:fail on error", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-fail" },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-fail",
        result: "",
        total_cost_usd: 0,
        duration_ms: 0,
        num_turns: 10,
      },
    ];

    const events: unknown[] = [];
    await expect(
      runSession(makeSessionOptions({ onEvent: (e) => events.push(e) })),
    ).rejects.toThrow();

    const failEvent = events.find((e) => (e as { type: string }).type === "session:fail");
    expect(failEvent).toBeDefined();
  });

  it("throws SessionError with errorType on SDK error", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-err" },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-err",
        result: "",
        total_cost_usd: 0,
        duration_ms: 0,
        num_turns: 10,
      },
    ];

    try {
      await runSession(makeSessionOptions());
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).errorType).toBe("error_max_turns");
      expect((error as SessionError).sessionId).toBe("session-err");
    }
  });

  it("passes resumeSessionId to SDK options", async () => {
    await runSession(makeSessionOptions({ resumeSessionId: "prev-session-42" }));

    const args = capturedQueryArgs as { options: { resume?: string } };
    expect(args.options.resume).toBe("prev-session-42");
  });

  it("throws on init timeout", async () => {
    // Messages never include an init — simulate SDK not responding
    mockMessages = [];
    mockQueryDelay = 0;

    // With empty messages, the stream ends without result
    // Use a very short init timeout to trigger abort
    vi.useRealTimers();
    mockQueryDelay = 200;
    mockMessages = successMessages();

    await expect(
      runSession(makeSessionOptions({ initTimeoutMs: 50, maxDurationMs: 60_000 })),
    ).rejects.toThrow("timeout");
  });

  it("throws on max duration timeout", async () => {
    vi.useRealTimers();
    mockQueryDelay = 200;
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-slow" },
      // Result comes after delay, but max duration fires first
      {
        type: "result",
        subtype: "success",
        session_id: "session-slow",
        result: "done",
        total_cost_usd: 0,
        duration_ms: 0,
        num_turns: 1,
      },
    ];

    await expect(
      runSession(makeSessionOptions({ initTimeoutMs: 5_000, maxDurationMs: 50 })),
    ).rejects.toThrow("max duration exceeded");
  });
});

// ─── runWithRecovery ────────────────────────────────────

describe("runWithRecovery", () => {
  it("returns result on first attempt success", async () => {
    const result = await runWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(result.sessionId).toBe("session-123");
    expect(result.output).toBe("Task completed successfully");
  });

  it("escalates through 3 recovery levels", async () => {
    vi.useRealTimers();
    let callCount = 0;
    const attempts: Array<{ attempt: number; strategy: string }> = [];

    // Override mock to fail first 2 attempts, succeed on 3rd
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => {
        callCount++;
        const current = callCount;
        return {
          async *[Symbol.asyncIterator]() {
            if (current <= 2) {
              yield {
                type: "system",
                subtype: "init",
                session_id: `session-${current}`,
              };
              throw new Error(`Attempt ${current} failed`);
            }
            yield* successMessages("session-final");
          },
        };
      },
    }));

    // Re-import to get fresh modules with new mock
    const { runWithRecovery: freshRunWithRecovery } = await import("../runner/recovery.js");

    const result = await freshRunWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 3,
      backoffBaseMs: 10,
      onAttempt: (attempt, strategy) => attempts.push({ attempt, strategy }),
    });

    expect(result.sessionId).toBe("session-final");
    expect(attempts).toEqual([
      { attempt: 1, strategy: "normal" },
      { attempt: 2, strategy: "resume" },
      { attempt: 3, strategy: "fresh" },
    ]);

    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });

  it("skips retry on non-retryable error", async () => {
    vi.useRealTimers();

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "session-max" };
          yield {
            type: "result",
            subtype: "error_max_turns",
            session_id: "session-max",
            result: "",
            total_cost_usd: 0,
            duration_ms: 0,
            num_turns: 10,
          };
        },
      }),
    }));

    const { runWithRecovery: freshRunWithRecovery } = await import("../runner/recovery.js");

    const attempts: number[] = [];

    await expect(
      freshRunWithRecovery({
        ...makeSessionOptions(),
        maxRetries: 3,
        backoffBaseMs: 10,
        onAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toThrow();

    // Should only have attempted once — non-retryable error
    expect(attempts).toEqual([1]);

    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });

  it("applies backoff between attempts", async () => {
    vi.useRealTimers();
    let callCount = 0;

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => {
        callCount++;
        const current = callCount;
        return {
          async *[Symbol.asyncIterator]() {
            if (current === 1) {
              throw new Error("fail");
            }
            yield* successMessages("session-ok");
          },
        };
      },
    }));

    const { runWithRecovery: freshRunWithRecovery } = await import("../runner/recovery.js");

    const start = Date.now();
    await freshRunWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 2,
      backoffBaseMs: 50,
    });
    const elapsed = Date.now() - start;

    // Backoff should be at least backoffBaseMs * 1 = 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40); // small tolerance

    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });

  it("passes resumeSessionId on level 2 (resume)", async () => {
    vi.useRealTimers();
    let callCount = 0;
    const capturedOptions: Array<Record<string, unknown>> = [];

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: (args: { options: Record<string, unknown> }) => {
        callCount++;
        const current = callCount;
        capturedOptions.push({ ...args.options });
        return {
          async *[Symbol.asyncIterator]() {
            if (current === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "session-first",
              };
              throw new Error("fail attempt 1");
            }
            yield* successMessages("session-resumed");
          },
        };
      },
    }));

    const { runWithRecovery: freshRunWithRecovery } = await import("../runner/recovery.js");

    const result = await freshRunWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 2,
      backoffBaseMs: 10,
    });

    expect(result.sessionId).toBe("session-resumed");
    // Level 2 should have resume set to the session from level 1
    expect(capturedOptions[1]?.resume).toBe("session-first");

    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });
});

// ─── parseOutput ────────────────────────────────────────

describe("parseOutput", () => {
  it("returns rawOutput when no schema provided", () => {
    const result = parseOutput("some text output");

    expect(result.rawOutput).toBe("some text output");
    expect(result.output).toBeUndefined();
    expect(result.parseError).toBeUndefined();
  });

  it("extracts and validates raw JSON", () => {
    const schema = z.object({ status: z.string(), count: z.number() });
    const result = parseOutput('{"status":"ok","count":42}', schema);

    expect(result.output).toEqual({ status: "ok", count: 42 });
    expect(result.parseError).toBeUndefined();
  });

  it("extracts JSON from markdown code block", () => {
    const schema = z.object({ name: z.string() });
    const raw = 'Here is the result:\n\n```json\n{"name":"test"}\n```\n\nDone.';
    const result = parseOutput(raw, schema);

    expect(result.output).toEqual({ name: "test" });
    expect(result.parseError).toBeUndefined();
  });

  it("extracts JSON from untyped code block", () => {
    const schema = z.object({ value: z.number() });
    const raw = 'Output:\n```\n{"value": 99}\n```';
    const result = parseOutput(raw, schema);

    expect(result.output).toEqual({ value: 99 });
  });

  it("returns parseError on invalid JSON", () => {
    const schema = z.object({ x: z.number() });
    const result = parseOutput("not json at all", schema);

    expect(result.output).toBeUndefined();
    expect(result.parseError).toBe("Failed to extract JSON from output");
    expect(result.rawOutput).toBe("not json at all");
  });

  it("returns parseError on schema validation failure", () => {
    const schema = z.object({ required: z.string() });
    const result = parseOutput('{"wrong":"field"}', schema);

    expect(result.output).toBeUndefined();
    expect(result.parseError).toContain("Schema validation failed");
    expect(result.rawOutput).toBe('{"wrong":"field"}');
  });
});
