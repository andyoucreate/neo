import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock @neotx/core
vi.mock("@neotx/core", () => ({
  getRunsDir: () => "/mock/runs",
  listReposFromGlobalConfig: vi.fn(),
  toRepoSlug: (repo: { name?: string; path: string }) =>
    repo.name ?? nodePath.basename(repo.path).toLowerCase(),
}));

import type { RepoConfig } from "@neotx/core";
import { listReposFromGlobalConfig } from "@neotx/core";
import { resolveRepoFilter } from "../repo-filter.js";

/** Helper to create a minimal RepoConfig with defaults */
function makeRepo(overrides: { path: string; name?: string }): RepoConfig {
  return {
    path: overrides.path,
    name: overrides.name,
    defaultBranch: "main",
    branchPrefix: "feat",
    pushRemote: "origin",
    gitStrategy: "branch",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRepoFilter", () => {
  describe("empty args", () => {
    it("returns mode 'all' when no args provided", async () => {
      const result = await resolveRepoFilter({});
      expect(result).toEqual({ mode: "all" });
    });

    it("returns mode 'all' when args is empty object", async () => {
      const result = await resolveRepoFilter({});
      expect(result.mode).toBe("all");
      expect(result.repoSlug).toBeUndefined();
      expect(result.repoPath).toBeUndefined();
    });
  });

  describe("--repo with path", () => {
    it("matches registered repo by absolute path", async () => {
      vi.mocked(listReposFromGlobalConfig).mockResolvedValue([
        makeRepo({ path: "/home/user/projects/myrepo" }),
      ]);

      const result = await resolveRepoFilter({ repo: "/home/user/projects/myrepo" });

      expect(result.mode).toBe("named");
      expect(result.repoSlug).toBe("myrepo");
      expect(result.repoPath).toBe("/home/user/projects/myrepo");
    });

    it("matches registered repo by relative path resolved to absolute", async () => {
      const absPath = nodePath.resolve("./myrepo");
      vi.mocked(listReposFromGlobalConfig).mockResolvedValue([makeRepo({ path: absPath })]);

      const result = await resolveRepoFilter({ repo: "./myrepo" });

      expect(result.mode).toBe("named");
      expect(result.repoSlug).toBe("myrepo");
      expect(result.repoPath).toBe(absPath);
    });
  });

  describe("--repo with slug", () => {
    it("matches registered repo by slug/name", async () => {
      vi.mocked(listReposFromGlobalConfig).mockResolvedValue([
        makeRepo({ name: "my-project", path: "/some/path/my-project" }),
      ]);

      const result = await resolveRepoFilter({ repo: "my-project" });

      expect(result.mode).toBe("named");
      expect(result.repoSlug).toBe("my-project");
      expect(result.repoPath).toBe("/some/path/my-project");
    });

    it("matches repo by derived slug when no name set", async () => {
      vi.mocked(listReposFromGlobalConfig).mockResolvedValue([
        makeRepo({ path: "/home/user/projects/neo" }),
      ]);

      const result = await resolveRepoFilter({ repo: "neo" });

      expect(result.mode).toBe("named");
      expect(result.repoSlug).toBe("neo");
      expect(result.repoPath).toBe("/home/user/projects/neo");
    });
  });

  describe("--repo with unregistered path", () => {
    it("derives slug from unregistered path", async () => {
      vi.mocked(listReposFromGlobalConfig).mockResolvedValue([]);

      const result = await resolveRepoFilter({ repo: "/unknown/path/my-app" });

      expect(result.mode).toBe("named");
      expect(result.repoSlug).toBe("my-app");
      expect(result.repoPath).toBe("/unknown/path/my-app");
    });

    it("treats unregistered slug as path and derives slug", async () => {
      vi.mocked(listReposFromGlobalConfig).mockResolvedValue([
        makeRepo({ path: "/some/other/repo" }),
      ]);

      const result = await resolveRepoFilter({ repo: "unregistered-repo" });

      expect(result.mode).toBe("named");
      expect(result.repoSlug).toBe("unregistered-repo");
      expect(result.repoPath).toBe("unregistered-repo");
    });
  });
});
