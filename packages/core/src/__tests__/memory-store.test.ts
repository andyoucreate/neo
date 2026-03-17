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

  describe("task memory type", () => {
    it("writes and retrieves a task memory", async () => {
      const store = createStore();
      const id = await store.write({
        type: "task",
        scope: "/repos/myapp",
        content: "T1: Implement auth middleware",
        source: "supervisor",
        outcome: "pending",
      });

      const results = store.query({ types: ["task"] });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("T1: Implement auth middleware");
      expect(results[0]?.type).toBe("task");
      expect(results[0]?.id).toBe(id);
      expect(results[0]?.outcome).toBe("pending");
      store.close();
    });

    it("filters tasks by type", async () => {
      const store = createStore();
      await store.write({
        type: "task",
        scope: "global",
        content: "Task 1",
        source: "supervisor",
        outcome: "pending",
      });
      await store.write({
        type: "fact",
        scope: "global",
        content: "Some fact",
        source: "user",
      });
      await store.write({
        type: "task",
        scope: "global",
        content: "Task 2",
        source: "supervisor",
        outcome: "in_progress",
      });

      const tasks = store.query({ types: ["task"] });
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.type === "task")).toBe(true);
      store.close();
    });

    it("updates task outcome with updateFields()", async () => {
      const store = createStore();
      const id = await store.write({
        type: "task",
        scope: "global",
        content: "Implement feature",
        source: "supervisor",
        outcome: "pending",
      });

      // Verify initial state
      let tasks = store.query({ types: ["task"] });
      expect(tasks[0]?.outcome).toBe("pending");

      // Update to in_progress
      store.updateFields(id, { outcome: "in_progress" });
      tasks = store.query({ types: ["task"] });
      expect(tasks[0]?.outcome).toBe("in_progress");

      // Update to done
      store.updateFields(id, { outcome: "done" });
      tasks = store.query({ types: ["task"] });
      expect(tasks[0]?.outcome).toBe("done");
      store.close();
    });

    it("updates multiple fields at once with updateFields()", async () => {
      const store = createStore();
      const id = await store.write({
        type: "task",
        scope: "global",
        content: "Task to update",
        source: "supervisor",
        outcome: "pending",
      });

      store.updateFields(id, {
        outcome: "in_progress",
        runId: "run_abc123",
        content: "Updated task content",
      });

      const tasks = store.query({ types: ["task"] });
      expect(tasks[0]?.outcome).toBe("in_progress");
      expect(tasks[0]?.runId).toBe("run_abc123");
      expect(tasks[0]?.content).toBe("Updated task content");
      store.close();
    });
  });

  describe("decay with tasks", () => {
    it("removes completed tasks older than 7 days", async () => {
      const store = createStore();

      // Create a done task and manually backdate it
      const id = await store.write({
        type: "task",
        scope: "global",
        content: "Old completed task",
        source: "supervisor",
        outcome: "done",
      });

      // Backdate the task to 10 days ago using raw SQL
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      // Access private db for testing - hacky but necessary
      (
        store as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
        }
      ).db
        .prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
        .run(tenDaysAgo, id);

      // Also add a fresh fact to ensure it's not removed
      await store.write({
        type: "fact",
        scope: "global",
        content: "Fresh fact",
        source: "user",
      });

      const removed = store.decay(30, 3);
      expect(removed).toBeGreaterThanOrEqual(1);

      // Done task should be removed
      const tasks = store.query({ types: ["task"] });
      expect(tasks).toHaveLength(0);

      // Fresh fact should remain
      const facts = store.query({ types: ["fact"] });
      expect(facts).toHaveLength(1);
      store.close();
    });

    it("does NOT decay tasks with pending outcome", async () => {
      const store = createStore();

      const id = await store.write({
        type: "task",
        scope: "global",
        content: "Old pending task",
        source: "supervisor",
        outcome: "pending",
      });

      // Backdate to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      (
        store as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
        }
      ).db
        .prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
        .run(tenDaysAgo, id);

      const removed = store.decay(30, 3);
      // Task should NOT be removed since it's pending
      expect(removed).toBe(0);

      const tasks = store.query({ types: ["task"] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.content).toBe("Old pending task");
      store.close();
    });

    it("does NOT decay tasks with in_progress outcome", async () => {
      const store = createStore();

      const id = await store.write({
        type: "task",
        scope: "global",
        content: "Old in-progress task",
        source: "supervisor",
        outcome: "in_progress",
      });

      // Backdate to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      (
        store as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
        }
      ).db
        .prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
        .run(tenDaysAgo, id);

      const removed = store.decay(30, 3);
      // Task should NOT be removed since it's in_progress
      expect(removed).toBe(0);

      const tasks = store.query({ types: ["task"] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.content).toBe("Old in-progress task");
      store.close();
    });
  });
});
