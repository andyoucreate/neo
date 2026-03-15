import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDir } from "@/shared/fs";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_fs_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ensureDir", () => {
  it("creates a directory that does not exist", async () => {
    const dir = path.join(TMP_DIR, "new-dir");

    await ensureDir(dir);

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
  });

  it("creates nested directory structure", async () => {
    const dir = path.join(TMP_DIR, "deep", "nested", "path");

    await ensureDir(dir);

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
  });

  it("succeeds when directory already exists", async () => {
    const dir = path.join(TMP_DIR, "existing");
    await mkdir(dir, { recursive: true });

    await expect(ensureDir(dir)).resolves.toBeUndefined();
  });

  it("skips filesystem call on cache hit", async () => {
    const dir = path.join(TMP_DIR, "cached-dir");
    const cache = new Set<string>();

    // First call should create the directory
    await ensureDir(dir, cache);
    expect(cache.has(dir)).toBe(true);

    // Remove the directory to prove second call doesn't hit filesystem
    await rm(dir, { recursive: true });

    // Second call should skip mkdir due to cache
    await ensureDir(dir, cache);

    // Directory should NOT exist because mkdir was skipped
    await expect(stat(dir)).rejects.toThrow();
  });

  it("adds path to cache after successful mkdir", async () => {
    const dir = path.join(TMP_DIR, "cache-test");
    const cache = new Set<string>();

    expect(cache.has(dir)).toBe(false);
    await ensureDir(dir, cache);
    expect(cache.has(dir)).toBe(true);
  });

  it("does not add to cache when cache is not provided", async () => {
    const dir = path.join(TMP_DIR, "no-cache");

    // Should work without cache
    await ensureDir(dir);

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
  });

  it("handles multiple different paths with same cache", async () => {
    const dir1 = path.join(TMP_DIR, "dir1");
    const dir2 = path.join(TMP_DIR, "dir2");
    const cache = new Set<string>();

    await ensureDir(dir1, cache);
    await ensureDir(dir2, cache);

    expect(cache.has(dir1)).toBe(true);
    expect(cache.has(dir2)).toBe(true);

    const stats1 = await stat(dir1);
    const stats2 = await stat(dir2);
    expect(stats1.isDirectory()).toBe(true);
    expect(stats2.isDirectory()).toBe(true);
  });

  it("caches exact path string (no normalization)", async () => {
    const dir = path.join(TMP_DIR, "exact-path");
    const dirWithSlash = `${dir}/`;
    const cache = new Set<string>();

    await ensureDir(dir, cache);

    // Different string should not be cached
    expect(cache.has(dir)).toBe(true);
    expect(cache.has(dirWithSlash)).toBe(false);
  });
});
