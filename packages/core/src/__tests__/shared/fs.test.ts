import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDir, writeFileAtomic } from "@/shared/fs";

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

describe("writeFileAtomic", () => {
  it("writes content to file", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "test.txt");

    await writeFileAtomic(filePath, "hello world");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  it("overwrites existing file", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "existing.txt");
    await writeFile(filePath, "old content", "utf-8");

    await writeFileAtomic(filePath, "new content");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  it("creates file in existing directory", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "new-file.json");

    await writeFileAtomic(filePath, JSON.stringify({ key: "value" }));

    const content = await readFile(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual({ key: "value" });
  });

  it("does not leave temp files after successful write", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "clean-write.txt");

    await writeFileAtomic(filePath, "clean content");

    const entries = await readdir(TMP_DIR);
    const tempFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tempFiles).toHaveLength(0);
  });

  it("handles concurrent writes to same file", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "concurrent.txt");

    // Launch multiple concurrent writes
    await Promise.all([
      writeFileAtomic(filePath, "write-1"),
      writeFileAtomic(filePath, "write-2"),
      writeFileAtomic(filePath, "write-3"),
      writeFileAtomic(filePath, "write-4"),
      writeFileAtomic(filePath, "write-5"),
    ]);

    // File should exist and contain one of the writes (atomicity means no corruption)
    const content = await readFile(filePath, "utf-8");
    expect(content).toMatch(/^write-[1-5]$/);

    // No temp files should remain
    const entries = await readdir(TMP_DIR);
    const tempFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tempFiles).toHaveLength(0);
  });

  it("handles concurrent writes to different files", async () => {
    await mkdir(TMP_DIR, { recursive: true });

    // Launch writes to 5 different files concurrently
    await Promise.all([
      writeFileAtomic(path.join(TMP_DIR, "file-1.txt"), "content-1"),
      writeFileAtomic(path.join(TMP_DIR, "file-2.txt"), "content-2"),
      writeFileAtomic(path.join(TMP_DIR, "file-3.txt"), "content-3"),
      writeFileAtomic(path.join(TMP_DIR, "file-4.txt"), "content-4"),
      writeFileAtomic(path.join(TMP_DIR, "file-5.txt"), "content-5"),
    ]);

    // All files should exist with correct content
    for (let i = 1; i <= 5; i++) {
      const content = await readFile(path.join(TMP_DIR, `file-${i}.txt`), "utf-8");
      expect(content).toBe(`content-${i}`);
    }

    // No temp files should remain
    const entries = await readdir(TMP_DIR);
    const tempFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tempFiles).toHaveLength(0);
  });

  it("throws when directory does not exist", async () => {
    const filePath = path.join(TMP_DIR, "nonexistent-dir", "file.txt");

    await expect(writeFileAtomic(filePath, "content")).rejects.toThrow();
  });

  it("respects encoding parameter", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "encoded.txt");

    await writeFileAtomic(filePath, "hello", "utf-8");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("hello");
  });

  it("handles large content", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "large.txt");
    const largeContent = "x".repeat(1_000_000); // 1MB of 'x'

    await writeFileAtomic(filePath, largeContent);

    const content = await readFile(filePath, "utf-8");
    expect(content.length).toBe(1_000_000);
    expect(content[0]).toBe("x");
  });

  it("handles buffer content", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "buffer.bin");
    const buffer = Buffer.from([0x01, 0x02, 0x03, 0x04]);

    await writeFileAtomic(filePath, buffer);

    const content = await readFile(filePath);
    expect(content).toEqual(buffer);
  });
});
