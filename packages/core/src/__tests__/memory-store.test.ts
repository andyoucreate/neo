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
    it("writes and retrieves a fact", async () => {
      const store = createStore();
      const id = await store.write({
        type: "fact",
        scope: "global",
        content: "Uses TypeScript",
        source: "developer",
      });
      const results = store.query({ types: ["fact"] });
      expect(results).toHaveLength(1);
      const entry = results[0];
      expect(entry).toBeDefined();
      expect(entry?.content).toBe("Uses TypeScript");
      expect(entry?.id).toBe(id);
      store.close();
    });

    it("filters by scope (includes global)", async () => {
      const store = createStore();
      await store.write({ type: "fact", scope: "global", content: "Global fact", source: "user" });
      await store.write({ type: "fact", scope: "/repo/a", content: "Repo A fact", source: "user" });
      await store.write({ type: "fact", scope: "/repo/b", content: "Repo B fact", source: "user" });

      const results = store.query({ scope: "/repo/a", types: ["fact"] });
      expect(results).toHaveLength(2); // global + repo A
      expect(results.map((r) => r.content)).toContain("Global fact");
      expect(results.map((r) => r.content)).toContain("Repo A fact");
      expect(results.map((r) => r.content)).not.toContain("Repo B fact");
      store.close();
    });

    it("filters by type", async () => {
      const store = createStore();
      await store.write({ type: "fact", scope: "global", content: "A fact", source: "user" });
      await store.write({
        type: "procedure",
        scope: "global",
        content: "A procedure",
        source: "user",
      });

      const facts = store.query({ types: ["fact"] });
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toBe("fact");
      store.close();
    });

    it("filters by since timestamp", async () => {
      const store = createStore();
      await store.write({ type: "fact", scope: "global", content: "Old fact", source: "user" });
      // Small delay to ensure distinct timestamps
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cutoff = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.write({ type: "fact", scope: "global", content: "New fact", source: "user" });

      const results = store.query({ since: cutoff });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("New fact");
      store.close();
    });

    it("limits results", async () => {
      const store = createStore();
      for (let i = 0; i < 10; i++) {
        await store.write({ type: "fact", scope: "global", content: `Fact ${i}`, source: "user" });
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
        type: "fact",
        scope: "global",
        content: "Old",
        source: "user",
      });
      store.update(id, "New");
      const results = store.query({ types: ["fact"] });
      expect(results[0]?.content).toBe("New");
      store.close();
    });
  });

  describe("forget", () => {
    it("removes a memory", async () => {
      const store = createStore();
      const id = await store.write({
        type: "fact",
        scope: "global",
        content: "To delete",
        source: "user",
      });
      store.forget(id);
      const results = store.query({ types: ["fact"] });
      expect(results).toHaveLength(0);
      store.close();
    });
  });

  describe("markAccessed", () => {
    it("increments access count and updates timestamp", async () => {
      const store = createStore();
      const id = await store.write({
        type: "fact",
        scope: "global",
        content: "Test",
        source: "user",
      });

      const before = store.query({ types: ["fact"] });
      expect(before).toHaveLength(1);
      expect(before[0]?.accessCount).toBe(0);

      store.markAccessed([id]);
      store.markAccessed([id]);

      const after = store.query({ types: ["fact"] });
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
      await store.write({ type: "fact", scope: "global", content: "Not expired", source: "user" });

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
      await store.write({ type: "fact", scope: "global", content: "Low access", source: "user" });

      // Fresh entries should not be decayed
      const removed = store.decay(30, 3);
      expect(removed).toBe(0);
      store.close();
    });
  });

  describe("stats", () => {
    it("returns correct counts", async () => {
      const store = createStore();
      await store.write({ type: "fact", scope: "global", content: "F1", source: "user" });
      await store.write({ type: "fact", scope: "/repo/a", content: "F2", source: "user" });
      await store.write({ type: "procedure", scope: "global", content: "P1", source: "user" });

      const stats = store.stats();
      expect(stats.total).toBe(3);
      expect(stats.byType.fact).toBe(2);
      expect(stats.byType.procedure).toBe(1);
      expect(stats.byScope.global).toBe(2);
      expect(stats.byScope["/repo/a"]).toBe(1);
      store.close();
    });
  });

  describe("search (FTS)", () => {
    it("finds memories by content keywords", async () => {
      const store = createStore();
      await store.write({
        type: "fact",
        scope: "global",
        content: "Uses Prisma with PostgreSQL",
        source: "dev",
      });
      await store.write({
        type: "fact",
        scope: "global",
        content: "Tests use Vitest framework",
        source: "dev",
      });

      const results = await store.search("Prisma database");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]?.content).toContain("Prisma");
      store.close();
    });
  });
});
