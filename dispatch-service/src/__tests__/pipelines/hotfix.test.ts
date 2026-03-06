import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { runHotfixPipeline } from "../../pipelines/hotfix.js";
import type { HotfixRequest, Priority } from "../../types.js";

// Mock the claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock the hooks module
vi.mock("../../hooks.js", () => ({
  hooks: {},
}));

import { query } from "@anthropic-ai/claude-agent-sdk";

function createMockSuccessStream(): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "hotfix-session-123",
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "success",
      result: "Hotfix applied. Root cause identified and fixed. Regression test added. PR #99 created.",
      total_cost_usd: 18.00,
      session_id: "hotfix-session-123",
      is_error: false,
      duration_ms: 90000,
      num_turns: 20,
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

function createMockFailureStream(): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "hotfix-session-456",
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "error_max_turns",
      result: "Unable to identify root cause within turn limit",
      total_cost_usd: 35.00,
      session_id: "hotfix-session-456",
      is_error: true,
      duration_ms: 150000,
      num_turns: 75,
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

describe("Hotfix Pipeline", () => {
  const mockQuery = vi.mocked(query);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Successful hotfix", () => {
    it("should run successfully for critical bugs", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: HotfixRequest = {
        ticketId: "BUG-123",
        title: "Production crash on login",
        priority: "critical",
        repository: "github.com/org/repo",
        description: "Users cannot log in due to null pointer exception",
      };

      const result = await runHotfixPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
      expect(result.pipeline).toBe("hotfix");
      expect(result.ticketId).toBe("BUG-123");
      expect(result.costUsd).toBe(18.00);
      expect(result.sessionId).toBe("hotfix-session-123");
    });

    it("should work for high priority bugs", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: HotfixRequest = {
        ticketId: "BUG-456",
        title: "Payment processing error",
        priority: "high",
        repository: "github.com/org/repo",
        description: "Some payments fail intermittently",
      };

      const result = await runHotfixPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
    });
  });

  describe("Pipeline configuration", () => {
    it("should use only developer agent (no architect)", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: HotfixRequest = {
        ticketId: "BUG-789",
        title: "CSS bug",
        priority: "medium",
        repository: "github.com/org/repo",
        description: "Button misaligned",
      };

      await runHotfixPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.agents).toHaveProperty("developer");
      expect(callOptions?.agents).not.toHaveProperty("architect");
    });

    it("should have unlimited turns (no maxTurns)", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: HotfixRequest = {
        ticketId: "BUG-101",
        title: "Quick fix needed",
        priority: "critical",
        repository: "github.com/org/repo",
        description: "Urgent issue",
      };

      await runHotfixPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.maxTurns).toBeUndefined();
    });

    it("should set correct sandbox config for repo directory", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: HotfixRequest = {
        ticketId: "BUG-202",
        title: "Test",
        priority: "low",
        repository: "github.com/org/repo",
        description: "",
      };

      await runHotfixPipeline(request, "/custom/hotfix/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.cwd).toBe("/custom/hotfix/repo");
      expect(callOptions?.sandbox).toBeDefined();
    });

    it("should include HOTFIX keyword in prompt based on priority", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const priorities: Priority[] = ["critical", "high", "medium", "low"];

      for (const priority of priorities) {
        vi.clearAllMocks();

        const request: HotfixRequest = {
          ticketId: `BUG-${priority}`,
          title: `${priority} bug`,
          priority,
          repository: "github.com/org/repo",
          description: "Test",
        };

        await runHotfixPipeline(request, "/tmp/repo");

        const prompt = mockQuery.mock.calls[0]?.[0]?.prompt;
        expect(prompt).toContain("HOTFIX");
        expect(prompt).toContain(priority.toUpperCase());
      }
    });
  });

  describe("Error handling", () => {
    it("should handle pipeline failure gracefully", async () => {
      mockQuery.mockReturnValue(createMockFailureStream());

      const request: HotfixRequest = {
        ticketId: "BUG-COMPLEX",
        title: "Complex bug",
        priority: "critical",
        repository: "github.com/org/repo",
        description: "Very hard to fix bug",
      };

      const result = await runHotfixPipeline(request, "/tmp/repo");

      expect(result.status).toBe("failure");
      expect(result.costUsd).toBe(35.00);
    });

    it("should include duration and timestamp on failure", async () => {
      mockQuery.mockReturnValue(createMockFailureStream());

      const request: HotfixRequest = {
        ticketId: "BUG-FAIL",
        title: "Failing bug",
        priority: "high",
        repository: "github.com/org/repo",
        description: "",
      };

      const result = await runHotfixPipeline(request, "/tmp/repo");

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(result.ticketId).toBe("BUG-FAIL");
    });
  });
});
