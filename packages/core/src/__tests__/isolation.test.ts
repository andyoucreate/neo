import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "@/config";
import { createSessionClone, listSessionClones, removeSessionClone } from "@/isolation/clone";
import {
  createBranch,
  deleteBranch,
  fetchRemote,
  getBranchName,
  getCurrentBranch,
  pushBranch,
  pushSessionBranch,
} from "@/isolation/git";
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
});

// ─── Git Ref Validation (Security) ─────────────────────────

describe("git ref validation (security)", () => {
  it("rejects branch names with option injection attempts", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-inject");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "--upload-pack=malicious",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow(/cannot start with '-'/);
  });

  it("rejects baseBranch names with option injection attempts", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-inject-base");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/safe",
        baseBranch: "--upload-pack=malicious",
        sessionDir,
      }),
    ).rejects.toThrow(/cannot start with '-'/);
  });

  it("rejects branch names with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-traversal");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/../../../etc/passwd",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow(/invalid pattern '\.\.'/);
  });

  it("rejects baseBranch names with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-base-traversal");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/safe",
        baseBranch: "../main",
        sessionDir,
      }),
    ).rejects.toThrow(/invalid pattern '\.\.'/);
  });

  it("rejects branch names with special characters", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-special");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/test;rm -rf /",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow(/contains invalid characters/);
  });

  it("rejects branch names with shell metacharacters", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-meta");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/test$(whoami)",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow(/contains invalid characters/);
  });

  it("accepts valid branch names with slashes, dashes, and underscores", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-valid");

    // Should not throw
    const info = await createSessionClone({
      repoPath: repoDir,
      branch: "feat/PROJ-123_add-feature",
      baseBranch: "main",
      sessionDir,
    });

    expect(info.branch).toBe("feat/PROJ-123_add-feature");
  });

  it("accepts valid branch names with numbers", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-numbers");

    // Should not throw
    const info = await createSessionClone({
      repoPath: repoDir,
      branch: "fix/issue-42",
      baseBranch: "main",
      sessionDir,
    });

    expect(info.branch).toBe("fix/issue-42");
  });

  it("accepts valid semver tags with dots", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-semver-dots");

    // Should not throw
    const info = await createSessionClone({
      repoPath: repoDir,
      branch: "release/v1.2.3",
      baseBranch: "main",
      sessionDir,
    });

    expect(info.branch).toBe("release/v1.2.3");
  });

  it("accepts valid semver tags with plus sign", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-semver-plus");

    // Should not throw
    const info = await createSessionClone({
      repoPath: repoDir,
      branch: "release/v1.2.3+build.123",
      baseBranch: "main",
      sessionDir,
    });

    expect(info.branch).toBe("release/v1.2.3+build.123");
  });

  it("rejects empty branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-empty");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow(/must be a non-empty string/);
  });

  it("rejects empty baseBranch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-empty-base");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/test",
        baseBranch: "",
        sessionDir,
      }),
    ).rejects.toThrow(/must be a non-empty string/);
  });

  it("accepts semver tags with plus and dots", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-semver");

    // Should not throw - semver tags with + and . are valid
    const info = await createSessionClone({
      repoPath: repoDir,
      branch: "v1.2.3+build.123",
      baseBranch: "main",
      sessionDir,
    });

    expect(info.branch).toBe("v1.2.3+build.123");
  });
});

// ─── Git.ts Security Validation ─────────────────────────

describe("git.ts security validation", () => {
  it("createBranch rejects branch with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "--upload-pack=malicious", "main")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("createBranch rejects baseBranch with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/test", "--upload-pack=malicious")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("createBranch rejects branch with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/../../../etc/passwd", "main")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("createBranch rejects branch with shell metacharacters", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/test$(whoami)", "main")).rejects.toThrow(
      /contains invalid characters/,
    );
  });

  it("deleteBranch rejects branch with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(deleteBranch(repoDir, "--force")).rejects.toThrow(/cannot start with '-'/);
  });

  it("deleteBranch rejects branch with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(deleteBranch(repoDir, "../main")).rejects.toThrow(/invalid pattern '\.\.'/);
  });

  it("pushBranch rejects branch with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "--force", "origin")).rejects.toThrow(/cannot start with '-'/);
  });

  it("pushBranch rejects remote with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "main", "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushBranch rejects remote with shell metacharacters", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "main", "origin;rm -rf /")).rejects.toThrow(
      /contains invalid characters/,
    );
  });

  it("fetchRemote rejects remote with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(fetchRemote(repoDir, "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("fetchRemote rejects remote with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(fetchRemote(repoDir, "../../../etc/passwd")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("pushSessionBranch rejects branch with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushSessionBranch(repoDir, "--force", "origin")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushSessionBranch rejects remote with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushSessionBranch(repoDir, "main", "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushSessionBranch rejects branch with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushSessionBranch(repoDir, "feat/../main", "origin")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("git.ts functions accept valid semver tags with plus and dots", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    // Should not throw - semver tags with + and . are valid
    await expect(createBranch(repoDir, "v1.2.3+build.123", "main")).resolves.not.toThrow();
  });
});

// ─── Git.ts Functions Validation (Security) ─────────────────────────

describe("git.ts functions validation (security)", () => {
  it("createBranch rejects malicious branch names with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "--upload-pack=evil", "main")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("createBranch rejects malicious baseBranch names with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/safe", "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("createBranch rejects branch names with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/../../../etc/passwd", "main")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("createBranch rejects branch names with shell metacharacters", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "feat/test$(whoami)", "main")).rejects.toThrow(
      /contains invalid characters/,
    );
  });

  it("deleteBranch rejects malicious branch names with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(deleteBranch(repoDir, "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("deleteBranch rejects branch names with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(deleteBranch(repoDir, "../../../etc/passwd")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("pushBranch rejects malicious branch names with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "--upload-pack=evil", "origin")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushBranch rejects malicious remote names with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "feat/safe", "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushBranch rejects branch names with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "../../../etc/passwd", "origin")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("fetchRemote rejects malicious remote names with option injection", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(fetchRemote(repoDir, "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("fetchRemote rejects remote names with directory traversal", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(fetchRemote(repoDir, "../../../etc/passwd")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("pushSessionBranch rejects malicious branch names with option injection", async () => {
    await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-push");

    await expect(pushSessionBranch(sessionDir, "--upload-pack=evil", "origin")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushSessionBranch rejects malicious remote names with option injection", async () => {
    await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-push");

    await expect(pushSessionBranch(sessionDir, "feat/safe", "--upload-pack=evil")).rejects.toThrow(
      /cannot start with '-'/,
    );
  });

  it("pushSessionBranch rejects branch names with directory traversal", async () => {
    await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-push");

    await expect(pushSessionBranch(sessionDir, "../../../etc/passwd", "origin")).rejects.toThrow(
      /invalid pattern '\.\.'/,
    );
  });

  it("pushSessionBranch rejects branch names with shell metacharacters", async () => {
    await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-push");

    await expect(pushSessionBranch(sessionDir, "feat/test;rm -rf /", "origin")).rejects.toThrow(
      /contains invalid characters/,
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
