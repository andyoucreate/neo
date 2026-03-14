import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_config_crud__");
const CONFIG_PATH = path.join(TMP_DIR, "config.yml");

vi.mock("@/paths", () => ({
  getDataDir: () => TMP_DIR,
  getJournalsDir: () => path.join(TMP_DIR, "journals"),
  getRunsDir: () => path.join(TMP_DIR, "runs"),
}));

import {
  addRepoToGlobalConfig,
  listReposFromGlobalConfig,
  loadGlobalConfig,
  removeRepoFromGlobalConfig,
} from "@/config";

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("loadGlobalConfig", () => {
  it("creates default config if file does not exist", async () => {
    const config = await loadGlobalConfig();
    expect(config.repos).toEqual([]);
    expect(config.budget.dailyCapUsd).toBe(500);
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it("loads existing config", async () => {
    await writeFile(
      CONFIG_PATH,
      `repos:\n  - path: /my/repo\nbudget:\n  dailyCapUsd: 100\n`,
      "utf-8",
    );
    const config = await loadGlobalConfig();
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]?.path).toBe("/my/repo");
    expect(config.budget.dailyCapUsd).toBe(100);
  });
});

describe("addRepoToGlobalConfig", () => {
  it("adds a new repo", async () => {
    await addRepoToGlobalConfig({ path: "/my/repo" });
    const config = await loadGlobalConfig();
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]?.defaultBranch).toBe("main");
    expect(config.repos[0]?.branchPrefix).toBe("feat");
  });

  it("deduplicates by resolved path", async () => {
    await addRepoToGlobalConfig({ path: "/my/repo" });
    await addRepoToGlobalConfig({ path: "/my/repo", defaultBranch: "develop" });
    const config = await loadGlobalConfig();
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]?.defaultBranch).toBe("develop");
  });

  it("accepts partial input with defaults", async () => {
    await addRepoToGlobalConfig({ path: "/my/repo" });
    const config = await loadGlobalConfig();
    const repo = config.repos[0];
    expect(repo?.pushRemote).toBe("origin");
    expect(repo?.autoCreatePr).toBe(false);
  });

  it("preserves name when provided", async () => {
    await addRepoToGlobalConfig({ path: "/my/repo", name: "custom-name" });
    const config = await loadGlobalConfig();
    expect(config.repos[0]?.name).toBe("custom-name");
  });
});

describe("removeRepoFromGlobalConfig", () => {
  it("removes by path", async () => {
    await addRepoToGlobalConfig({ path: "/my/repo" });
    const removed = await removeRepoFromGlobalConfig("/my/repo");
    expect(removed).toBe(true);
    const config = await loadGlobalConfig();
    expect(config.repos).toHaveLength(0);
  });

  it("removes by name", async () => {
    await addRepoToGlobalConfig({ path: "/my/repo", name: "my-repo" });
    const removed = await removeRepoFromGlobalConfig("my-repo");
    expect(removed).toBe(true);
    const config = await loadGlobalConfig();
    expect(config.repos).toHaveLength(0);
  });

  it("returns false when not found", async () => {
    const removed = await removeRepoFromGlobalConfig("nonexistent");
    expect(removed).toBe(false);
  });
});

describe("listReposFromGlobalConfig", () => {
  it("returns empty array when no repos", async () => {
    const repos = await listReposFromGlobalConfig();
    expect(repos).toEqual([]);
  });

  it("returns all registered repos", async () => {
    await addRepoToGlobalConfig({ path: "/repo-a" });
    await addRepoToGlobalConfig({ path: "/repo-b", name: "b" });
    const repos = await listReposFromGlobalConfig();
    expect(repos).toHaveLength(2);
    expect(repos[1]?.name).toBe("b");
  });
});
