import { appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentDigest,
  compactLogBuffer,
  markConsolidated,
  readLogBuffer,
  readLogBufferSince,
  readUnconsolidated,
} from "@/supervisor/log-buffer";
import type { LogBufferEntry } from "@/supervisor/schemas";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_log_buffer_test__");

function makeEntry(overrides?: Partial<LogBufferEntry>): LogBufferEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "progress",
    message: "doing work",
    target: "digest",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function writeEntries(dir: string, entries: LogBufferEntry[]): Promise<void> {
  const filePath = path.join(dir, "log-buffer.jsonl");
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await appendFile(filePath, content, "utf-8");
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("readLogBuffer", () => {
  it("returns empty array for missing file", async () => {
    const result = await readLogBuffer(TMP_DIR);
    expect(result).toEqual([]);
  });

  it("reads all entries from file", async () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" })];
    await writeEntries(TMP_DIR, entries);

    const result = await readLogBuffer(TMP_DIR);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("a");
    expect(result[1]?.id).toBe("b");
  });

  it("skips malformed lines", async () => {
    const filePath = path.join(TMP_DIR, "log-buffer.jsonl");
    await appendFile(
      filePath,
      `${JSON.stringify(makeEntry({ id: "good" }))}\nnot-json\n${JSON.stringify(makeEntry({ id: "also-good" }))}\n`,
      "utf-8",
    );

    const result = await readLogBuffer(TMP_DIR);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("good");
    expect(result[1]?.id).toBe("also-good");
  });
});

describe("readLogBufferSince", () => {
  it("returns entries after the given timestamp", async () => {
    const entries = [
      makeEntry({ id: "old", timestamp: "2026-03-01T00:00:00.000Z" }),
      makeEntry({ id: "new", timestamp: "2026-03-15T00:00:00.000Z" }),
    ];
    await writeEntries(TMP_DIR, entries);

    const result = await readLogBufferSince(TMP_DIR, "2026-03-10T00:00:00.000Z");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("new");
  });
});

describe("readUnconsolidated", () => {
  it("returns only entries without consolidatedAt", async () => {
    const entries = [
      makeEntry({ id: "pending" }),
      makeEntry({ id: "done", consolidatedAt: "2026-03-15T00:00:00.000Z" }),
    ];
    await writeEntries(TMP_DIR, entries);

    const result = await readUnconsolidated(TMP_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pending");
  });
});

describe("markConsolidated", () => {
  it("sets consolidatedAt on matching entries", async () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" }), makeEntry({ id: "c" })];
    await writeEntries(TMP_DIR, entries);

    await markConsolidated(TMP_DIR, ["a", "c"]);

    const result = await readLogBuffer(TMP_DIR);
    expect(result[0]?.consolidatedAt).toBeTruthy();
    expect(result[1]?.consolidatedAt).toBeUndefined();
    expect(result[2]?.consolidatedAt).toBeTruthy();
  });

  it("does not double-mark already consolidated entries", async () => {
    const existingDate = "2026-03-01T00:00:00.000Z";
    const entries = [makeEntry({ id: "a", consolidatedAt: existingDate })];
    await writeEntries(TMP_DIR, entries);

    await markConsolidated(TMP_DIR, ["a"]);

    const result = await readLogBuffer(TMP_DIR);
    expect(result[0]?.consolidatedAt).toBe(existingDate);
  });

  it("handles missing file gracefully", async () => {
    await expect(markConsolidated(TMP_DIR, ["a"])).resolves.toBeUndefined();
  });
});

describe("compactLogBuffer", () => {
  it("removes old consolidated entries", async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const entries = [
      makeEntry({ id: "old", consolidatedAt: oldDate }),
      makeEntry({ id: "recent", consolidatedAt: recentDate }),
      makeEntry({ id: "pending" }),
    ];
    await writeEntries(TMP_DIR, entries);

    await compactLogBuffer(TMP_DIR);

    const result = await readLogBuffer(TMP_DIR);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(["recent", "pending"]);
  });

  it("handles missing file gracefully", async () => {
    await expect(compactLogBuffer(TMP_DIR)).resolves.toBeUndefined();
  });
});

describe("buildAgentDigest", () => {
  it("returns empty string for no entries", () => {
    expect(buildAgentDigest([])).toBe("");
  });

  it("groups entries by runId with markers", () => {
    const entries = [
      makeEntry({ runId: "run-1", agent: "dev", type: "progress", message: "starting" }),
      makeEntry({ runId: "run-1", agent: "dev", type: "blocker", message: "stuck on tests" }),
      makeEntry({ runId: "run-2", agent: "reviewer", type: "milestone", message: "review done" }),
    ];

    const digest = buildAgentDigest(entries);
    expect(digest).toContain("[run-1]");
    expect(digest).toContain("[run-2]");
    expect(digest).toContain("· starting");
    expect(digest).toContain("⚠ stuck on tests");
    expect(digest).toContain("★ review done");
  });

  it("deduplicates adjacent identical messages", () => {
    const entries = [
      makeEntry({
        runId: "run-1",
        agent: "dev",
        message: "compiling",
        timestamp: "2026-03-15T00:00:00Z",
      }),
      makeEntry({
        runId: "run-1",
        agent: "dev",
        message: "compiling",
        timestamp: "2026-03-15T00:01:00Z",
      }),
      makeEntry({
        runId: "run-1",
        agent: "dev",
        message: "done",
        timestamp: "2026-03-15T00:02:00Z",
      }),
    ];

    const digest = buildAgentDigest(entries);
    const compilingCount = (digest.match(/compiling/g) ?? []).length;
    expect(compilingCount).toBe(1);
    expect(digest).toContain("done");
  });

  it("truncates to max 5 entries per run", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        runId: "run-1",
        agent: "dev",
        message: `step ${i}`,
        timestamp: `2026-03-15T00:0${i}:00Z`,
      }),
    );

    const digest = buildAgentDigest(entries);
    const lineCount = digest.split("\n").filter((l) => l.startsWith("  ")).length;
    expect(lineCount).toBe(5);
  });

  it("uses 'unassigned' for entries without runId", () => {
    const entries = [makeEntry({ message: "orphan work" })];
    const digest = buildAgentDigest(entries);
    expect(digest).toContain("[unassigned]");
  });
});
