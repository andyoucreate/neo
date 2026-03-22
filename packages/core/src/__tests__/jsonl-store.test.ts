// biome-ignore lint/style/noNonNullAssertion: Test file uses non-null assertions where array length is verified
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonlStore } from "@/shared/jsonl-store";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_jsonl_store_test__");

const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.number(),
});

type Event = z.infer<typeof eventSchema>;

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createStore(filename = "events.jsonl"): JsonlStore<Event> {
  return new JsonlStore({
    filePath: path.join(TMP_DIR, filename),
    schema: eventSchema,
    idField: "id",
  });
}

describe("JsonlStore", () => {
  describe("append", () => {
    it("creates file and appends record with _version: 1", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 123 });

      const content = await readFile(path.join(TMP_DIR, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed).toEqual({
        id: "evt_1",
        type: "click",
        timestamp: 123,
        _version: 1,
      });
    });

    it("appends multiple records sequentially", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.append({ id: "evt_2", type: "submit", timestamp: 200 });

      const records = await store.readAll();
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({ id: "evt_1", type: "click", timestamp: 100 });
      expect(records[1]).toEqual({ id: "evt_2", type: "submit", timestamp: 200 });
    });

    it("prevents duplicate IDs by checking index before append", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });

      // Attempting to append with same ID should throw error
      await expect(store.append({ id: "evt_1", type: "click", timestamp: 200 })).rejects.toThrow(
        'Record with id "evt_1" already exists',
      );

      // File should still have only one record
      const content = await readFile(path.join(TMP_DIR, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
    });

    it("serializes concurrent appends via write lock", async () => {
      const store = createStore();

      // Fire multiple appends concurrently
      await Promise.all([
        store.append({ id: "evt_1", type: "click", timestamp: 100 }),
        store.append({ id: "evt_2", type: "click", timestamp: 200 }),
        store.append({ id: "evt_3", type: "click", timestamp: 300 }),
      ]);

      const records = await store.readAll();
      expect(records).toHaveLength(3);
      expect(records.map((r) => r.id).sort()).toEqual(["evt_1", "evt_2", "evt_3"]);
    });
  });

  describe("update", () => {
    it("appends mutation with incremented _version", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.update("evt_1", { type: "submit" });

      const content = await readFile(path.join(TMP_DIR, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      const mutation = JSON.parse(lines[1]!);
      expect(mutation).toEqual({
        id: "evt_1",
        type: "submit",
        _version: 2,
      });
    });

    it("merges patch with existing record on read", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.update("evt_1", { type: "submit" });

      const records = await store.readAll();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        id: "evt_1",
        type: "submit",
        timestamp: 100, // Original field preserved
      });
    });

    it("throws if record does not exist", async () => {
      const store = createStore();
      await expect(store.update("nonexistent", { type: "click" })).rejects.toThrow(
        "Record not found: nonexistent",
      );
    });

    it("rebuilds index on first update if index is empty", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });

      // Create a new store instance (fresh index)
      const store2 = createStore();
      await store2.update("evt_1", { type: "submit" });

      const records = await store2.readAll();
      expect(records[0]!.type).toBe("submit");
    });

    it("handles multiple updates with correct version tracking", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.update("evt_1", { type: "hover" });
      await store.update("evt_1", { type: "submit" });

      const content = await readFile(path.join(TMP_DIR, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]!)._version).toBe(1);
      expect(JSON.parse(lines[1]!)._version).toBe(2);
      expect(JSON.parse(lines[2]!)._version).toBe(3);
    });
  });

  describe("readAll", () => {
    it("returns empty array if file does not exist", async () => {
      const store = createStore();
      const records = await store.readAll();
      expect(records).toEqual([]);
    });

    it("skips malformed JSONL lines", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n` +
          `{invalid json}\n` +
          `{"id":"evt_2","type":"submit","timestamp":200,"_version":1}\n`,
        "utf-8",
      );

      const store = createStore();
      const records = await store.readAll();

      expect(records).toHaveLength(2);
      expect(records.map((r) => r.id)).toEqual(["evt_1", "evt_2"]);
    });

    it("skips records that fail schema validation", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n` +
          `{"id":"evt_2","type":"click","_version":1}\n` + // missing timestamp
          `{"id":"evt_3","type":"submit","timestamp":300,"_version":1}\n`,
        "utf-8",
      );

      const store = createStore();
      const records = await store.readAll();

      expect(records).toHaveLength(2);
      expect(records.map((r) => r.id)).toEqual(["evt_1", "evt_3"]);
    });

    it("merges multiple versions of same record (latest wins)", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.update("evt_1", { type: "hover" });
      await store.update("evt_1", { type: "submit" });

      const records = await store.readAll();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        id: "evt_1",
        type: "submit",
        timestamp: 100,
      });
    });

    it("strips _version field from returned records", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });

      const records = await store.readAll();
      expect(records[0]).not.toHaveProperty("_version");
    });
  });

  describe("compact", () => {
    it("rewrites file with only latest versions", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.update("evt_1", { type: "hover" });
      await store.update("evt_1", { type: "submit" });

      await store.compact();

      const content = await readFile(path.join(TMP_DIR, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!);
      expect(record).toEqual({
        id: "evt_1",
        type: "submit",
        timestamp: 100,
        _version: 3,
      });
    });

    it("preserves all unique records", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });
      await store.append({ id: "evt_2", type: "hover", timestamp: 200 });
      await store.update("evt_1", { type: "submit" });

      await store.compact();

      const records = await store.readAll();
      expect(records).toHaveLength(2);
      expect(records.find((r) => r.id === "evt_1")?.type).toBe("submit");
      expect(records.find((r) => r.id === "evt_2")?.type).toBe("hover");
    });

    it("handles empty file gracefully", async () => {
      const store = createStore();
      await store.compact();

      const records = await store.readAll();
      expect(records).toEqual([]);
    });

    it("throws if file exceeds 100MB", async () => {
      const filePath = path.join(TMP_DIR, "large.jsonl");

      // Create a mock store that will trigger size check
      const largeStore = new JsonlStore({
        filePath,
        schema: eventSchema,
        idField: "id",
      });

      // Write a file that's too large (simulate by writing large content)
      const largeContent = `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n`.repeat(
        6_000_000,
      ); // ~120MB
      await writeFile(filePath, largeContent, "utf-8");

      await expect(largeStore.compact()).rejects.toThrow(/File size .* exceeds maximum .* bytes/);
    });

    it("does not throw for file under 100MB", async () => {
      const store = createStore();
      // Write ~50KB of data
      for (let i = 0; i < 1000; i++) {
        await store.append({
          id: `evt_${i}`,
          type: "click",
          timestamp: Date.now(),
        });
      }

      await expect(store.compact()).resolves.not.toThrow();
    });
  });

  describe("rebuildIndex", () => {
    it("throws if file exceeds 100MB", async () => {
      const filePath = path.join(TMP_DIR, "large.jsonl");

      const largeStore = new JsonlStore({
        filePath,
        schema: eventSchema,
        idField: "id",
      });

      // Write oversized file
      const largeContent = `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n`.repeat(
        6_000_000,
      );
      await writeFile(filePath, largeContent, "utf-8");

      // Trigger rebuild via update on missing ID
      await expect(largeStore.update("evt_1", { type: "submit" })).rejects.toThrow(
        /File size .* exceeds maximum .* bytes/,
      );
    });

    it("rebuilds index correctly from file with multiple versions", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n` +
          `{"id":"evt_1","type":"hover","_version":2}\n` +
          `{"id":"evt_2","type":"submit","timestamp":200,"_version":1}\n`,
        "utf-8",
      );

      const store = createStore();
      // Force index rebuild by doing an update
      await store.update("evt_1", { type: "submit" });

      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");
      const lastLine = JSON.parse(lines[lines.length - 1]!);

      expect(lastLine._version).toBe(3); // Should increment from rebuilt version 2
    });
  });

  describe("index consistency", () => {
    it("rebuilds index on first read if file exists but index is empty", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n` +
          `{"id":"evt_2","type":"submit","timestamp":200,"_version":1}\n`,
        "utf-8",
      );

      // Create new store instance (empty index)
      const store = createStore();

      // readAll should work correctly even with empty index
      const records = await store.readAll();
      expect(records).toHaveLength(2);
    });

    it("accepts eventual consistency - index updated during readAll", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100,"_version":3}\n`,
        "utf-8",
      );

      const store = createStore();
      await store.readAll(); // Populates index

      // Now update should use correct version from index
      await store.update("evt_1", { type: "submit" });

      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");
      const lastLine = JSON.parse(lines[lines.length - 1]!);

      expect(lastLine._version).toBe(4);
    });
  });

  describe("concurrent operations", () => {
    it("serializes concurrent writes via mutex", async () => {
      const store = createStore();

      // Mix appends and updates concurrently
      await Promise.all([
        store.append({ id: "evt_1", type: "click", timestamp: 100 }),
        store.append({ id: "evt_2", type: "click", timestamp: 200 }),
      ]);

      await Promise.all([
        store.update("evt_1", { type: "submit" }),
        store.update("evt_2", { type: "hover" }),
      ]);

      const records = await store.readAll();
      expect(records).toHaveLength(2);
      expect(records.find((r) => r.id === "evt_1")?.type).toBe("submit");
      expect(records.find((r) => r.id === "evt_2")?.type).toBe("hover");
    });

    it("handles concurrent updates to same record", async () => {
      const store = createStore();
      await store.append({ id: "evt_1", type: "click", timestamp: 100 });

      // Fire multiple updates concurrently
      await Promise.all([
        store.update("evt_1", { type: "hover" }),
        store.update("evt_1", { type: "submit" }),
        store.update("evt_1", { type: "error" }),
      ]);

      const content = await readFile(path.join(TMP_DIR, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");

      // Should have 4 lines: initial + 3 updates
      expect(lines).toHaveLength(4);

      // Versions should be sequential due to write lock
      const versions = lines.map((line) => JSON.parse(line)._version);
      expect(versions).toEqual([1, 2, 3, 4]);
    });
  });

  describe("edge cases", () => {
    it("handles empty lines in JSONL file", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100,"_version":1}\n` +
          `\n` +
          `   \n` +
          `{"id":"evt_2","type":"submit","timestamp":200,"_version":1}\n`,
        "utf-8",
      );

      const store = createStore();
      const records = await store.readAll();

      expect(records).toHaveLength(2);
    });

    it("handles file with only malformed lines", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{invalid}\n` + `{also invalid}\n` + `not even close to json\n`,
        "utf-8",
      );

      const store = createStore();
      const records = await store.readAll();

      expect(records).toEqual([]);
    });

    it("handles record with missing _version field", async () => {
      const filePath = path.join(TMP_DIR, "events.jsonl");
      await writeFile(
        filePath,
        `{"id":"evt_1","type":"click","timestamp":100}\n`, // No _version
        "utf-8",
      );

      const store = createStore();
      const records = await store.readAll();

      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        id: "evt_1",
        type: "click",
        timestamp: 100,
      });
    });
  });
});
