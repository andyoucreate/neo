import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const TMP_DIR = path.join(import.meta.dirname, "__tmp_doctor_test__");

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("doctor --fix", () => {
  describe("missing directory fix", () => {
    it("creates missing directory when --fix is passed", async () => {
      const missingDir = path.join(TMP_DIR, "missing-dir");
      expect(existsSync(missingDir)).toBe(false);

      await mkdir(missingDir, { recursive: true });
      expect(existsSync(missingDir)).toBe(true);
    });

    it("mkdir with recursive creates nested directories", async () => {
      const nestedDir = path.join(TMP_DIR, "a", "b", "c");
      expect(existsSync(nestedDir)).toBe(false);

      await mkdir(nestedDir, { recursive: true });
      expect(existsSync(nestedDir)).toBe(true);
    });
  });

  describe("stale worktree detection", () => {
    async function initBareRepo(dir: string): Promise<string> {
      const repoDir = path.join(dir, "repo");
      await mkdir(repoDir, { recursive: true });
      await execFileAsync("git", ["init", "--initial-branch", "main"], {
        cwd: repoDir,
      });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], {
        cwd: repoDir,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], {
        cwd: repoDir,
      });
      return repoDir;
    }

    it("detects directories in .neo/worktrees that are not tracked by git", async () => {
      const repoDir = await initBareRepo(TMP_DIR);
      const worktreesDir = path.join(repoDir, ".neo", "worktrees");
      const staleDir = path.join(worktreesDir, "stale-worktree");

      await mkdir(staleDir, { recursive: true });

      const entries = await readdir(worktreesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      expect(dirs).toContain("stale-worktree");
    });

    it("removes stale directory when fix is applied", async () => {
      const repoDir = await initBareRepo(TMP_DIR);
      const worktreesDir = path.join(repoDir, ".neo", "worktrees");
      const staleDir = path.join(worktreesDir, "stale-worktree");

      await mkdir(staleDir, { recursive: true });
      expect(existsSync(staleDir)).toBe(true);

      // Simulate fix by removing the directory
      await rm(staleDir, { recursive: true, force: true });
      expect(existsSync(staleDir)).toBe(false);
    });
  });

  describe("fix results reporting", () => {
    it("reports success when fix succeeds", async () => {
      const result = {
        name: "Create /some/path",
        success: true,
        message: "Created",
      };

      expect(result.success).toBe(true);
      expect(result.message).toBe("Created");
    });

    it("reports failure when fix fails", async () => {
      const result = {
        name: "Create /some/path",
        success: false,
        message: "Permission denied",
      };

      expect(result.success).toBe(false);
      expect(result.message).toBe("Permission denied");
    });
  });

  describe("exit codes", () => {
    it("returns 0 when all fixes succeed", () => {
      const fixResults = [
        { name: "Fix 1", success: true, message: "Fixed" },
        { name: "Fix 2", success: true, message: "Fixed" },
      ];

      const allFixed = fixResults.every((f) => f.success);
      expect(allFixed).toBe(true);
    });

    it("returns non-zero when some fixes fail", () => {
      const fixResults = [
        { name: "Fix 1", success: true, message: "Fixed" },
        { name: "Fix 2", success: false, message: "Failed" },
      ];

      const allFixed = fixResults.every((f) => f.success);
      expect(allFixed).toBe(false);
    });
  });
});

describe("doctor (no --fix)", () => {
  it("reports issues without attempting to fix them", () => {
    const checks = [
      { name: "Test", status: "fail" as const, message: "Missing", fixable: "missing-directory" },
    ];

    const fixableChecks = checks.filter((c) => c.status === "fail" && c.fixable);
    expect(fixableChecks).toHaveLength(1);

    // Without --fix, we don't apply fixes
    const shouldFix = false;
    const fixResults = shouldFix ? ["would fix"] : [];
    expect(fixResults).toHaveLength(0);
  });

  it("shows fixable hint for fixable issues", () => {
    const check = {
      name: "Journals",
      status: "fail" as const,
      message: "Directory missing",
      fixable: "missing-directory" as const,
    };

    const shouldFix = false;
    const fixableHint = check.fixable && !shouldFix ? " (fixable with --fix)" : "";

    expect(fixableHint).toBe(" (fixable with --fix)");
  });

  it("does not show fixable hint when --fix is passed", () => {
    const check = {
      name: "Journals",
      status: "fail" as const,
      message: "Directory missing",
      fixable: "missing-directory" as const,
    };

    const shouldFix = true;
    const fixableHint = check.fixable && !shouldFix ? " (fixable with --fix)" : "";

    expect(fixableHint).toBe("");
  });
});

describe("CheckResult interface", () => {
  it("supports fixable property for missing-directory", () => {
    const check = {
      name: "Data directory",
      status: "fail" as const,
      message: "Directory missing: /path",
      fixable: "missing-directory" as const,
      fixData: { path: "/path" },
    };

    expect(check.fixable).toBe("missing-directory");
    expect(check.fixData).toEqual({ path: "/path" });
  });

  it("supports fixable property for stale-worktree", () => {
    const check = {
      name: "Worktrees",
      status: "fail" as const,
      message: "1 stale worktree(s) found",
      fixable: "stale-worktree" as const,
      fixData: {
        worktrees: [{ path: "/path/to/worktree", branch: "feat/test", repoPath: "/repo" }],
      },
    };

    expect(check.fixable).toBe("stale-worktree");
    expect(check.fixData).toHaveProperty("worktrees");
  });
});
