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
  validateGitRef,
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

// ─── Git Ref Validation ─────────────────────────────────

describe("validateGitRef", () => {
  it("accepts valid branch names", () => {
    expect(() => validateGitRef("main", "branch")).not.toThrow();
    expect(() => validateGitRef("feat/new-feature", "branch")).not.toThrow();
    expect(() => validateGitRef("fix/bug-123", "branch")).not.toThrow();
    expect(() => validateGitRef("v1.0.0", "tag")).not.toThrow();
    expect(() => validateGitRef("release/2.0.0+build.123", "tag")).not.toThrow();
    expect(() => validateGitRef("origin", "remote")).not.toThrow();
  });

  it("rejects empty ref names", () => {
    expect(() => validateGitRef("", "branch")).toThrow("Git branch name cannot be empty");
    expect(() => validateGitRef("   ", "branch")).toThrow("Git branch name cannot be empty");
  });

  it("rejects directory traversal attempts", () => {
    expect(() => validateGitRef("../../../etc/passwd", "branch")).toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );
    expect(() => validateGitRef("feat/../main", "branch")).toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );
    expect(() => validateGitRef("..", "remote")).toThrow(
      "Git remote name cannot contain '..' (directory traversal attempt)",
    );
  });

  it("rejects invalid characters", () => {
    expect(() => validateGitRef("feat@master", "branch")).toThrow(
      "Invalid git branch name. Only alphanumeric characters, slashes, hyphens, underscores, dots, and plus signs are allowed",
    );
    expect(() => validateGitRef("feat branch", "branch")).toThrow(
      "Invalid git branch name. Only alphanumeric characters, slashes, hyphens, underscores, dots, and plus signs are allowed",
    );
    expect(() => validateGitRef("feat;rm -rf /", "branch")).toThrow(
      "Invalid git branch name. Only alphanumeric characters, slashes, hyphens, underscores, dots, and plus signs are allowed",
    );
    expect(() => validateGitRef("feat\nbranch", "branch")).toThrow(
      "Invalid git branch name. Only alphanumeric characters, slashes, hyphens, underscores, dots, and plus signs are allowed",
    );
  });

  it("validates semver tags with plus signs", () => {
    expect(() => validateGitRef("v1.0.0+build.123", "tag")).not.toThrow();
    expect(() => validateGitRef("2.0.0+metadata", "tag")).not.toThrow();
  });
});

describe("git operations with validation", () => {
  it("createBranch rejects invalid branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(createBranch(repoDir, "../../../etc/passwd", "main")).rejects.toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );

    await expect(createBranch(repoDir, "feat/test", "../../../main")).rejects.toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );
  });

  it("deleteBranch rejects invalid branch names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(deleteBranch(repoDir, "../../../etc/passwd")).rejects.toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );
  });

  it("pushBranch rejects invalid branch and remote names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushBranch(repoDir, "../../../etc/passwd", "origin")).rejects.toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );

    await expect(pushBranch(repoDir, "main", "../../../etc/passwd")).rejects.toThrow(
      "Git remote name cannot contain '..' (directory traversal attempt)",
    );
  });

  it("fetchRemote rejects invalid remote names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(fetchRemote(repoDir, "../../../etc/passwd")).rejects.toThrow(
      "Git remote name cannot contain '..' (directory traversal attempt)",
    );
  });

  it("pushSessionBranch rejects invalid branch and remote names", async () => {
    const repoDir = await initBareRepo(TMP_DIR);

    await expect(pushSessionBranch(repoDir, "../../../etc/passwd", "origin")).rejects.toThrow(
      "Git branch name cannot contain '..' (directory traversal attempt)",
    );

    await expect(pushSessionBranch(repoDir, "main", "../../../etc/passwd")).rejects.toThrow(
      "Git remote name cannot contain '..' (directory traversal attempt)",
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
