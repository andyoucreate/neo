import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { runQaPipeline } from "../../pipelines/qa.js";
import type { QaRequest } from "../../types.js";

// Mock the claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock the hooks module
vi.mock("../../hooks.js", () => ({
  hooks: {},
}));

// Mock the mcp module
vi.mock("../../mcp.js", () => ({
  mcpPlaywright: {
    playwright: {
      command: "npx",
      args: ["@playwright/mcp@latest"],
    },
  },
}));

import { query } from "@anthropic-ai/claude-agent-sdk";

function createMockSuccessStream(verdict: "PASS" | "FAIL" = "PASS"): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "qa-session-123",
      cwd: "/tmp",
      tools: [],
      model: "sonnet",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        verdict,
        smoke_tests: { passed: 10, failed: verdict === "PASS" ? 0 : 2 },
        e2e_tests: { passed: 5, failed: 0 },
        visual_regression: { passed: 3, failed: 0, new_baselines: 1 },
        blocking_issues: verdict === "FAIL" ? [{ test: "login", reason: "Timeout" }] : [],
      }),
      total_cost_usd: 8.25,
      session_id: "qa-session-123",
      is_error: false,
      duration_ms: 120000,
      num_turns: 30,
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
      session_id: "qa-session-456",
      cwd: "/tmp",
      tools: [],
      model: "sonnet",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "error_max_turns",
      result: "Max turns reached during QA execution",
      total_cost_usd: 15.00,
      session_id: "qa-session-456",
      is_error: true,
      duration_ms: 180000,
      num_turns: 100,
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

describe("QA Pipeline", () => {
  const mockQuery = vi.mocked(query);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Successful QA runs", () => {
    it("should return success when all tests pass", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream("PASS"));

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      const result = await runQaPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
      expect(result.pipeline).toBe("qa");
      expect(result.prNumber).toBe(42);
      expect(result.costUsd).toBe(8.25);
      expect(result.sessionId).toBe("qa-session-123");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("should still return success when QA completes with failing tests", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream("FAIL"));

      const request: QaRequest = {
        prNumber: 99,
        repository: "github.com/org/repo",
      };

      const result = await runQaPipeline(request, "/tmp/repo");

      // Pipeline completed successfully, even though tests failed
      expect(result.status).toBe("success");
      expect(result.summary).toContain("FAIL");
    });
  });

  describe("Pipeline configuration", () => {
    it("should use qa-playwright agent", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      await runQaPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.agents).toHaveProperty("qa-playwright");
    });

    it("should include Playwright MCP server config", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      await runQaPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.mcpServers).toBeDefined();
      expect(callOptions?.mcpServers).toHaveProperty("playwright");
    });

    it("should set correct sandbox for repo directory", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      await runQaPipeline(request, "/custom/repo/path");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.cwd).toBe("/custom/repo/path");
      expect(callOptions?.sandbox).toBeDefined();
    });

    it("should have maxTurns set to 100", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      await runQaPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.maxTurns).toBe(100);
    });
  });

  describe("Error handling", () => {
    it("should handle pipeline failure gracefully", async () => {
      mockQuery.mockReturnValue(createMockFailureStream());

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      const result = await runQaPipeline(request, "/tmp/repo");

      expect(result.status).toBe("failure");
      expect(result.costUsd).toBe(15.00);
    });

    it("should include duration even on failure", async () => {
      mockQuery.mockReturnValue(createMockFailureStream());

      const request: QaRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      const result = await runQaPipeline(request, "/tmp/repo");

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    });
  });
});
