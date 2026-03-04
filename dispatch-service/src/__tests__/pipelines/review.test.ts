import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewRequest } from "../../types.js";

// Create mock with custom promisify symbol so promisify(execFile) works correctly
const { mockExecFile, mockExecFileAsync } = vi.hoisted(() => {
  const fn = vi.fn();
  const asyncFn = vi.fn();
  const CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  Object.defineProperty(fn, CUSTOM, { value: asyncFn, writable: true, configurable: true });
  return { mockExecFile: fn, mockExecFileAsync: asyncFn };
});

// Mock the claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock the hooks module
vi.mock("../../hooks.js", () => ({
  hooks: {},
}));

// Mock child_process for gh CLI calls
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("../../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { runReviewPipeline } from "../../pipelines/review.js";

function createMockSuccessStream(approved = true): AsyncIterable<SDKMessage> {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "review-session-123",
      cwd: "/tmp",
      tools: [],
      model: "sonnet",
    } as SDKSystemMessage,
    {
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        verdict: approved ? "APPROVED" : "CHANGES_REQUESTED",
        summary: "Code review complete",
        issues: approved ? [] : [
          { severity: "CRITICAL", category: "security", file: "src/auth.ts", line: 42, description: "SQL injection" }
        ],
        stats: { files_reviewed: 5, critical: approved ? 0 : 1, high: 0, medium: 1, low: 2 }
      }),
      total_cost_usd: 12.50,
      session_id: "review-session-123",
      is_error: false,
      duration_ms: 45000,
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

function mockGhDiffSize(additions: number): void {
  mockExecFileAsync.mockResolvedValue({ stdout: String(additions), stderr: "" });
}

function mockGhDiffError(): void {
  mockExecFileAsync.mockRejectedValue(new Error("gh not found"));
}

describe("Review Pipeline", () => {
  const mockQuery = vi.mocked(query);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return a small diff (XS)
    mockGhDiffSize(15);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Agent selection based on diff size", () => {
    it("should use 1 combined reviewer for XS PRs (<50 lines)", async () => {
      mockGhDiffSize(35);
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      await runReviewPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      const agents = callOptions?.agents as Record<string, unknown>;
      expect(Object.keys(agents)).toHaveLength(1);
      expect(agents).toHaveProperty("combined-reviewer");
    });

    it("should use 2 reviewers for M PRs (50-300 lines)", async () => {
      mockGhDiffSize(200);
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 100,
        repository: "github.com/org/repo",
      };

      await runReviewPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      const agents = callOptions?.agents as Record<string, unknown>;
      expect(Object.keys(agents)).toHaveLength(2);
      expect(agents).toHaveProperty("quality-perf-reviewer");
      expect(agents).toHaveProperty("security-coverage-reviewer");
    });

    it("should use 4 reviewers for L/XL PRs (>300 lines)", async () => {
      mockGhDiffSize(700);
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 200,
        repository: "github.com/org/repo",
      };

      await runReviewPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      const agents = callOptions?.agents as Record<string, unknown>;
      expect(Object.keys(agents)).toHaveLength(4);
      expect(agents).toHaveProperty("reviewer-quality");
      expect(agents).toHaveProperty("reviewer-security");
      expect(agents).toHaveProperty("reviewer-perf");
      expect(agents).toHaveProperty("reviewer-coverage");
    });

    it("should default to M size when diff cannot be parsed", async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: "not a number", stderr: "" });
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 99,
        repository: "github.com/org/repo",
      };

      await runReviewPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      const agents = callOptions?.agents as Record<string, unknown>;
      // Default 100 lines = M size = 2 reviewers
      expect(Object.keys(agents)).toHaveLength(2);
    });

    it("should strip github.com/ prefix when calling gh api", async () => {
      mockGhDiffSize(10);
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 42,
        repository: "github.com/acme/lib",
      };

      await runReviewPipeline(request, "/tmp/repo");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "gh",
        ["api", "repos/acme/lib/pulls/42", "--jq", ".additions + .deletions"],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });
  });

  describe("Pipeline execution", () => {
    it("should return success for approved PRs", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream(true));

      const request: ReviewRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      const result = await runReviewPipeline(request, "/tmp/repo");

      expect(result.status).toBe("success");
      expect(result.pipeline).toBe("review");
      expect(result.prNumber).toBe(42);
      expect(result.repository).toBe("github.com/org/repo");
      expect(result.costUsd).toBe(12.50);
    });

    it("should still return success when changes requested", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream(false));

      const request: ReviewRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      const result = await runReviewPipeline(request, "/tmp/repo");

      // The pipeline completed, even if issues were found
      expect(result.status).toBe("success");
    });

    it("should use read-only sandbox for reviews", async () => {
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      await runReviewPipeline(request, "/tmp/repo");

      const callOptions = mockQuery.mock.calls[0]?.[0]?.options;
      expect(callOptions?.sandbox).toBeDefined();
      // Read-only sandbox should have empty allowWrite
      const sandbox = callOptions?.sandbox as { filesystem?: { allowWrite?: string[] } };
      expect(sandbox.filesystem?.allowWrite).toEqual([]);
    });
  });

  describe("Error handling", () => {
    it("should handle gh CLI failure gracefully", async () => {
      mockGhDiffError();
      mockQuery.mockReturnValue(createMockSuccessStream());

      const request: ReviewRequest = {
        prNumber: 42,
        repository: "github.com/org/repo",
      };

      // Should not throw, should default to M size
      const result = await runReviewPipeline(request, "/tmp/repo");
      expect(result.status).toBe("success");
    });
  });
});
