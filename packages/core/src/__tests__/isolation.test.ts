import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "@/config";
import { createSessionClone, listSessionClones, removeSessionClone } from "@/isolation/clone";
import { createBranch, getBranchName, getCurrentBranch } from "@/isolation/git";
import { buildSandboxConfig } from "@/isolation/sandbox";
import type { ResolvedAgent } from "@/types";

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

// ─── Session Clone Lifecycle ─────────────────────────────

describe("session clone lifecycle", () => {
  it("create → verify exists → remove → verify gone", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-test");

    const info = await createSessionClone({
      repoPath: repoDir,
      branch: "feat/test-branch",
      baseBranch: "main",
      sessionDir,
    });

    expect(info.path).toBe(path.resolve(sessionDir));
    expect(info.branch).toBe("feat/test-branch");
    expect(info.repoPath).toBe(path.resolve(repoDir));
    expect(existsSync(sessionDir)).toBe(true);

    // Clone should be a full git repo (has .git directory, not a .git file like worktrees)
    expect(existsSync(path.join(sessionDir, ".git"))).toBe(true);

    // Should be on the correct branch
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: sessionDir,
    });
    expect(stdout.trim()).toBe("feat/test-branch");

    // Should appear in list with source repo as repoPath (not the clone path)
    const sessionsBase = path.dirname(sessionDir);
    const list = await listSessionClones(sessionsBase);
    const found = list.find((c) => c.branch === "feat/test-branch");
    expect(found).toBeDefined();
    expect(found?.repoPath).toBe(path.resolve(repoDir));

    // Remove
    await removeSessionClone(sessionDir);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("throws when creating clone from non-existent repo", async () => {
    const fakeRepo = path.join(TMP_DIR, "nonexistent-repo");
    const sessionDir = path.join(TMP_DIR, "session-fail");

    await expect(
      createSessionClone({
        repoPath: fakeRepo,
        branch: "feat/fail",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow();
  });

  it("removeSessionClone is idempotent (no throw for non-existent)", async () => {
    const fakePath = path.join(TMP_DIR, "nonexistent-session");
    // Should not throw
    await removeSessionClone(fakePath);
  });

  it("listSessionClones returns empty for non-existent directory", async () => {
    const list = await listSessionClones(path.join(TMP_DIR, "nonexistent"));
    expect(list).toEqual([]);
  });

  it("rejects branch names with directory traversal in createSessionClone", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-evil");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/../../../etc/passwd",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow("directory traversal");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/valid",
        baseBranch: "../main",
        sessionDir,
      }),
    ).rejects.toThrow("directory traversal");
  });

  it("rejects branch names with invalid characters in createSessionClone", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-evil");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/test;rm -rf /",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow("invalid characters");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/test$())",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow("invalid characters");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/valid",
        baseBranch: "main;ls",
        sessionDir,
      }),
    ).rejects.toThrow("invalid characters");
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
      gitStrategy: "branch",
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
      gitStrategy: "branch",
    };

    expect(getBranchName(config, "hotfix-1")).toBe("fix/run-hotfix-1");
  });

  it("getBranchName uses explicit branch when provided", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };

    expect(getBranchName(config, "abc123", "feat/PROJ-42-add-auth")).toBe("feat/PROJ-42-add-auth");
  });

  it("getBranchName falls back to auto-generated when branch is undefined", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };

    expect(getBranchName(config, "abc123", undefined)).toBe("feat/run-abc123");
  });

  it("rejects branch names with directory traversal", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };

    expect(() => getBranchName(config, "abc123", "feat/../../../etc/passwd")).toThrow(
      "directory traversal",
    );
    expect(() => getBranchName(config, "abc123", "../main")).toThrow("directory traversal");
  });

  it("rejects branch names with invalid characters", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };

    expect(() => getBranchName(config, "abc123", "feat/test;rm -rf /")).toThrow(
      "invalid characters",
    );
    expect(() => getBranchName(config, "abc123", "feat/test$()")).toThrow("invalid characters");
    expect(() => getBranchName(config, "abc123", "feat/test`whoami`")).toThrow(
      "invalid characters",
    );
    expect(() => getBranchName(config, "abc123", "feat/test|ls")).toThrow("invalid characters");
    expect(() => getBranchName(config, "abc123", "feat/test&ls")).toThrow("invalid characters");
  });

  it("accepts valid branch names with allowed special chars", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };

    expect(getBranchName(config, "abc123", "feat/PROJ-42-add-auth")).toBe("feat/PROJ-42-add-auth");
    expect(getBranchName(config, "abc123", "feature/test_branch")).toBe("feature/test_branch");
    expect(getBranchName(config, "abc123", "release/v1.2.3")).toBe("release/v1.2.3");
    expect(getBranchName(config, "abc123", "hotfix/1.0.0+build.123")).toBe(
      "hotfix/1.0.0+build.123",
    );
  });

  it("createBranch validates branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/../../../etc/passwd", "main")).rejects.toThrow(
      "directory traversal",
    );
    await expect(createBranch(repoDir, "feat/test;rm -rf /", "main")).rejects.toThrow(
      "invalid characters",
    );
    await expect(createBranch(repoDir, "feat/valid", "../main")).rejects.toThrow(
      "directory traversal",
    );
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
    const config = buildSandboxConfig(makeAgent("writable"), "/tmp/session");

    expect(config.writable).toBe(true);
    expect(config.allowedTools).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    expect(config.writablePaths).toEqual(["/tmp/session"]);
    expect(config.readablePaths).toEqual(["/tmp/session"]);
  });

  it("readonly agent has write tools filtered out", () => {
    const config = buildSandboxConfig(makeAgent("readonly"), "/tmp/session");

    expect(config.writable).toBe(false);
    expect(config.allowedTools).toEqual(["Read", "Bash", "Glob", "Grep"]);
    expect(config.writablePaths).toEqual([]);
    expect(config.readablePaths).toEqual(["/tmp/session"]);
  });

  it("works without sessionPath", () => {
    const config = buildSandboxConfig(makeAgent("writable"));

    expect(config.writable).toBe(true);
    expect(config.readablePaths).toEqual([]);
    expect(config.writablePaths).toEqual([]);
  });

  it("includes sessionPath in readable and writable paths for writable agent", () => {
    const config = buildSandboxConfig(makeAgent("writable"), "/tmp/session");

    expect(config.readablePaths).toContain("/tmp/session");
    expect(config.writablePaths).toContain("/tmp/session");
  });

  it("includes sessionPath only in readable paths for readonly agent", () => {
    const config = buildSandboxConfig(makeAgent("readonly"), "/tmp/session");

    expect(config.readablePaths).toContain("/tmp/session");
    expect(config.writablePaths).not.toContain("/tmp/session");
  });
});
