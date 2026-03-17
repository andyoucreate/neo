import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@/config";
import {
  buildFailedStepResult,
  buildMiddlewareContext,
  buildStepResult,
  executeSession,
  resolveMcpServers,
  type SessionExecutionInput,
  type SessionExecutionResult,
} from "@/orchestrator/session-executor";
import type { ResolvedAgent, WorkflowStepDef } from "@/types";

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

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
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

function makeTestAgent(): ResolvedAgent {
  return {
    name: "test-agent",
    definition: {
      description: "Test agent",
      prompt: "You are a test agent.",
      tools: ["Read", "Write"],
      model: "sonnet",
    },
    sandbox: "writable",
    source: "built-in",
  };
}

function makeMiddlewareContext() {
  return buildMiddlewareContext({
    runId: "run-123",
    workflow: "test-workflow",
    step: "test-step",
    agent: "test-agent",
    repo: "/tmp/test-repo",
  });
}

function makeSessionInput(overrides?: Partial<SessionExecutionInput>): SessionExecutionInput {
  return {
    agent: makeTestAgent(),
    prompt: "Do something",
    repoPath: "/tmp/test-repo",
    sessionConfig: {
      initTimeoutMs: 5_000,
      maxDurationMs: 60_000,
    },
    recoveryConfig: {
      maxRetries: 1,
      backoffBaseMs: 10,
    },
    middleware: [],
    middlewareContext: makeMiddlewareContext(),
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── executeSession ─────────────────────────────────────

describe("executeSession", () => {
  it("executes a session and returns result", async () => {
    const result = await executeSession(makeSessionInput());

    expect(result.sessionId).toBe("session-123");
    expect(result.parsed.rawOutput).toBe("Task completed successfully");
    expect(result.costUsd).toBe(0.05);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts PR URL from output", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-pr" },
      {
        type: "result",
        subtype: "success",
        session_id: "session-pr",
        result: "Done!\nPR_URL: https://github.com/org/repo/pull/42",
        total_cost_usd: 0.03,
        duration_ms: 800,
        num_turns: 2,
      },
    ];

    const result = await executeSession(makeSessionInput());

    expect(result.parsed.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(result.parsed.prNumber).toBe(42);
  });

  it("passes sessionPath for writable agents", async () => {
    const result = await executeSession(
      makeSessionInput({
        sessionPath: "/tmp/session-clone",
      }),
    );

    expect(result.sessionId).toBe("session-123");
  });

  it("passes MCP servers to session", async () => {
    const mcpServers: Record<string, McpServerConfig> = {
      github: { type: "stdio", command: "mcp-github", args: [] },
    };

    const result = await executeSession(makeSessionInput({ mcpServers }));

    expect(result.sessionId).toBe("session-123");
  });

  it("calls onAttempt callback", async () => {
    const attempts: Array<{ attempt: number; strategy: string }> = [];

    await executeSession(
      makeSessionInput({
        onAttempt: (attempt, strategy) => attempts.push({ attempt, strategy }),
      }),
    );

    expect(attempts).toEqual([{ attempt: 1, strategy: "normal" }]);
  });
});

// ─── buildStepResult ────────────────────────────────────

describe("buildStepResult", () => {
  it("builds a successful step result", () => {
    const executionResult: SessionExecutionResult = {
      sessionId: "session-abc",
      parsed: {
        rawOutput: "Task done",
        output: { status: "ok" },
      },
      sessionResult: {
        sessionId: "session-abc",
        output: "Task done",
        costUsd: 0.02,
        durationMs: 500,
        turnCount: 2,
      },
      durationMs: 500,
      costUsd: 0.02,
    };

    const stepResult = buildStepResult(executionResult, {
      agent: "developer",
      startedAt: "2024-01-01T00:00:00Z",
    });

    expect(stepResult.status).toBe("success");
    expect(stepResult.sessionId).toBe("session-abc");
    expect(stepResult.output).toEqual({ status: "ok" });
    expect(stepResult.rawOutput).toBe("Task done");
    expect(stepResult.costUsd).toBe(0.02);
    expect(stepResult.durationMs).toBe(500);
    expect(stepResult.agent).toBe("developer");
    expect(stepResult.startedAt).toBe("2024-01-01T00:00:00Z");
    expect(stepResult.attempt).toBe(1);
  });

  it("uses rawOutput when no structured output", () => {
    const executionResult: SessionExecutionResult = {
      sessionId: "session-raw",
      parsed: {
        rawOutput: "Plain text output",
      },
      sessionResult: {
        sessionId: "session-raw",
        output: "Plain text output",
        costUsd: 0.01,
        durationMs: 200,
        turnCount: 1,
      },
      durationMs: 200,
      costUsd: 0.01,
    };

    const stepResult = buildStepResult(executionResult, {
      agent: "reviewer",
      startedAt: "2024-01-01T00:00:00Z",
    });

    expect(stepResult.output).toBe("Plain text output");
  });

  it("includes PR URL and number when present", () => {
    const executionResult: SessionExecutionResult = {
      sessionId: "session-pr",
      parsed: {
        rawOutput: "Created PR",
        prUrl: "https://github.com/org/repo/pull/99",
        prNumber: 99,
      },
      sessionResult: {
        sessionId: "session-pr",
        output: "Created PR",
        costUsd: 0.05,
        durationMs: 1000,
        turnCount: 3,
      },
      durationMs: 1000,
      costUsd: 0.05,
    };

    const stepResult = buildStepResult(executionResult, {
      agent: "developer",
      startedAt: "2024-01-01T00:00:00Z",
    });

    expect(stepResult.prUrl).toBe("https://github.com/org/repo/pull/99");
    expect(stepResult.prNumber).toBe(99);
  });
});

// ─── buildFailedStepResult ──────────────────────────────

describe("buildFailedStepResult", () => {
  it("builds a failed step result from Error", () => {
    const error = new Error("Session timed out");

    const stepResult = buildFailedStepResult(error, {
      agent: "developer",
      startedAt: "2024-01-01T00:00:00Z",
      sessionId: "session-fail",
      durationMs: 5000,
    });

    expect(stepResult.status).toBe("failure");
    expect(stepResult.error).toBe("Session timed out");
    expect(stepResult.sessionId).toBe("session-fail");
    expect(stepResult.durationMs).toBe(5000);
    expect(stepResult.costUsd).toBe(0);
    expect(stepResult.attempt).toBe(1);
  });

  it("builds a failed step result from string", () => {
    const stepResult = buildFailedStepResult("Unknown error", {
      agent: "reviewer",
      startedAt: "2024-01-01T00:00:00Z",
      sessionId: "session-err",
      durationMs: 100,
    });

    expect(stepResult.error).toBe("Unknown error");
  });
});

// ─── resolveMcpServers ──────────────────────────────────

describe("resolveMcpServers", () => {
  const configServers: Record<string, McpServerConfig> = {
    github: { type: "stdio", command: "mcp-github", args: [] },
    jira: { type: "stdio", command: "mcp-jira", args: ["--project", "TEST"] },
    slack: { type: "stdio", command: "mcp-slack", args: [] },
  };

  it("returns undefined when no config servers", () => {
    const stepDef: WorkflowStepDef = { agent: "dev", mcpServers: ["github"] };
    const agent = makeTestAgent();

    const result = resolveMcpServers(stepDef, agent, undefined);

    expect(result).toBeUndefined();
  });

  it("returns undefined when no servers requested", () => {
    const stepDef: WorkflowStepDef = { agent: "dev" };
    const agent = makeTestAgent();

    const result = resolveMcpServers(stepDef, agent, configServers);

    expect(result).toBeUndefined();
  });

  it("resolves servers from step definition", () => {
    const stepDef: WorkflowStepDef = { agent: "dev", mcpServers: ["github", "jira"] };
    const agent = makeTestAgent();

    const result = resolveMcpServers(stepDef, agent, configServers);

    expect(result).toEqual({
      github: { type: "stdio", command: "mcp-github", args: [] },
      jira: { type: "stdio", command: "mcp-jira", args: ["--project", "TEST"] },
    });
  });

  it("resolves servers from agent definition", () => {
    const stepDef: WorkflowStepDef = { agent: "dev" };
    const agent: ResolvedAgent = {
      ...makeTestAgent(),
      definition: {
        ...makeTestAgent().definition,
        mcpServers: ["slack"],
      },
    };

    const result = resolveMcpServers(stepDef, agent, configServers);

    expect(result).toEqual({
      slack: { type: "stdio", command: "mcp-slack", args: [] },
    });
  });

  it("merges servers from step and agent definitions", () => {
    const stepDef: WorkflowStepDef = { agent: "dev", mcpServers: ["github"] };
    const agent: ResolvedAgent = {
      ...makeTestAgent(),
      definition: {
        ...makeTestAgent().definition,
        mcpServers: ["jira"],
      },
    };

    const result = resolveMcpServers(stepDef, agent, configServers);

    expect(result).toEqual({
      github: { type: "stdio", command: "mcp-github", args: [] },
      jira: { type: "stdio", command: "mcp-jira", args: ["--project", "TEST"] },
    });
  });

  it("ignores servers not in config", () => {
    const stepDef: WorkflowStepDef = { agent: "dev", mcpServers: ["github", "unknown"] };
    const agent = makeTestAgent();

    const result = resolveMcpServers(stepDef, agent, configServers);

    expect(result).toEqual({
      github: { type: "stdio", command: "mcp-github", args: [] },
    });
  });

  it("deduplicates server names", () => {
    const stepDef: WorkflowStepDef = { agent: "dev", mcpServers: ["github"] };
    const agent: ResolvedAgent = {
      ...makeTestAgent(),
      definition: {
        ...makeTestAgent().definition,
        mcpServers: ["github"], // Same as step
      },
    };

    const result = resolveMcpServers(stepDef, agent, configServers);

    expect(result).toEqual({
      github: { type: "stdio", command: "mcp-github", args: [] },
    });
  });
});

// ─── buildMiddlewareContext ─────────────────────────────

describe("buildMiddlewareContext", () => {
  it("creates context with basic params", () => {
    const ctx = buildMiddlewareContext({
      runId: "run-1",
      workflow: "dev",
      step: "implement",
      agent: "developer",
      repo: "/repo",
    });

    expect(ctx.runId).toBe("run-1");
    expect(ctx.workflow).toBe("dev");
    expect(ctx.step).toBe("implement");
    expect(ctx.agent).toBe("developer");
    expect(ctx.repo).toBe("/repo");
  });

  it("stores and retrieves custom values", () => {
    const ctx = buildMiddlewareContext({
      runId: "run-2",
      workflow: "dev",
      step: "test",
      agent: "tester",
      repo: "/repo",
    });

    ctx.set("custom" as never, "value" as never);
    expect(ctx.get("custom" as never)).toBe("value");
  });

  it("returns undefined for unknown keys", () => {
    const ctx = buildMiddlewareContext({
      runId: "run-3",
      workflow: "dev",
      step: "review",
      agent: "reviewer",
      repo: "/repo",
    });

    expect(ctx.get("unknown" as never)).toBeUndefined();
  });

  it("uses getters for well-known values", () => {
    const ctx = buildMiddlewareContext(
      {
        runId: "run-4",
        workflow: "dev",
        step: "deploy",
        agent: "deployer",
        repo: "/repo",
      },
      {
        getCostToday: () => 12.5,
        getBudgetCapUsd: () => 100,
      },
    );

    expect(ctx.get("costToday")).toBe(12.5);
    expect(ctx.get("budgetCapUsd")).toBe(100);
  });

  it("returns undefined when getter not provided", () => {
    const ctx = buildMiddlewareContext({
      runId: "run-5",
      workflow: "dev",
      step: "build",
      agent: "builder",
      repo: "/repo",
    });

    expect(ctx.get("costToday")).toBeUndefined();
    expect(ctx.get("budgetCapUsd")).toBeUndefined();
  });
});
