import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRecovery } from "@/runner/recovery";
import { SessionError } from "@/runner/session";

// Mock the session module
vi.mock("@/runner/session", () => ({
  runSession: vi.fn(),
  SessionError: class SessionError extends Error {
    constructor(
      message: string,
      public readonly errorType: string,
      public readonly sessionId: string,
    ) {
      super(message);
      this.name = "SessionError";
    }
  },
}));

import { runSession } from "@/runner/session";

describe("runWithRecovery - failure context injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects previous failure context into retry prompt", async () => {
    const mockRunSession = vi.mocked(runSession);
    const capturedPrompts: string[] = [];

    // First call fails, second succeeds
    mockRunSession
      .mockImplementationOnce(async (opts) => {
        capturedPrompts.push(opts.prompt);
        throw new SessionError("Connection timeout", "timeout", "sess-1");
      })
      .mockImplementationOnce(async (opts) => {
        capturedPrompts.push(opts.prompt);
        return {
          sessionId: "sess-2",
          output: "Success",
          costUsd: 0.01,
          durationMs: 1000,
          turnCount: 1,
        };
      });

    const result = await runWithRecovery({
      agent: {
        name: "test-agent",
        definition: {
          description: "Test",
          prompt: "You are a test agent.",
          model: "claude-sonnet-4-6",
        },
        sandbox: "readonly",
        source: "built-in",
      },
      prompt: "Do the task",
      sandboxConfig: {
        writable: false,
        paths: { readable: ["/tmp"], writable: [] },
      },
      initTimeoutMs: 5000,
      maxDurationMs: 60000,
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(result.output).toBe("Success");
    expect(capturedPrompts).toHaveLength(2);

    // First prompt should be original
    expect(capturedPrompts[0]).toBe("Do the task");

    // Second prompt should include failure context
    expect(capturedPrompts[1]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[1]).toContain("Connection timeout");
    expect(capturedPrompts[1]).toContain("timeout");
  });

  it("does not inject failure context on first attempt", async () => {
    const mockRunSession = vi.mocked(runSession);
    let capturedPrompt = "";

    mockRunSession.mockImplementationOnce(async (opts) => {
      capturedPrompt = opts.prompt;
      return {
        sessionId: "sess-1",
        output: "Success",
        costUsd: 0.01,
        durationMs: 1000,
        turnCount: 1,
      };
    });

    await runWithRecovery({
      agent: {
        name: "test-agent",
        definition: {
          description: "Test",
          prompt: "Test prompt",
          model: "claude-sonnet-4-6",
        },
        sandbox: "readonly",
        source: "built-in",
      },
      prompt: "Original task",
      sandboxConfig: {
        writable: false,
        paths: { readable: ["/tmp"], writable: [] },
      },
      initTimeoutMs: 5000,
      maxDurationMs: 60000,
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(capturedPrompt).toBe("Original task");
    expect(capturedPrompt).not.toContain("PREVIOUS ATTEMPT FAILED");
  });
});
