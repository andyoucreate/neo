import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "@/config";
import {
  createSessionClone,
  listSessionClones,
  removeSessionClone,
  validateBranchName,
} from "@/isolation/clone";
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

  it("rejects malicious branch names in createBranch", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "$(whoami)", "main")).rejects.toThrow("Invalid branch name");
    await expect(createBranch(repoDir, "feat/test", ";rm -rf /")).rejects.toThrow(
      "Invalid branch name",
    );
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

// ─── Branch Name Validation ─────────────────────────────

describe("validateBranchName", () => {
  it("accepts valid branch names", () => {
    expect(() => validateBranchName("feat/my-branch")).not.toThrow();
    expect(() => validateBranchName("fix/issue-123")).not.toThrow();
    expect(() => validateBranchName("release/v1.2.3")).not.toThrow();
    expect(() => validateBranchName("main")).not.toThrow();
    expect(() => validateBranchName("feature_branch")).not.toThrow();
    expect(() => validateBranchName("fix.patch")).not.toThrow();
    expect(() => validateBranchName("PROJ-123/add-feature")).not.toThrow();
  });

  it("rejects branch names with shell metacharacters", () => {
    expect(() => validateBranchName("$(rm -rf /)")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch;rm -rf /")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch`whoami`")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch|ls")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch&echo test")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch>file.txt")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch<file.txt")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
  });

  it("rejects branch names with directory traversal", () => {
    expect(() => validateBranchName("../etc/passwd")).toThrow(
      "Branch names cannot contain directory traversal patterns",
    );
    expect(() => validateBranchName("feat/../main")).toThrow(
      "Branch names cannot contain directory traversal patterns",
    );
    expect(() => validateBranchName("..")).toThrow(
      "Branch names cannot contain directory traversal patterns",
    );
  });

  it("rejects branch names with spaces", () => {
    expect(() => validateBranchName("my branch")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("feat/my branch name")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
  });

  it("rejects branch names with special characters", () => {
    expect(() => validateBranchName("branch@name")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch#name")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch*name")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
    expect(() => validateBranchName("branch$name")).toThrow(
      "Branch names must contain only alphanumeric characters",
    );
  });
});

describe("createSessionClone with validation", () => {
  it("rejects invalid branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-malicious");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "$(rm -rf /)",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects invalid base branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-malicious");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "feat/safe",
        baseBranch: ";echo hacked",
        sessionDir,
      }),
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects directory traversal in branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);
    const sessionDir = path.join(TMP_DIR, "session-traversal");

    await expect(
      createSessionClone({
        repoPath: repoDir,
        branch: "../../../etc/passwd",
        baseBranch: "main",
        sessionDir,
      }),
    ).rejects.toThrow("directory traversal patterns");
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
