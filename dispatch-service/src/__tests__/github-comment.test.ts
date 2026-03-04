import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postReviewComment } from "../github-comment.js";
import type { PipelineResult } from "../types.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock logger
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { execFile } from "node:child_process";
import { logger } from "../logger.js";

const mockExecFile = vi.mocked(execFile);

function makeResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    sessionId: "test-session-1",
    pipeline: "review",
    status: "success",
    prNumber: 42,
    repository: "github.com/org/repo",
    summary: JSON.stringify({
      verdict: "APPROVED",
      summary: "Code looks good",
      issues: [],
      stats: { files_reviewed: 5, critical: 0, high: 0, medium: 0, low: 0 },
    }),
    costUsd: 2.5,
    durationMs: 30000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function mockExecFileSuccess(): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof _opts === "function") {
      _opts(null, "", "");
    } else if (typeof callback === "function") {
      callback(null, "", "");
    }
    return {} as ReturnType<typeof execFile>;
  });
}

function mockExecFileFailure(error: string): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const err = new Error(error);
    if (typeof _opts === "function") {
      _opts(err, "", "");
    } else if (typeof callback === "function") {
      callback(err, "", "");
    }
    return {} as ReturnType<typeof execFile>;
  });
}

describe("postReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSuccess();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Guard clauses", () => {
    it("should skip when prNumber is missing", async () => {
      await postReviewComment(makeResult({ prNumber: undefined }));

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing prNumber or repository"),
      );
    });

    it("should skip when repository is missing", async () => {
      await postReviewComment(makeResult({ repository: undefined }));

      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("should skip when summary is empty", async () => {
      await postReviewComment(makeResult({ summary: "" }));

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("empty summary"),
      );
    });
  });

  describe("GitHub CLI call", () => {
    it("should call gh pr comment with correct args", async () => {
      await postReviewComment(makeResult());

      expect(mockExecFile).toHaveBeenCalledWith(
        "gh",
        ["pr", "comment", "42", "--repo", "org/repo", "--body", expect.any(String)],
        { timeout: 30_000 },
        expect.any(Function),
      );
    });

    it("should strip github.com/ prefix from repository", async () => {
      await postReviewComment(makeResult({ repository: "github.com/acme/lib" }));

      const args = mockExecFile.mock.calls[0]?.[1] as string[];
      expect(args[4]).toBe("acme/lib");
    });

    it("should log success after posting", async () => {
      await postReviewComment(makeResult());

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Posted review comment on PR #42"),
      );
    });
  });

  describe("Markdown formatting — structured JSON", () => {
    it("should format APPROVED verdict", async () => {
      await postReviewComment(makeResult());

      const body = (mockExecFile.mock.calls[0]?.[1] as string[])[6];
      expect(body).toContain("Voltaire Review");
      expect(body).toContain("APPROVED");
      expect(body).toContain("Code looks good");
    });

    it("should format CHANGES_REQUESTED with issues table", async () => {
      const summary = JSON.stringify({
        verdict: "CHANGES_REQUESTED",
        summary: "Found issues",
        issues: [
          {
            severity: "CRITICAL",
            category: "security",
            file: "src/auth.ts",
            line: 42,
            description: "SQL injection vulnerability",
          },
          {
            severity: "WARNING",
            category: "naming",
            file: "src/utils.ts",
            line: 10,
            description: "Misleading variable name",
          },
        ],
        stats: { files_reviewed: 3, critical: 1, high: 0, medium: 0, low: 0 },
      });

      await postReviewComment(makeResult({ summary }));

      const body = (mockExecFile.mock.calls[0]?.[1] as string[])[6];
      expect(body).toContain("CHANGES_REQUESTED");
      expect(body).toContain("SQL injection vulnerability");
      expect(body).toContain("`src/auth.ts:42`");
      expect(body).toContain("CRITICAL");
      expect(body).toContain("Misleading variable name");
      expect(body).toContain("Issues");
    });

    it("should include stats footer", async () => {
      await postReviewComment(makeResult());

      const body = (mockExecFile.mock.calls[0]?.[1] as string[])[6];
      expect(body).toContain("files reviewed");
    });

    it("should include risk_level when present", async () => {
      const summary = JSON.stringify({
        verdict: "CHANGES_REQUESTED",
        summary: "Security issues",
        risk_level: "HIGH",
        issues: [],
        stats: {},
      });

      await postReviewComment(makeResult({ summary }));

      const body = (mockExecFile.mock.calls[0]?.[1] as string[])[6];
      expect(body).toContain("Risk level");
      expect(body).toContain("HIGH");
    });
  });

  describe("Markdown formatting — fallback", () => {
    it("should use raw summary when JSON parse fails", async () => {
      const rawText = "This is a plain text review with no JSON structure";

      await postReviewComment(makeResult({ summary: rawText }));

      const body = (mockExecFile.mock.calls[0]?.[1] as string[])[6];
      expect(body).toContain("Voltaire Review");
      expect(body).toContain(rawText);
    });

    it("should handle JSON in markdown code fences", async () => {
      const summary = `Here is the review:
\`\`\`json
{"verdict":"APPROVED","summary":"All good","issues":[],"stats":{"files_reviewed":2}}
\`\`\`
End of review.`;

      await postReviewComment(makeResult({ summary }));

      const body = (mockExecFile.mock.calls[0]?.[1] as string[])[6];
      expect(body).toContain("APPROVED");
      expect(body).toContain("All good");
    });
  });

  describe("Error handling", () => {
    it("should not throw when gh CLI fails", async () => {
      mockExecFileFailure("gh: command not found");

      await expect(postReviewComment(makeResult())).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to post review comment"),
        expect.any(Error),
      );
    });

    it("should not throw when gh returns non-zero exit", async () => {
      mockExecFileFailure("exit code 1: not found");

      await expect(postReviewComment(makeResult())).resolves.toBeUndefined();
    });
  });
});
