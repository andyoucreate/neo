import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/supervisor/memory/store";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_memory_store_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createStore(): MemoryStore {
  return new MemoryStore(path.join(TMP_DIR, "memory.sqlite"));
}

describe("MemoryStore", () => {
  describe("write + query", () => {
    it("writes and retrieves a knowledge entry with subtype fact", async () => {
      const store = createStore();
      const id = await store.write({
        type: "knowledge",
        scope: "global",
        content: "Uses TypeScript",
        source: "developer",
        subtype: "fact",
      });
      const results = store.query({ types: ["knowledge"] });
      expect(results).toHaveLength(1);
      const entry = results[0];
      expect(entry).toBeDefined();
      expect(entry?.content).toBe("Uses TypeScript");
      expect(entry?.id).toBe(id);
      expect(entry?.subtype).toBe("fact");
      store.close();
    });

    it("writes and retrieves a knowledge entry with subtype procedure", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Run pnpm build before deploy",
        source: "developer",
        subtype: "procedure",
      });
      const results = store.query({ types: ["knowledge"] });
      expect(results).toHaveLength(1);
      expect(results[0]?.subtype).toBe("procedure");
      store.close();
    });

    it("filters by scope (includes global)", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Global knowledge",
        source: "user",
        subtype: "fact",
      });
      await store.write({
        type: "knowledge",
        scope: "/repo/a",
        content: "Repo A knowledge",
        source: "user",
        subtype: "fact",
      });
      await store.write({
        type: "knowledge",
        scope: "/repo/b",
        content: "Repo B knowledge",
        source: "user",
        subtype: "fact",
      });

      const results = store.query({ scope: "/repo/a", types: ["knowledge"] });
      expect(results).toHaveLength(2); // global + repo A
      expect(results.map((r) => r.content)).toContain("Global knowledge");
      expect(results.map((r) => r.content)).toContain("Repo A knowledge");
      expect(results.map((r) => r.content)).not.toContain("Repo B knowledge");
      store.close();
    });

    it("filters by type", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "A knowledge fact",
        source: "user",
        subtype: "fact",
      });
      await store.write({
        type: "warning",
        scope: "global",
        content: "A warning",
        source: "user",
      });

      const knowledge = store.query({ types: ["knowledge"] });
      expect(knowledge).toHaveLength(1);
      expect(knowledge[0]?.type).toBe("knowledge");
      store.close();
    });

    it("filters by since timestamp", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Old knowledge",
        source: "user",
        subtype: "fact",
      });
      // Small delay to ensure distinct timestamps
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cutoff = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "New knowledge",
        source: "user",
        subtype: "fact",
      });

      const results = store.query({ since: cutoff });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("New knowledge");
      store.close();
    });

    it("limits results", async () => {
      const store = createStore();
      for (let i = 0; i < 10; i++) {
        await store.write({
          type: "knowledge",
          scope: "global",
          content: `Knowledge ${i}`,
          source: "user",
          subtype: "fact",
        });
      }
      const results = store.query({ limit: 3 });
      expect(results).toHaveLength(3);
      store.close();
    });
  });

  describe("update", () => {
    it("updates content of existing memory", async () => {
      const store = createStore();
      const id = await store.write({
        type: "knowledge",
        scope: "global",
        content: "Old",
        source: "user",
        subtype: "fact",
      });
      store.update(id, "New");
      const results = store.query({ types: ["knowledge"] });
      expect(results[0]?.content).toBe("New");
      store.close();
    });
  });

  describe("forget", () => {
    it("removes a memory", async () => {
      const store = createStore();
      const id = await store.write({
        type: "knowledge",
        scope: "global",
        content: "To delete",
        source: "user",
        subtype: "fact",
      });
      store.forget(id);
      const results = store.query({ types: ["knowledge"] });
      expect(results).toHaveLength(0);
      store.close();
    });
  });

  describe("markAccessed", () => {
    it("increments access count and updates timestamp", async () => {
      const store = createStore();
      const id = await store.write({
        type: "knowledge",
        scope: "global",
        content: "Test",
        source: "user",
        subtype: "fact",
      });

      const before = store.query({ types: ["knowledge"] });
      expect(before).toHaveLength(1);
      expect(before[0]?.accessCount).toBe(0);

      store.markAccessed([id]);
      store.markAccessed([id]);

      const after = store.query({ types: ["knowledge"] });
      expect(after).toHaveLength(1);
      expect(after[0]?.accessCount).toBe(2);
      store.close();
    });
  });

  describe("expireEphemeral", () => {
    it("removes expired focus entries", async () => {
      const store = createStore();
      // Use SQLite-compatible datetime format (datetime('now') returns 'YYYY-MM-DD HH:MM:SS')
      const past = new Date(Date.now() - 60_000);
      const pastDate = past
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");
      await store.write({
        type: "focus",
        scope: "global",
        content: "Expired",
        source: "user",
        expiresAt: pastDate,
      });
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Not expired",
        source: "user",
        subtype: "fact",
      });

      const removed = store.expireEphemeral();
      expect(removed).toBe(1);

      const results = store.query({});
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Not expired");
      store.close();
    });

    it("does not remove focus without expiresAt", async () => {
      const store = createStore();
      await store.write({ type: "focus", scope: "global", content: "No TTL", source: "user" });

      const removed = store.expireEphemeral();
      expect(removed).toBe(0);
      store.close();
    });
  });

  describe("decay", () => {
    it("removes old low-access memories", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Low access",
        source: "user",
        subtype: "fact",
      });

      // Fresh entries should not be decayed
      const removed = store.decay(30, 3);
      expect(removed).toBe(0);
      store.close();
    });
  });

  describe("stats", () => {
    it("returns correct counts", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "K1",
        source: "user",
        subtype: "fact",
      });
      await store.write({
        type: "knowledge",
        scope: "/repo/a",
        content: "K2",
        source: "user",
        subtype: "procedure",
      });
      await store.write({ type: "warning", scope: "global", content: "W1", source: "user" });

      const stats = store.stats();
      expect(stats.total).toBe(3);
      expect(stats.byType.knowledge).toBe(2);
      expect(stats.byType.warning).toBe(1);
      expect(stats.byScope.global).toBe(2);
      expect(stats.byScope["/repo/a"]).toBe(1);
      store.close();
    });
  });

  describe("search (FTS)", () => {
    it("finds memories by content keywords", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Uses Prisma with PostgreSQL",
        source: "dev",
        subtype: "fact",
      });
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Tests use Vitest framework",
        source: "dev",
        subtype: "fact",
      });

      const results = await store.search("Prisma database");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]?.content).toContain("Prisma");
      store.close();
    });
  });

  describe("warning memory type", () => {
    it("writes and retrieves a warning memory", async () => {
      const store = createStore();
      const id = await store.write({
        type: "warning",
        scope: "/repos/myapp",
        content: "Always run tests before commit",
        source: "reviewer",
        category: "testing",
      });

      const results = store.query({ types: ["warning"] });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Always run tests before commit");
      expect(results[0]?.type).toBe("warning");
      expect(results[0]?.id).toBe(id);
      expect(results[0]?.category).toBe("testing");
      store.close();
    });
  });

  describe("tag filtering", () => {
    it("implements tag filter in query", async () => {
      const store = createStore();
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Tagged entry",
        source: "user",
        subtype: "fact",
        tags: ["important", "auth"],
      });
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Untagged entry",
        source: "user",
        subtype: "fact",
      });

      const results = store.query({ tags: ["important"] });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Tagged entry");
      store.close();
    });
  });

  describe("search with scores", () => {
    it("returns SearchResult with score field", async () => {
      const store = createStore();
      await store.write({
        type: "fact",
        scope: "global",
        content: "TypeScript is a typed language",
        source: "dev",
      });
      await store.write({
        type: "fact",
        scope: "global",
        content: "Python is a dynamic language",
        source: "dev",
      });

      const results = await store.search("TypeScript typed");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]).toHaveProperty("score");
      expect(typeof results[0]?.score).toBe("number");
      expect(results[0]?.score).toBeGreaterThanOrEqual(0);
      expect(results[0]?.score).toBeLessThanOrEqual(1);
      store.close();
    });
  });

  describe("topAccessed", () => {
    it("returns memories sorted by access count", async () => {
      const store = createStore();
      await store.write({
        type: "fact",
        scope: "global",
        content: "Low access",
        source: "user",
      });
      const id2 = await store.write({
        type: "fact",
        scope: "global",
        content: "High access",
        source: "user",
      });

      // Access id2 multiple times
      store.markAccessed([id2]);
      store.markAccessed([id2]);
      store.markAccessed([id2]);

      const top = store.topAccessed(2);
      expect(top).toHaveLength(2);
      expect(top[0]?.id).toBe(id2);
      expect(top[0]?.accessCount).toBe(3);
      store.close();
    });
  });
});
