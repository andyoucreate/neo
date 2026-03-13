import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../config.js";
import {
  createBranch,
  getBranchName,
  getCurrentBranch,
} from "../isolation/git.js";
import { withGitLock } from "../isolation/git-mutex.js";
import { buildSandboxConfig } from "../isolation/sandbox.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
} from "../isolation/worktree.js";
import type { ResolvedAgent } from "../types.js";

const execFileAsync = promisify(execFile);
const TMP_DIR = path.join(import.meta.dirname, "__tmp_isolation_test__");

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
  // Create an initial commit so branches can be created
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: repoDir,
  });
  return repoDir;
}

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Git Mutex ──────────────────────────────────────────

describe("withGitLock", () => {
  it("serializes concurrent operations on the same repo", async () => {
    const order: number[] = [];

    const op1 = withGitLock("/fake/repo", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
      return "a";
    });

    const op2 = withGitLock("/fake/repo", async () => {
      order.push(3);
      return "b";
    });

    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe("a");
    expect(r2).toBe("b");
    // op1 must complete (1, 2) before op2 starts (3)
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs operations on different repos in parallel", async () => {
    const order: string[] = [];

    const op1 = withGitLock("/repo/a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
    });

    const op2 = withGitLock("/repo/b", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("b-end");
    });

    await Promise.all([op1, op2]);

    // Both should start before either ends
    expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("b-end"));
    // b-start should happen before a-end (parallel execution)
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
  });

  it("releases lock on error (try/finally)", async () => {
    await expect(
      withGitLock("/repo/err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Next operation on same repo should succeed (lock was released)
    const result = await withGitLock("/repo/err", async () => "ok");
    expect(result).toBe("ok");
  });
});

// ─── Worktree Lifecycle ─────────────────────────────────

describe("worktree lifecycle", () => {
  it("create → verify exists → remove → verify gone", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const worktreeDir = path.join(TMP_DIR, "wt-test");

    const info = await createWorktree({
      repoPath: repoDir,
      branch: "feat/test-branch",
      baseBranch: "main",
      worktreeDir,
    });

    expect(info.path).toBe(path.resolve(worktreeDir));
    expect(info.branch).toBe("feat/test-branch");
    expect(info.repoPath).toBe(path.resolve(repoDir));
    expect(existsSync(worktreeDir)).toBe(true);

    // Should appear in list
    const list = await listWorktrees(repoDir);
    const found = list.find((w) => w.branch === "feat/test-branch");
    expect(found).toBeDefined();

    // Remove
    await removeWorktree(worktreeDir);
    expect(existsSync(worktreeDir)).toBe(false);
  });

  it("throws when creating worktree on non-existent repo", async () => {
    const fakeRepo = path.join(TMP_DIR, "nonexistent-repo");
    const worktreeDir = path.join(TMP_DIR, "wt-fail");

    await expect(
      createWorktree({
        repoPath: fakeRepo,
        branch: "feat/fail",
        baseBranch: "main",
        worktreeDir,
      }),
    ).rejects.toThrow();
  });

  it("removeWorktree is idempotent (no throw for non-existent)", async () => {
    const fakePath = path.join(TMP_DIR, "nonexistent-worktree");
    // Should not throw
    await removeWorktree(fakePath);
  });
});

// ─── Git Operations ─────────────────────────────────────

describe("git operations", () => {
  it("creates a branch and reads current branch", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await createBranch(repoDir, "feat/new-branch", "main");

    // Verify branch exists by checking out
    await execFileAsync("git", ["checkout", "feat/new-branch"], {
      cwd: repoDir,
    });
    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe("feat/new-branch");
  });

  it("getBranchName generates correct branch name", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      autoCreatePr: false,
    };

    expect(getBranchName(config, "abc123")).toBe("feat/run-abc123");
    expect(getBranchName(config, "ABC-DEF")).toBe("feat/run-abc-def");
  });

  it("getBranchName respects custom branchPrefix", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "fix",
      pushRemote: "origin",
      autoCreatePr: false,
    };

    expect(getBranchName(config, "hotfix-1")).toBe("fix/run-hotfix-1");
  });
});

// ─── Sandbox Config ─────────────────────────────────────

describe("buildSandboxConfig", () => {
  function makeAgent(sandbox: "writable" | "readonly"): ResolvedAgent {
    return {
      name: "test-agent",
      definition: {
        description: "Test",
        prompt: "You are a test agent.",
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        model: "opus",
      },
      sandbox,
      source: "built-in",
    };
  }

  it("writable agent gets all tools and write paths", () => {
    const config = buildSandboxConfig(makeAgent("writable"), "/tmp/wt");

    expect(config.writable).toBe(true);
    expect(config.allowedTools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
    ]);
    expect(config.writablePaths).toEqual(["/tmp/wt"]);
    expect(config.readablePaths).toEqual(["/tmp/wt"]);
  });

  it("readonly agent has write tools filtered out", () => {
    const config = buildSandboxConfig(makeAgent("readonly"), "/tmp/wt");

    expect(config.writable).toBe(false);
    expect(config.allowedTools).toEqual(["Read", "Bash", "Glob", "Grep"]);
    expect(config.writablePaths).toEqual([]);
    expect(config.readablePaths).toEqual(["/tmp/wt"]);
  });

  it("works without worktreePath", () => {
    const config = buildSandboxConfig(makeAgent("writable"));

    expect(config.writable).toBe(true);
    expect(config.readablePaths).toEqual([]);
    expect(config.writablePaths).toEqual([]);
  });
});
