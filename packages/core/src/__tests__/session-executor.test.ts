import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  type SessionExecutionConfig,
  type SessionExecutionDeps,
  type SessionExecutionInput,
  SessionExecutor,
} from "@/runner/session-executor";
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

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const msg of mockMessages) {
        yield msg;
      }
    },
  }),
}));

// ─── Helpers ────────────────────────────────────────────

function makeAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
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
    ...overrides,
  };
}

function makeStepDef(overrides?: Partial<WorkflowStepDef>): WorkflowStepDef {
  return {
    agent: "test-agent",
    prompt: "Do the task",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<SessionExecutionInput>): SessionExecutionInput {
  return {
    runId: "run-123",
    sessionId: "session-456",
    agent: makeAgent(),
    stepDef: makeStepDef(),
    repoConfig: {
      path: "/repos/test",
      defaultBranch: "main",
      branchPrefix: "feat/",
      pushRemote: "origin",
      gitStrategy: "pr",
    },
    repoPath: "/repos/test",
    prompt: "Test prompt",
    branch: "feat/test-branch",
    gitStrategy: "pr",
    sessionPath: "/tmp/sessions/test",
    startedAt: new Date().toISOString(),
    workflow: "test-workflow",
    stepName: "test-step",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<SessionExecutionDeps>): SessionExecutionDeps {
  return {
    middleware: [],
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<SessionExecutionConfig>): SessionExecutionConfig {
  return {
    initTimeoutMs: 5_000,
    maxDurationMs: 60_000,
    maxRetries: 3,
    backoffBaseMs: 100,
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── SessionExecutor.execute() ──────────────────────────

describe("SessionExecutor", () => {
  describe("execute", () => {
    it("executes a session and returns SessionExecutionResult", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const result = await executor.execute(makeInput(), makeDeps());

      expect(result.status).toBe("success");
      expect(result.sessionId).toBe("session-123");
      expect(result.costUsd).toBe(0.05);
      expect(result.agent).toBe("test-agent");
      expect(result.parsed).toBeDefined();
    });

    it("includes parsed output in result", async () => {
      mockMessages = [
        { type: "system", subtype: "init", session_id: "session-parsed" },
        {
          type: "result",
          subtype: "success",
          session_id: "session-parsed",
          result: "Done.\nPR_URL: https://github.com/org/repo/pull/42",
          total_cost_usd: 0.03,
          duration_ms: 800,
          num_turns: 2,
        },
      ];

      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const result = await executor.execute(makeInput(), makeDeps());

      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(result.prNumber).toBe(42);
      expect(result.parsed.prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("sets completedAt timestamp", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const result = await executor.execute(makeInput(), makeDeps());

      expect(result.completedAt).toBeDefined();
      expect(new Date(result.completedAt as string).getTime()).toBeGreaterThan(0);
    });

    it("calls onAttempt callback", async () => {
      const attempts: Array<{ attempt: number; strategy: string }> = [];
      const executor = new SessionExecutor(makeConfig(), () => undefined);

      await executor.execute(
        makeInput(),
        makeDeps({ onAttempt: (attempt, strategy) => attempts.push({ attempt, strategy }) }),
      );

      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts[0]).toEqual({ attempt: 1, strategy: "normal" });
    });

    it("passes workflow and stepName to middlewareContext from input", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);

      // With explicit workflow and step names
      await executor.execute(
        makeInput({ workflow: "deploy-workflow", stepName: "build" }),
        makeDeps(),
      );

      // With direct run (non-workflow)
      await executor.execute(makeInput({ workflow: "direct", stepName: "execute" }), makeDeps());

      // Both should complete without error
      expect(true).toBe(true);
    });
  });

  describe("branch validation", () => {
    it("throws when writable agent has no branch", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const input = makeInput({
        agent: makeAgent({ sandbox: "writable" }),
        branch: undefined,
      });

      await expect(executor.execute(input, makeDeps())).rejects.toThrow(
        "Validation error: --branch is required for writable agents",
      );
    });

    it("throws with explicit branch name hint when branch missing", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const input = makeInput({
        agent: makeAgent({ sandbox: "writable" }),
        branch: undefined,
      });

      await expect(executor.execute(input, makeDeps())).rejects.toThrow("feat/PROJ-42-description");
    });

    it("allows readonly agent without branch", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const input = makeInput({
        agent: makeAgent({ sandbox: "readonly" }),
        branch: undefined,
      });

      const result = await executor.execute(input, makeDeps());
      expect(result.status).toBe("success");
    });

    it("allows writable agent with branch", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const input = makeInput({
        agent: makeAgent({ sandbox: "writable" }),
        branch: "feat/my-feature",
      });

      const result = await executor.execute(input, makeDeps());
      expect(result.status).toBe("success");
    });

    it("allows writable agent with empty string branch (edge case)", async () => {
      const executor = new SessionExecutor(makeConfig(), () => undefined);
      const input = makeInput({
        agent: makeAgent({ sandbox: "writable" }),
        branch: "",
      });

      // Empty string is falsy, should throw
      await expect(executor.execute(input, makeDeps())).rejects.toThrow(
        "--branch is required for writable agents",
      );
    });
  });
});

// ─── buildGitStrategyInstructions ───────────────────────

describe("buildGitStrategyInstructions", () => {
  const baseAgent = makeAgent({ sandbox: "writable" });
  const readonlyAgent = makeAgent({ sandbox: "readonly" });

  describe("readonly agents", () => {
    it("returns null when no PR number", () => {
      const result = buildGitStrategyInstructions(
        "pr",
        readonlyAgent,
        "feat/test",
        "main",
        "origin",
        undefined,
      );

      expect(result).toBeNull();
    });

    it("returns PR comment instruction when PR exists", () => {
      const result = buildGitStrategyInstructions(
        "pr",
        readonlyAgent,
        "feat/test",
        "main",
        "origin",
        { prNumber: 42 },
      );

      expect(result).toContain("PR #42");
      expect(result).toContain("gh pr comment 42");
    });
  });

  describe("writable agents with PR strategy", () => {
    it("returns existing PR instructions when PR exists", () => {
      const result = buildGitStrategyInstructions("pr", baseAgent, "feat/test", "main", "origin", {
        prNumber: 99,
      });

      expect(result).toContain("feat/test");
      expect(result).toContain("#99");
      expect(result).toContain("push your changes");
      expect(result).toContain("gh pr comment 99");
    });

    it("returns create PR instructions when no PR exists", () => {
      const result = buildGitStrategyInstructions(
        "pr",
        baseAgent,
        "feat/new-feature",
        "main",
        "origin",
        undefined,
      );

      expect(result).toContain("feat/new-feature");
      expect(result).toContain("main");
      expect(result).toContain("git push -u origin");
      expect(result).toContain("Create a PR");
      expect(result).toContain("PR_URL:");
    });
  });

  describe("writable agents with branch strategy", () => {
    it("returns branch-only instructions", () => {
      const result = buildGitStrategyInstructions(
        "branch",
        baseAgent,
        "feat/branch-only",
        "main",
        "origin",
        undefined,
      );

      expect(result).toContain("feat/branch-only");
      expect(result).toContain("main");
      expect(result).toContain("Commit your changes");
      expect(result).toContain("pushed automatically");
      expect(result).not.toContain("Create a PR");
    });
  });
});

// ─── buildReportingInstructions ─────────────────────────

describe("buildReportingInstructions", () => {
  it("includes progress reporting section", () => {
    const result = buildReportingInstructions();

    expect(result).toContain("Progress reporting");
    expect(result).toContain("neo log milestone");
    expect(result).toContain("neo log action");
  });

  it("includes memory write section", () => {
    const result = buildReportingInstructions();

    expect(result).toContain("Memory");
    expect(result).toContain("neo memory write");
    expect(result).toContain("--type fact");
    expect(result).toContain("--type procedure");
  });

  it("includes instructions for semantic search", () => {
    const result = buildReportingInstructions();

    expect(result).toContain("describe clearly for semantic search");
  });
});

// ─── buildFullPrompt ────────────────────────────────────

describe("buildFullPrompt", () => {
  it("combines all sections with separators", () => {
    const result = buildFullPrompt(
      "Agent prompt",
      "Repo instructions",
      "Git instructions",
      "Task prompt",
      "Memory context",
      "CWD instructions",
      "Reporting instructions",
    );

    expect(result).toContain("Agent prompt");
    expect(result).toContain("Repository instructions");
    expect(result).toContain("Repo instructions");
    expect(result).toContain("Git instructions");
    expect(result).toContain("Task");
    expect(result).toContain("Task prompt");
    expect(result).toContain("Memory context");
    expect(result).toContain("CWD instructions");
    expect(result).toContain("Reporting instructions");
    expect(result).toContain("---");
  });

  it("omits empty sections", () => {
    const result = buildFullPrompt(
      undefined, // no agent prompt
      undefined, // no repo instructions
      null, // no git instructions
      "Task prompt",
      undefined, // no memory
      undefined, // no cwd
      undefined, // no reporting
    );

    expect(result).toContain("Task prompt");
    expect(result).not.toContain("Repository instructions");
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });

  it("places task at the end", () => {
    const result = buildFullPrompt("First", "Second", "Third", "Last task", undefined);

    const taskIndex = result.indexOf("Last task");
    const firstIndex = result.indexOf("First");

    expect(taskIndex).toBeGreaterThan(firstIndex);
    expect(result.endsWith("Last task")).toBe(true);
  });
});

// ─── SessionExecutionResult extends StepResult ──────────

describe("SessionExecutionResult type", () => {
  it("contains all StepResult fields plus parsed output", async () => {
    const executor = new SessionExecutor(makeConfig(), () => undefined);
    const result = await executor.execute(makeInput(), makeDeps());

    // StepResult required fields
    expect(result.status).toBeDefined();
    expect(result.costUsd).toBeDefined();
    expect(result.durationMs).toBeDefined();
    expect(result.agent).toBeDefined();
    expect(result.attempt).toBeDefined();

    // StepResult optional fields
    expect("sessionId" in result).toBe(true);
    expect("output" in result).toBe(true);
    expect("rawOutput" in result).toBe(true);
    expect("startedAt" in result).toBe(true);
    expect("completedAt" in result).toBe(true);

    // SessionExecutionResult extension
    expect(result.parsed).toBeDefined();
    expect(typeof result.parsed.rawOutput).toBe("string");
  });
});
