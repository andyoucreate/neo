import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "@/config";
import { createSessionClone, listSessionClones, removeSessionClone } from "@/isolation/clone";
import { createBranch, getBranchName, getCurrentBranch, validateGitRef } from "@/isolation/git";
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

// ─── Git Validation ─────────────────────────────────────

describe("validateGitRef", () => {
  it("accepts valid branch names", () => {
    expect(() => validateGitRef("feat/my-branch", "branch")).not.toThrow();
    expect(() => validateGitRef("fix/PROJ-123", "branch")).not.toThrow();
    expect(() => validateGitRef("main", "branch")).not.toThrow();
    expect(() => validateGitRef("feature/user_auth", "branch")).not.toThrow();
    expect(() => validateGitRef("hotfix/v1.2.3-rc1", "branch")).not.toThrow();
  });

  it("rejects empty branch names", () => {
    expect(() => validateGitRef("", "branch")).toThrow("branch name cannot be empty");
  });

  it("rejects branch names with spaces", () => {
    expect(() => validateGitRef("feat/my branch", "branch")).toThrow(
      'Invalid branch name: "feat/my branch"',
    );
  });

  it("rejects branch names with shell metacharacters", () => {
    expect(() => validateGitRef("feat/test;rm -rf", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test$(whoami)", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test`whoami`", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test&background", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test|pipe", "branch")).toThrow("Invalid branch name");
  });

  it("rejects branch names with special characters", () => {
    expect(() => validateGitRef("feat/test@domain", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test#anchor", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test%encode", "branch")).toThrow("Invalid branch name");
    expect(() => validateGitRef("feat/test*wildcard", "branch")).toThrow("Invalid branch name");
  });

  it("validates tags with correct refType message", () => {
    expect(() => validateGitRef("v1.0.0", "tag")).not.toThrow();
    expect(() => validateGitRef("invalid tag", "tag")).toThrow('Invalid tag name: "invalid tag"');
  });

  it("rejects branch names used in getBranchName when invalid", () => {
    const config: RepoConfig = {
      path: "/some/repo",
      defaultBranch: "main",
      branchPrefix: "feat",
      pushRemote: "origin",
      gitStrategy: "branch",
    };

    expect(() => getBranchName(config, "abc123", "feat/valid-branch")).not.toThrow();
    expect(() => getBranchName(config, "abc123", "feat/invalid;branch")).toThrow(
      "Invalid branch name",
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
