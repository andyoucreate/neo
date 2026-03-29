import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog } from "@/supervisor/activity-log";
import type { ActivityEntry } from "@/supervisor/schemas";

const TEST_DIR = "/tmp/neo-activity-log-test";

function makeEntry(overrides?: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: randomUUID(),
    type: "action",
    summary: "test entry",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("ActivityLog", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("append", () => {
    it("appends entry to activity log", async () => {
      const log = new ActivityLog(TEST_DIR);
      const entry = makeEntry({ summary: "first entry" });

      await log.append(entry);

      const entries = await log.tail(10);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.summary).toBe("first entry");
    });

    it("appends multiple entries in order", async () => {
      const log = new ActivityLog(TEST_DIR);

      await log.append(makeEntry({ summary: "entry 1" }));
      await log.append(makeEntry({ summary: "entry 2" }));
      await log.append(makeEntry({ summary: "entry 3" }));

      const entries = await log.tail(10);
      expect(entries).toHaveLength(3);
      expect(entries[0]?.summary).toBe("entry 1");
      expect(entries[1]?.summary).toBe("entry 2");
      expect(entries[2]?.summary).toBe("entry 3");
    });
  });

  describe("log", () => {
    it("creates entry with auto-generated id and timestamp", async () => {
      const log = new ActivityLog(TEST_DIR);

      await log.log("action", "did something");

      const entries = await log.tail(10);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBeDefined();
      expect(entries[0]?.type).toBe("action");
      expect(entries[0]?.summary).toBe("did something");
      expect(entries[0]?.timestamp).toBeDefined();
    });

    it("includes optional detail", async () => {
      const log = new ActivityLog(TEST_DIR);

      await log.log("decision", "chose option A", { reason: "faster" });

      const entries = await log.tail(10);
      expect(entries[0]?.detail).toEqual({ reason: "faster" });
    });
  });

  describe("tail", () => {
    it("returns empty array for missing file", async () => {
      const log = new ActivityLog(TEST_DIR);

      const entries = await log.tail(10);
      expect(entries).toEqual([]);
    });

    it("returns last N entries", async () => {
      const log = new ActivityLog(TEST_DIR);

      for (let i = 1; i <= 10; i++) {
        await log.append(makeEntry({ summary: `entry ${i}` }));
      }

      const entries = await log.tail(3);
      expect(entries).toHaveLength(3);
      expect(entries[0]?.summary).toBe("entry 8");
      expect(entries[1]?.summary).toBe("entry 9");
      expect(entries[2]?.summary).toBe("entry 10");
    });

    it("skips malformed lines", async () => {
      const log = new ActivityLog(TEST_DIR);
      const filePath = path.join(TEST_DIR, "activity.jsonl");

      // Write mixed valid/invalid content
      const validEntry = makeEntry({ summary: "valid entry" });
      writeFileSync(
        filePath,
        `${JSON.stringify(validEntry)}\nnot-valid-json\n${JSON.stringify(makeEntry({ summary: "also valid" }))}\n`,
        "utf-8",
      );

      const entries = await log.tail(10);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.summary).toBe("valid entry");
      expect(entries[1]?.summary).toBe("also valid");
    });
  });

  describe("rotation", () => {
    it("rotates file when exceeding 10MB", async () => {
      const log = new ActivityLog(TEST_DIR);
      const filePath = path.join(TEST_DIR, "activity.jsonl");

      // Create a file just over 10MB
      const largeContent = "x".repeat(10 * 1024 * 1024 + 1000);
      writeFileSync(filePath, largeContent, "utf-8");

      // Append should trigger rotation
      await log.append(makeEntry({ summary: "after rotation" }));

      // Check rotated file exists
      const files = readdirSync(TEST_DIR);
      const rotatedFiles = files.filter((f) => f.startsWith("activity-") && f !== "activity.jsonl");
      expect(rotatedFiles.length).toBe(1);

      // New file should only have the new entry
      const entries = await log.tail(10);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.summary).toBe("after rotation");
    });

    it("does not rotate file under 10MB", async () => {
      const log = new ActivityLog(TEST_DIR);

      // Add several entries (well under 10MB)
      for (let i = 0; i < 100; i++) {
        await log.append(makeEntry({ summary: `entry ${i}` }));
      }

      // Check no rotated files
      const files = readdirSync(TEST_DIR);
      const rotatedFiles = files.filter((f) => f.startsWith("activity-") && f !== "activity.jsonl");
      expect(rotatedFiles.length).toBe(0);
    });
  });

  describe("concurrent write safety", () => {
    it("serializes concurrent append calls without corruption", async () => {
      const log = new ActivityLog(TEST_DIR);

      // Run many appends concurrently
      const promises = Array.from({ length: 50 }, (_, i) =>
        log.append(makeEntry({ summary: `concurrent entry ${i}` })),
      );
      await Promise.all(promises);

      // File should be valid JSONL with all entries
      const content = readFileSync(path.join(TEST_DIR, "activity.jsonl"), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(50);

      // All lines should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // All entries should be readable
      const entries = await log.tail(100);
      expect(entries).toHaveLength(50);
    });

    it("serializes concurrent log calls without data loss", async () => {
      const log = new ActivityLog(TEST_DIR);

      // Run many log calls concurrently
      const promises = Array.from({ length: 30 }, (_, i) =>
        log.log("action", `concurrent log ${i}`),
      );
      await Promise.all(promises);

      const entries = await log.tail(100);
      expect(entries).toHaveLength(30);

      // Verify all messages are present (order may vary due to async)
      const summaries = entries.map((e) => e.summary);
      for (let i = 0; i < 30; i++) {
        expect(summaries).toContain(`concurrent log ${i}`);
      }
    });

    it("handles concurrent rotation + append atomically", async () => {
      const log = new ActivityLog(TEST_DIR);
      const filePath = path.join(TEST_DIR, "activity.jsonl");

      // Create a file just under the rotation threshold
      const almostFullContent = "x".repeat(10 * 1024 * 1024 - 100);
      writeFileSync(filePath, almostFullContent, "utf-8");

      // Run concurrent appends - one will trigger rotation
      const promises = Array.from({ length: 20 }, (_, i) =>
        log.append(makeEntry({ summary: `rotation test ${i}` })),
      );
      await Promise.all(promises);

      // All files should be valid JSONL (no corruption from race)
      const files = readdirSync(TEST_DIR);
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          const content = readFileSync(path.join(TEST_DIR, file), "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            // Skip the initial padding content which isn't JSON
            if (line.startsWith("{")) {
              expect(() => JSON.parse(line)).not.toThrow();
            }
          }
        }
      }

      // New entries should be in the main activity.jsonl
      const entries = await log.tail(100);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.summary.startsWith("rotation test"))).toBe(true);
    });

    it("prevents interleaved checkRotation and append", async () => {
      const log = new ActivityLog(TEST_DIR);
      const filePath = path.join(TEST_DIR, "activity.jsonl");

      // Create file at rotation threshold
      const atThreshold = "x".repeat(10 * 1024 * 1024 + 1);
      writeFileSync(filePath, atThreshold, "utf-8");

      // Without the lock, this race condition would cause:
      // 1. Call A: checkRotation passes (file too big)
      // 2. Call B: checkRotation passes (same file, too big)
      // 3. Call A: renames file
      // 4. Call B: tries to rename same file (already moved) OR appends to wrong path
      // With the lock, operations are serialized

      const promises = [
        log.append(makeEntry({ summary: "entry A" })),
        log.append(makeEntry({ summary: "entry B" })),
        log.append(makeEntry({ summary: "entry C" })),
      ];
      await Promise.all(promises);

      // Should have exactly one rotation (not multiple)
      const files = readdirSync(TEST_DIR);
      const rotatedFiles = files.filter((f) => f.startsWith("activity-") && f !== "activity.jsonl");
      expect(rotatedFiles.length).toBe(1);

      // All new entries should be in the fresh activity.jsonl
      const entries = await log.tail(100);
      expect(entries).toHaveLength(3);

      // Verify all entries are present (no data loss from race condition)
      const summaries = entries.map((e) => e.summary);
      expect(summaries).toContain("entry A");
      expect(summaries).toContain("entry B");
      expect(summaries).toContain("entry C");
    });
  });
});
