import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";

// Create mock with custom promisify symbol so promisify(execFile) works correctly
const { mockExecFile, mockExecFileAsync } = vi.hoisted(() => {
  const fn = vi.fn();
  const asyncFn = vi.fn();
  const CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  Object.defineProperty(fn, CUSTOM, { value: asyncFn, writable: true, configurable: true });
  return { mockExecFile: fn, mockExecFileAsync: asyncFn };
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { pollCiChecks } from "../ci-check.js";

function mockGhChecks(checks: Array<{ name: string; state: string; bucket: string }>): void {
  mockExecFileAsync.mockResolvedValue({ stdout: JSON.stringify(checks), stderr: "" });
}

function mockGhError(message: string): void {
  mockExecFileAsync.mockRejectedValue(new Error(message));
}

describe("pollCiChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should return success when all checks pass", async () => {
    mockGhChecks([
      { name: "build", state: "SUCCESS", bucket: "pass" },
      { name: "lint", state: "SUCCESS", bucket: "pass" },
    ]);

    const result = await pollCiChecks(42, "github.com/org/repo");

    expect(result.conclusion).toBe("success");
    expect(result.failedChecks).toBeUndefined();
  });

  it("should return failure with failed checks", async () => {
    mockGhChecks([
      { name: "build", state: "SUCCESS", bucket: "pass" },
      { name: "test", state: "FAILURE", bucket: "fail" },
    ]);

    const result = await pollCiChecks(42, "github.com/org/repo");

    expect(result.conclusion).toBe("failure");
    expect(result.failedChecks).toEqual([
      { name: "test", state: "FAILURE" },
    ]);
  });

  it("should treat cancelled checks as failures", async () => {
    mockGhChecks([
      { name: "deploy", state: "CANCELLED", bucket: "cancel" },
    ]);

    const result = await pollCiChecks(42, "github.com/org/repo");

    expect(result.conclusion).toBe("failure");
    expect(result.failedChecks).toHaveLength(1);
  });

  it("should treat skipping checks as success", async () => {
    mockGhChecks([
      { name: "build", state: "SUCCESS", bucket: "pass" },
      { name: "optional", state: "SKIPPED", bucket: "skipping" },
    ]);

    const result = await pollCiChecks(42, "github.com/org/repo");

    expect(result.conclusion).toBe("success");
  });

  it("should return no_checks when empty array", async () => {
    mockGhChecks([]);

    const result = await pollCiChecks(42, "github.com/org/repo");

    expect(result.conclusion).toBe("no_checks");
  });

  it("should strip github.com/ prefix from repository", async () => {
    mockGhChecks([{ name: "ci", state: "SUCCESS", bucket: "pass" }]);

    await pollCiChecks(42, "github.com/acme/lib");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "gh",
      ["pr", "checks", "42", "--repo", "acme/lib", "--json", "name,state,bucket"],
      { timeout: 15_000 },
    );
  });

  it("should use correct gh CLI args", async () => {
    mockGhChecks([{ name: "ci", state: "SUCCESS", bucket: "pass" }]);

    await pollCiChecks(99, "github.com/org/repo");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "gh",
      ["pr", "checks", "99", "--repo", "org/repo", "--json", "name,state,bucket"],
      { timeout: 15_000 },
    );
  });

  describe("error handling", () => {
    it("should return no_checks when gh says no checks", async () => {
      mockGhError("no checks reported on the 'main' branch");

      const result = await pollCiChecks(42, "github.com/org/repo");

      expect(result.conclusion).toBe("no_checks");
    });

    it("should return no_checks for 'no check runs' error", async () => {
      mockGhError("no check runs found");

      const result = await pollCiChecks(42, "github.com/org/repo");

      expect(result.conclusion).toBe("no_checks");
    });

    it("should return error for other gh failures", async () => {
      mockGhError("gh: command not found");

      const result = await pollCiChecks(42, "github.com/org/repo");

      expect(result.conclusion).toBe("error");
      expect(result.details).toContain("gh: command not found");
    });
  });
});
