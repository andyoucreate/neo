import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { runFixerPipeline } from "../../pipelines/fixer.js";
import type { FixerRequest, FixerIssue } from "../../types.js";

// Mock the claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock the hooks module
vi.mock("../../hooks.js", () => ({
  hooks: {},
}));

import { query } from "@anthropic-ai/claude-agent-sdk";

function createMockSuccessStream(allFixed = true): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "fixer-session-123",
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        status: allFixed ? "FIXED" : "PARTIAL",
        fixed: [
          { issue: "SQL injection", file: "src/db.ts", fix: "Used parameterized query" },
        ],
        unfixed: allFixed ? [] : [
          { issue: "Missing test", reason: "Would exceed 3 file limit" },
        ],
        files_modified: 2,
        tests_added: 1,
      }),
      total_cost_usd: 12.50,
      session_id: "fixer-session-123",
      is_error: false,
      duration_ms: 60000,
      num_turns: 15,
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

function createMockEscalatedStream(): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "fixer-session-escalated",
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        status: "ESCALATED",
        reason: "Fix requires changes to 5 files, exceeding 3 file limit",
        fixed: [],
        unfixed: [{ issue: "Architecture refactor needed" }],
      }),
      total_cost_usd: 8.00,
      session_id: "fixer-session-escalated",
      is_error: false,
      duration_ms: 30000,
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

function createMockFailureStream(): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "fixer-session-456",
      cwd: "/tmp",
      tools: [],
      model: "opus",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "error_max_turns",
      result: "Max turns reached while attempting fixes",
      total_cost_usd: 25.00,
      session_id: "fixer-session-456",
      is_error: true,
      duration_ms: 90000,
      num_turns: 50,
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

describe("Fixer Pipeline", () => {
  const mockQuery = vi.mocked(query);

  const sampleIssues: FixerIssue[] = [
    {
      source: "reviewer-security",
      severity: "CRITICAL",
      file: "src/auth.ts",
      line: 42,
      description: "SQL injection vulnerability",
      suggestion: "Use parameterized queries",
    },
    {
      source: "reviewer-coverage",
      severity: "HIGH",
      file: "src/auth.ts",
      line: 50,
      description: "Missing test for authentication edge case",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Successful fixes", () => {
    it("should return success when all issues are fixed", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream(true));

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
      expect(result.pipeline).toBe("fixer");
      expect(result.prNumber).toBe(42);
      expect(result.costUsd).toBe(12.50);
      expect(result.sessionId).toBe("fixer-session-123");
    });

    it("should return success for partial fixes (pipeline completed)", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream(false));

      const request: FixerRequest = {
        prNumber: 55,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      // Pipeline completed successfully, even with partial fixes
      expect(result.status).toBe("success");
      expect(result.summary).toContain("PARTIAL");
    });

    it("should handle escalation (scope exceeded)", async () => {
      mockQuery.mockReturnValue(createMockEscalatedStream());

      const request: FixerRequest = {
        prNumber: 77,
        repository: "github.com/org/repo",
        issues: [
          {
            source: "reviewer-quality",
            severity: "HIGH",
            file: "src/legacy.ts",
            line: 1,
            description: "Needs full refactor",
          },
        ],
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
      expect(result.summary).toContain("ESCALATED");
    });
  });

  describe("Pipeline configuration", () => {
    it("should use fixer agent", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      await runFixerPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.agents).toHaveProperty("fixer");
    });

    it("should have maxTurns set to 50", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      await runFixerPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.maxTurns).toBe(50);
    });

    it("should include issues in the prompt as JSON", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      await runFixerPipeline(request, "/tmp/repo");

      const prompt = mockQuery.mock.calls[0]?.[0]?.prompt;
      expect(prompt).toContain("SQL injection vulnerability");
      expect(prompt).toContain("CRITICAL");
      expect(prompt).toContain("src/auth.ts");
    });

    it("should set correct sandbox config for repo directory", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      await runFixerPipeline(request, "/custom/fixer/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.cwd).toBe("/custom/fixer/repo");
      expect(callOptions?.sandbox).toBeDefined();
    });

    it("should include fixer rules in prompt", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      await runFixerPipeline(request, "/tmp/repo");

      const prompt = mockQuery.mock.calls[0]?.[0]?.prompt;
      expect(prompt).toContain("ROOT CAUSES");
      expect(prompt).toContain("3 files");
      expect(prompt).toContain("3 fix attempts");
      expect(prompt).toContain("100 lines");
    });
  });

  describe("Issue severity handling", () => {
    it("should handle CRITICAL issues", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: [
          {
            source: "reviewer-security",
            severity: "CRITICAL",
            file: "src/api.ts",
            line: 10,
            description: "Remote code execution",
          },
        ],
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
    });

    it("should handle WARNING issues", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: [
          {
            source: "reviewer-quality",
            severity: "WARNING",
            file: "src/utils.ts",
            line: 25,
            description: "Function too long",
            suggestion: "Extract into smaller functions",
          },
        ],
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
    });
  });

  describe("Error handling", () => {
    it("should handle pipeline failure gracefully", async () => {
      mockQuery.mockReturnValue(createMockFailureStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      expect(result.status).toBe("failure");
      expect(result.costUsd).toBe(25.00);
    });

    it("should include duration and timestamp on failure", async () => {
      mockQuery.mockReturnValue(createMockFailureStream());

      const request: FixerRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: sampleIssues,
      };

      const result = await runFixerPipeline(request, "/tmp/repo");

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(result.prNumber).toBe(42);
    });
  });
});
