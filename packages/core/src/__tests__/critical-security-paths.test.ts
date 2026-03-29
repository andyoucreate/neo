import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@/config";
import { runWithRecovery } from "@/runner/recovery";
import type { SessionOptions } from "@/runner/session";
import { SessionError } from "@/runner/session";
import {
  type SessionExecutionDeps,
  type SessionExecutionInput,
  SessionExecutor,
} from "@/runner/session-executor";

/**
 * Integration tests for critical security paths:
 * 1. Budget check rejection in SessionExecutor (lines 186-192)
 * 2. Recovery flow with failure context injection (3-level escalation)
 *
 * These tests verify the actual code paths, not just isolated logic.
 */

// ─── Mock SDK ────────────────────────────────────────────

interface MockMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

type MockQueryHandler = (args: { prompt: string; options: Record<string, unknown> }) => {
  [Symbol.asyncIterator]: () => AsyncGenerator<MockMessage>;
};

let mockQueryHandler: MockQueryHandler;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => mockQueryHandler(args),
}));

// ─── Helpers ─────────────────────────────────────────────

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
      sandbox: "readonly",
      source: "built-in",
    },
    prompt: "Do something",
    sandboxConfig: {
      allowedTools: ["Read", "Write"],
      readablePaths: ["/tmp/test"],
      writablePaths: [],
      writable: false,
    },
    initTimeoutMs: 5_000,
    maxDurationMs: 60_000,
    ...overrides,
  };
}

function successMessages(sessionId = "session-123", costUsd = 0.05): MockMessage[] {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "Task completed successfully",
      total_cost_usd: costUsd,
      duration_ms: 1200,
      num_turns: 3,
    },
  ];
}

function createAsyncIterator(messages: MockMessage[]): AsyncGenerator<MockMessage> {
  return (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();
}

function makeRepoConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    path: "/tmp/test-repo",
    defaultBranch: "main",
    branchPrefix: "feat",
    pushRemote: "origin",
    gitStrategy: "branch",
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────────

beforeEach(() => {
  vi.useRealTimers();
  mockQueryHandler = () => ({
    [Symbol.asyncIterator]: () => createAsyncIterator(successMessages()),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── SessionExecutor Budget Check Integration Tests ─────

describe("SessionExecutor budget check (lines 186-192)", () => {
  /**
   * This tests the actual budget check path in SessionExecutor.execute()
   * where costUsd >= maxCost throws a SessionError with "budget_exceeded".
   */
  it("throws budget_exceeded when session cost equals agent maxCost", async () => {
    // Configure mock to return a session with cost exactly at limit
    const sessionCost = 5.0;
    mockQueryHandler = () => ({
      [Symbol.asyncIterator]: () =>
        createAsyncIterator(successMessages("session-budget", sessionCost)),
    });

    const executor = new SessionExecutor(
      {
        initTimeoutMs: 5_000,
        maxDurationMs: 60_000,
        maxRetries: 1,
        backoffBaseMs: 10,
      },
      () => undefined,
    );

    const input: SessionExecutionInput = {
      runId: "run-budget-equal",
      sessionId: "session-budget-test",
      agent: {
        name: "budget-agent",
        definition: {
          description: "Agent with budget limit",
          prompt: "You are a test agent.",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
        maxCost: 5.0, // Exactly equals session cost
      },
      repoConfig: makeRepoConfig(),
      repoPath: "/tmp/test-repo",
      prompt: "Test task",
      gitStrategy: "branch",
      startedAt: new Date().toISOString(),
    };

    const deps: SessionExecutionDeps = {
      middleware: [],
    };

    await expect(executor.execute(input, deps)).rejects.toThrow(SessionError);

    try {
      await executor.execute(input, deps);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).errorType).toBe("budget_exceeded");
      expect((error as SessionError).message).toContain("$5.0000");
      expect((error as SessionError).message).toContain("exceeded budget");
    }
  });

  it("throws budget_exceeded when session cost exceeds agent maxCost", async () => {
    const sessionCost = 7.5;
    mockQueryHandler = () => ({
      [Symbol.asyncIterator]: () =>
        createAsyncIterator(successMessages("session-over", sessionCost)),
    });

    const executor = new SessionExecutor(
      {
        initTimeoutMs: 5_000,
        maxDurationMs: 60_000,
        maxRetries: 1,
        backoffBaseMs: 10,
      },
      () => undefined,
    );

    const input: SessionExecutionInput = {
      runId: "run-budget-exceed",
      sessionId: "session-exceed-test",
      agent: {
        name: "budget-agent",
        definition: {
          description: "Agent with budget limit",
          prompt: "You are a test agent.",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
        maxCost: 5.0, // Less than session cost
      },
      repoConfig: makeRepoConfig(),
      repoPath: "/tmp/test-repo",
      prompt: "Test task",
      gitStrategy: "branch",
      startedAt: new Date().toISOString(),
    };

    const deps: SessionExecutionDeps = {
      middleware: [],
    };

    try {
      await executor.execute(input, deps);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).errorType).toBe("budget_exceeded");
      expect((error as SessionError).message).toContain("$7.5000");
      expect((error as SessionError).message).toContain("$5.0000");
    }
  });

  it("does not throw when session cost is below agent maxCost", async () => {
    const sessionCost = 3.0;
    mockQueryHandler = () => ({
      [Symbol.asyncIterator]: () =>
        createAsyncIterator(successMessages("session-under", sessionCost)),
    });

    const executor = new SessionExecutor(
      {
        initTimeoutMs: 5_000,
        maxDurationMs: 60_000,
        maxRetries: 1,
        backoffBaseMs: 10,
      },
      () => undefined,
    );

    const input: SessionExecutionInput = {
      runId: "run-budget-under",
      sessionId: "session-under-test",
      agent: {
        name: "budget-agent",
        definition: {
          description: "Agent with budget limit",
          prompt: "You are a test agent.",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
        maxCost: 5.0, // Greater than session cost
      },
      repoConfig: makeRepoConfig(),
      repoPath: "/tmp/test-repo",
      prompt: "Test task",
      gitStrategy: "branch",
      startedAt: new Date().toISOString(),
    };

    const deps: SessionExecutionDeps = {
      middleware: [],
    };

    const result = await executor.execute(input, deps);
    expect(result.status).toBe("success");
    expect(result.costUsd).toBe(3.0);
  });

  it("does not check budget when maxCost is undefined", async () => {
    const sessionCost = 100.0; // High cost, but no limit
    mockQueryHandler = () => ({
      [Symbol.asyncIterator]: () =>
        createAsyncIterator(successMessages("session-no-limit", sessionCost)),
    });

    const executor = new SessionExecutor(
      {
        initTimeoutMs: 5_000,
        maxDurationMs: 60_000,
        maxRetries: 1,
        backoffBaseMs: 10,
      },
      () => undefined,
    );

    const input: SessionExecutionInput = {
      runId: "run-no-limit",
      sessionId: "session-no-limit-test",
      agent: {
        name: "unlimited-agent",
        definition: {
          description: "Agent without budget limit",
          prompt: "You are a test agent.",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
        // maxCost is undefined
      },
      repoConfig: makeRepoConfig(),
      repoPath: "/tmp/test-repo",
      prompt: "Test task",
      gitStrategy: "branch",
      startedAt: new Date().toISOString(),
    };

    const deps: SessionExecutionDeps = {
      middleware: [],
    };

    const result = await executor.execute(input, deps);
    expect(result.status).toBe("success");
    expect(result.costUsd).toBe(100.0);
  });
});

// ─── Recovery Multi-Attempt Flow with Failure Context ───

describe("Recovery 3-level mechanism with failure context injection", () => {
  /**
   * This tests the actual recovery flow in recovery.ts:
   * - Level 1 (attempt 1): Normal execution
   * - Level 2 (attempt 2): Resume session with failure context
   * - Level 3 (attempt 3): Fresh session with failure context
   */
  it("injects failure context into prompt on retry attempts", async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;

    mockQueryHandler = (args) => {
      callCount++;
      capturedPrompts.push(args.prompt);

      if (callCount <= 2) {
        // Fail first two attempts with retryable error
        return {
          [Symbol.asyncIterator]: () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: `session-${callCount}` };
              throw new Error(`Attempt ${callCount} failed: connection timeout`);
            })(),
        };
      }

      // Third attempt succeeds
      return {
        [Symbol.asyncIterator]: () => createAsyncIterator(successMessages("session-final", 0.03)),
      };
    };

    const attempts: Array<{ attempt: number; strategy: string }> = [];

    const result = await runWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 3,
      backoffBaseMs: 10,
      onAttempt: (attempt, strategy) => attempts.push({ attempt, strategy }),
    });

    // Verify result
    expect(result.sessionId).toBe("session-final");
    expect(result.output).toBe("Task completed successfully");

    // Verify 3 attempts were made with correct strategies
    expect(attempts).toEqual([
      { attempt: 1, strategy: "normal" },
      { attempt: 2, strategy: "resume" },
      { attempt: 3, strategy: "fresh" },
    ]);

    // Verify prompts captured
    expect(capturedPrompts).toHaveLength(3);

    // First prompt should be original (no failure context)
    expect(capturedPrompts[0]).toBe("Do something");
    expect(capturedPrompts[0]).not.toContain("PREVIOUS ATTEMPT FAILED");

    // Second prompt should include failure context from attempt 1
    expect(capturedPrompts[1]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[1]).toContain("attempt 1");
    expect(capturedPrompts[1]).toContain("strategy: normal");
    expect(capturedPrompts[1]).toContain("connection timeout");
    expect(capturedPrompts[1]).toContain("Do something"); // Original prompt still present

    // Third prompt should include failure context from attempt 2
    expect(capturedPrompts[2]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[2]).toContain("attempt 2");
    expect(capturedPrompts[2]).toContain("strategy: resume");
  });

  it("passes resumeSessionId on level 2 (resume strategy)", async () => {
    const capturedResumes: Array<string | undefined> = [];
    let callCount = 0;

    mockQueryHandler = (args) => {
      callCount++;
      capturedResumes.push(args.options.resume as string | undefined);

      if (callCount === 1) {
        // First attempt fails
        return {
          [Symbol.asyncIterator]: () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "session-first" };
              throw new Error("First attempt failed");
            })(),
        };
      }

      // Second attempt succeeds
      return {
        [Symbol.asyncIterator]: () => createAsyncIterator(successMessages("session-resumed")),
      };
    };

    const result = await runWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 2,
      backoffBaseMs: 10,
    });

    expect(result.sessionId).toBe("session-resumed");

    // Verify resumes captured
    expect(capturedResumes).toHaveLength(2);

    // First attempt should not have resume
    expect(capturedResumes[0]).toBeUndefined();

    // Second attempt (resume strategy) should have the session ID from first attempt
    expect(capturedResumes[1]).toBe("session-first");
  });

  it("clears resumeSessionId on level 3 (fresh strategy)", async () => {
    const capturedResumes: Array<string | undefined> = [];
    let callCount = 0;

    mockQueryHandler = (args) => {
      callCount++;
      capturedResumes.push(args.options.resume as string | undefined);

      if (callCount <= 2) {
        // First two attempts fail
        return {
          [Symbol.asyncIterator]: () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: `session-${callCount}` };
              throw new Error(`Attempt ${callCount} failed`);
            })(),
        };
      }

      // Third attempt succeeds
      return {
        [Symbol.asyncIterator]: () => createAsyncIterator(successMessages("session-fresh")),
      };
    };

    const result = await runWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(result.sessionId).toBe("session-fresh");

    // Verify 3 attempts
    expect(capturedResumes).toHaveLength(3);

    // First attempt (normal): no resume
    expect(capturedResumes[0]).toBeUndefined();

    // Second attempt (resume): has session from first
    expect(capturedResumes[1]).toBe("session-1");

    // Third attempt (fresh): no resume (cleared for fresh start)
    expect(capturedResumes[2]).toBeUndefined();
  });

  it("does not retry budget_exceeded errors (non-retryable)", async () => {
    const capturedPrompts: string[] = [];

    mockQueryHandler = (args) => {
      capturedPrompts.push(args.prompt);

      // Always return budget_exceeded error
      return {
        [Symbol.asyncIterator]: () =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "session-budget" };
            yield {
              type: "result",
              subtype: "budget_exceeded",
              session_id: "session-budget",
              result: "",
              total_cost_usd: 10.0,
            };
          })(),
      };
    };

    const attempts: number[] = [];

    await expect(
      runWithRecovery({
        ...makeSessionOptions(),
        maxRetries: 3,
        backoffBaseMs: 10,
        onAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toThrow("budget_exceeded");

    // Should only attempt once - budget_exceeded is non-retryable
    expect(attempts).toEqual([1]);
    expect(capturedPrompts).toHaveLength(1);

    // No failure context should be injected since there's no retry
    expect(capturedPrompts[0]).not.toContain("PREVIOUS ATTEMPT FAILED");
  });

  it("accumulates failure context correctly across retries", async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;

    mockQueryHandler = (args) => {
      callCount++;
      capturedPrompts.push(args.prompt);

      if (callCount === 1) {
        return {
          [Symbol.asyncIterator]: () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "session-1" };
              throw new Error("Network error: DNS resolution failed");
            })(),
        };
      }

      if (callCount === 2) {
        return {
          [Symbol.asyncIterator]: () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "session-2" };
              throw new Error("API rate limit exceeded");
            })(),
        };
      }

      return {
        [Symbol.asyncIterator]: () => createAsyncIterator(successMessages("session-success")),
      };
    };

    await runWithRecovery({
      ...makeSessionOptions({ prompt: "Original task prompt" }),
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(capturedPrompts).toHaveLength(3);

    // Prompt 1: original only
    expect(capturedPrompts[0]).toBe("Original task prompt");

    // Prompt 2: failure context from attempt 1 + original
    expect(capturedPrompts[1]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[1]).toContain("DNS resolution failed");
    expect(capturedPrompts[1]).toContain("Original task prompt");

    // Prompt 3: failure context from attempt 2 (replaces previous) + original
    // Note: Only the MOST RECENT failure context is injected, not accumulated
    expect(capturedPrompts[2]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[2]).toContain("API rate limit exceeded");
    expect(capturedPrompts[2]).toContain("Original task prompt");
    // Previous failure context is replaced, not accumulated
    expect(capturedPrompts[2]).not.toContain("DNS resolution failed");
  });

  it("extracts error type from SessionError correctly", async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;

    mockQueryHandler = (args) => {
      callCount++;
      capturedPrompts.push(args.prompt);

      if (callCount === 1) {
        // First attempt fails with SessionError (typed error)
        return {
          [Symbol.asyncIterator]: () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "session-typed-error" };
              yield {
                type: "result",
                subtype: "error_max_turns",
                session_id: "session-typed-error",
                result: "",
                total_cost_usd: 0.5,
              };
            })(),
        };
      }

      return {
        [Symbol.asyncIterator]: () => createAsyncIterator(successMessages("session-success")),
      };
    };

    await runWithRecovery({
      ...makeSessionOptions(),
      maxRetries: 2,
      backoffBaseMs: 10,
    });

    expect(capturedPrompts).toHaveLength(2);

    // Second prompt should include the typed error information
    expect(capturedPrompts[1]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[1]).toContain("error_max_turns");
  });
});

// ─── Integration: SessionExecutor budget_exceeded error is correctly typed ───

describe("Integration: SessionExecutor budget_exceeded error properties", () => {
  /**
   * This verifies that the SessionError thrown by SessionExecutor's budget check
   * has the correct errorType that makes it non-retryable in the recovery layer.
   *
   * The recovery layer checks: isNonRetryable(error, nonRetryable)
   * where nonRetryable defaults to ["budget_exceeded"]
   *
   * So we verify that SessionExecutor throws SessionError with errorType="budget_exceeded"
   */
  it("SessionExecutor budget check error has 'budget_exceeded' errorType", async () => {
    const sessionCost = 10.0;
    mockQueryHandler = () => ({
      [Symbol.asyncIterator]: () =>
        createAsyncIterator(successMessages("session-expensive", sessionCost)),
    });

    const executor = new SessionExecutor(
      {
        initTimeoutMs: 5_000,
        maxDurationMs: 60_000,
        maxRetries: 1,
        backoffBaseMs: 10,
      },
      () => undefined,
    );

    const input: SessionExecutionInput = {
      runId: "run-budget-type-check",
      sessionId: "session-type-check",
      agent: {
        name: "budget-agent",
        definition: {
          description: "Agent with budget limit",
          prompt: "You are a test agent.",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
        maxCost: 5.0, // Less than session cost
      },
      repoConfig: makeRepoConfig(),
      repoPath: "/tmp/test-repo",
      prompt: "Test task",
      gitStrategy: "branch",
      startedAt: new Date().toISOString(),
    };

    const deps: SessionExecutionDeps = {
      middleware: [],
    };

    try {
      await executor.execute(input, deps);
      expect.unreachable("Should have thrown SessionError");
    } catch (error) {
      // Verify the error is a SessionError with the exact errorType
      // that makes it non-retryable in recovery.ts
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).errorType).toBe("budget_exceeded");

      // This errorType is in DEFAULT_NON_RETRYABLE in recovery.ts
      // so this error will NOT be retried by runWithRecovery
      const DEFAULT_NON_RETRYABLE = ["budget_exceeded"];
      expect(DEFAULT_NON_RETRYABLE).toContain((error as SessionError).errorType);
    }
  });

  it("budget_exceeded error includes session ID for tracing", async () => {
    const sessionCost = 7.5;
    const expectedSessionId = "session-traceable";
    mockQueryHandler = () => ({
      [Symbol.asyncIterator]: () =>
        createAsyncIterator(successMessages(expectedSessionId, sessionCost)),
    });

    const executor = new SessionExecutor(
      {
        initTimeoutMs: 5_000,
        maxDurationMs: 60_000,
        maxRetries: 1,
        backoffBaseMs: 10,
      },
      () => undefined,
    );

    const input: SessionExecutionInput = {
      runId: "run-traceable",
      sessionId: "session-trace-test",
      agent: {
        name: "budget-agent",
        definition: {
          description: "Agent",
          prompt: "Test",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
        maxCost: 5.0,
      },
      repoConfig: makeRepoConfig(),
      repoPath: "/tmp/test-repo",
      prompt: "Test",
      gitStrategy: "branch",
      startedAt: new Date().toISOString(),
    };

    try {
      await executor.execute(input, { middleware: [] });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect((error as SessionError).sessionId).toBe(expectedSessionId);
    }
  });
});
