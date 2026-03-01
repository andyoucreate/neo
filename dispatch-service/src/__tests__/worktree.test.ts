import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

const { mockExecFile, mockRm } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:fs/promises", () => ({
  rm: mockRm,
}));

// Silence logger in tests
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  pruneWorktrees,
} from "../worktree.js";

// Helper: simulate a successful execFile callback
function resolveExecFile(stdout = "", stderr = "") {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      if (typeof callback === "function") {
        callback(null, { stdout, stderr });
      }
      return {} as ChildProcess;
    },
  );
}

// Helper: simulate a failed execFile callback
function rejectExecFile(error: Error) {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      if (typeof callback === "function") {
        callback(error);
      }
      return {} as ChildProcess;
    },
  );
}

describe("Worktree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRm.mockResolvedValue(undefined);
  });

  describe("createWorktree", () => {
    it("should run git fetch and git worktree add with correct args", async () => {
      // git fetch origin
      resolveExecFile();
      // git symbolic-ref (getDefaultBranch)
      resolveExecFile("origin/develop\n");
      // git worktree add
      resolveExecFile();

      await createWorktree("/repos/org/repo", "session-123");

      // First call: git fetch origin
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["fetch", "origin"],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );

      // Second call: git symbolic-ref
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );

      // Third call: git worktree add
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        [
          "worktree",
          "add",
          "-b",
          "voltaire/session-123",
          "/tmp/voltaire-worktrees/session-123",
          "origin/develop",
        ],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );
    });

    it("should return the worktree path", async () => {
      resolveExecFile();
      resolveExecFile("origin/main\n");
      resolveExecFile();

      const result = await createWorktree("/repos/org/repo", "session-456");

      expect(result).toBe("/tmp/voltaire-worktrees/session-456");
    });

    it("should use the provided branch name", async () => {
      resolveExecFile();
      resolveExecFile("origin/develop\n");
      resolveExecFile();

      await createWorktree("/repos/org/repo", "session-789", "feat/my-feature");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        [
          "worktree",
          "add",
          "-b",
          "feat/my-feature",
          "/tmp/voltaire-worktrees/session-789",
          "origin/develop",
        ],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );
    });

    it("should fall back to develop when symbolic-ref fails", async () => {
      resolveExecFile();
      rejectExecFile(new Error("not a symbolic ref"));
      resolveExecFile();

      await createWorktree("/repos/org/repo", "session-fallback");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        [
          "worktree",
          "add",
          "-b",
          "voltaire/session-fallback",
          "/tmp/voltaire-worktrees/session-fallback",
          "origin/develop",
        ],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );
    });
  });

  describe("removeWorktree", () => {
    it("should run git worktree remove", async () => {
      resolveExecFile();

      await removeWorktree("/repos/org/repo", "session-123");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "/tmp/voltaire-worktrees/session-123", "--force"],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );
    });

    it("should fallback to force cleanup on error", async () => {
      rejectExecFile(new Error("worktree not found"));
      // After rm, git worktree prune
      resolveExecFile();

      await removeWorktree("/repos/org/repo", "session-bad");

      // rm should have been called
      expect(mockRm).toHaveBeenCalledWith(
        "/tmp/voltaire-worktrees/session-bad",
        { recursive: true, force: true },
      );

      // git worktree prune should have been called
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["worktree", "prune"],
        expect.objectContaining({ cwd: "/repos/org/repo" }),
        expect.any(Function),
      );
    });
  });

  describe("listWorktrees", () => {
    it("should parse porcelain output correctly", async () => {
      const porcelainOutput = [
        "worktree /repos/org/repo",
        "HEAD abc1234",
        "branch refs/heads/main",
        "",
        "worktree /tmp/voltaire-worktrees/session-1",
        "HEAD def5678",
        "branch refs/heads/voltaire/session-1",
        "",
        "worktree /tmp/voltaire-worktrees/session-2",
        "HEAD 90abcde",
        "branch refs/heads/voltaire/session-2",
        "",
      ].join("\n");

      resolveExecFile(porcelainOutput);

      const result = await listWorktrees("/repos/org/repo");

      // Should only include worktrees under WORKTREE_BASE (/tmp/voltaire-worktrees)
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: "/tmp/voltaire-worktrees/session-1",
        branch: "refs/heads/voltaire/session-1",
        head: "def5678",
      });
      expect(result[1]).toEqual({
        path: "/tmp/voltaire-worktrees/session-2",
        branch: "refs/heads/voltaire/session-2",
        head: "90abcde",
      });
    });

    it("should return empty on error", async () => {
      rejectExecFile(new Error("git failed"));

      const result = await listWorktrees("/repos/org/repo");

      expect(result).toEqual([]);
    });
  });

  describe("pruneWorktrees", () => {
    it("should remove all listed worktrees", async () => {
      const porcelainOutput = [
        "worktree /tmp/voltaire-worktrees/session-a",
        "HEAD aaa1111",
        "branch refs/heads/voltaire/session-a",
        "",
        "worktree /tmp/voltaire-worktrees/session-b",
        "HEAD bbb2222",
        "branch refs/heads/voltaire/session-b",
        "",
      ].join("\n");

      // listWorktrees: git worktree list --porcelain
      resolveExecFile(porcelainOutput);
      // removeWorktree for session-a: git worktree remove
      resolveExecFile();
      // removeWorktree for session-b: git worktree remove
      resolveExecFile();

      const pruned = await pruneWorktrees("/repos/org/repo");

      expect(pruned).toBe(2);
    });

    it("should return 0 when no worktrees exist", async () => {
      resolveExecFile("");

      const pruned = await pruneWorktrees("/repos/org/repo");

      expect(pruned).toBe(0);
    });
  });
});
