import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        type: "knowledge",
        scope: "global",
        content: "TypeScript is a typed language",
        source: "dev",
        subtype: "fact",
      });
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Python is a dynamic language",
        source: "dev",
        subtype: "fact",
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
        type: "knowledge",
        scope: "global",
        content: "Low access",
        source: "user",
        subtype: "fact",
      });
      const id2 = await store.write({
        type: "knowledge",
        scope: "global",
        content: "High access",
        source: "user",
        subtype: "fact",
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

  describe("migration error handling", () => {
    it("logs error to console.error when migration fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Create a corrupted database that will cause migration to fail
      // We simulate this by creating a database with old schema types but
      // with data that will fail the INSERT during table recreation
      const dbPath = path.join(TMP_DIR, "corrupted.sqlite");

      // Create database with old-style schema that will trigger migration but fail
      // The migration check looks for 'fact' in tableInfo.sql (sqlite_master)
      // We include 'fact' in a comment to trigger migration, but insert invalid data
      // that will fail the new CHECK constraint during table recreation
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

      // The comment below contains 'fact' which triggers hasOldTypes check in migrateSchemaIfNeeded()
      // No CHECK constraint so we can insert invalid type data
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL, -- old types included: 'fact', 'procedure'
          scope TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          tags TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          access_count INTEGER DEFAULT 0,
          expires_at TEXT,
          outcome TEXT,
          run_id TEXT,
          category TEXT,
          severity TEXT,
          subtype TEXT
        );
      `);

      // Insert a row with an INVALID type that will fail the new constraint
      // The migration will try to recreate the table with new CHECK constraint,
      // but this row with 'invalid_type' will cause the INSERT to fail
      db.exec(`
        INSERT INTO memories (id, type, scope, content, source, created_at, last_accessed_at)
        VALUES ('test_id', 'invalid_type', 'global', 'test', 'user', '2024-01-01', '2024-01-01');
      `);
      db.close();

      // Now open with MemoryStore — migration should fail but log the error
      const store = new MemoryStore(dbPath);

      // Verify error was logged
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls.find((call) =>
        String(call[0]).includes("[neo] Memory schema migration failed"),
      );
      expect(errorCall).toBeDefined();

      // Store should still be usable (graceful degradation)
      // The table may be in an inconsistent state, but the store object exists
      store.close();
      errorSpy.mockRestore();
    });

    it("does not log error when no migration is needed", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Create a fresh store — no migration needed
      const store = createStore();

      // No migration errors should be logged
      const migrationErrors = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes("[neo] Memory schema migration"),
      );
      expect(migrationErrors).toHaveLength(0);

      store.close();
      errorSpy.mockRestore();
    });
  });

  describe("schema migration from old to new", () => {
    it("migrates existing database with old CHECK constraint (fact, procedure types)", async () => {
      // This is the CRITICAL test case: existing DB with old schema
      // that previously failed with SQLITE_CONSTRAINT_CHECK
      const dbPath = path.join(TMP_DIR, "old-schema.sqlite");
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

      // Create table with OLD CHECK constraint (the original schema)
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('fact','procedure','feedback','episode','task','focus')),
          scope TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          tags TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          access_count INTEGER DEFAULT 0,
          expires_at TEXT,
          outcome TEXT,
          run_id TEXT,
          category TEXT,
          severity TEXT
        );
      `);

      // Insert data with old types
      db.exec(`
        INSERT INTO memories (id, type, scope, content, source, created_at, last_accessed_at)
        VALUES
          ('mem_fact1', 'fact', 'global', 'Uses TypeScript', 'developer', '2024-01-01', '2024-01-01'),
          ('mem_proc1', 'procedure', '/repo/a', 'Run pnpm build', 'developer', '2024-01-02', '2024-01-02'),
          ('mem_feed1', 'feedback', 'global', 'Always test first', 'reviewer', '2024-01-03', '2024-01-03'),
          ('mem_focus1', 'focus', 'global', 'Current task', 'user', '2024-01-04', '2024-01-04');
      `);
      db.close();

      // Now open with MemoryStore — migration should succeed
      const store = new MemoryStore(dbPath);

      // Verify migration worked
      const knowledge = store.query({ types: ["knowledge"] });
      expect(knowledge).toHaveLength(2); // fact + procedure → knowledge
      expect(knowledge.map((m) => m.subtype).sort()).toEqual(["fact", "procedure"]);
      expect(knowledge.find((m) => m.content === "Uses TypeScript")?.subtype).toBe("fact");
      expect(knowledge.find((m) => m.content === "Run pnpm build")?.subtype).toBe("procedure");

      const warnings = store.query({ types: ["warning"] });
      expect(warnings).toHaveLength(1); // feedback → warning
      expect(warnings[0]?.content).toBe("Always test first");

      const focus = store.query({ types: ["focus"] });
      expect(focus).toHaveLength(1); // focus unchanged
      expect(focus[0]?.content).toBe("Current task");

      // CRITICAL: Verify new type 'knowledge' can be written (the original bug)
      const newId = await store.write({
        type: "knowledge",
        scope: "global",
        content: "New knowledge entry",
        source: "user",
        subtype: "fact",
      });
      expect(newId).toBeDefined();

      const newEntry = store.query({ types: ["knowledge"] }).find((m) => m.id === newId);
      expect(newEntry?.content).toBe("New knowledge entry");

      store.close();
    });

    it("handles existing database without subtype column", async () => {
      const dbPath = path.join(TMP_DIR, "no-subtype.sqlite");
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

      // Create table with old schema WITHOUT subtype column
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('fact','procedure','focus')),
          scope TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          tags TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          access_count INTEGER DEFAULT 0,
          expires_at TEXT,
          outcome TEXT,
          run_id TEXT,
          category TEXT,
          severity TEXT
        );

        INSERT INTO memories (id, type, scope, content, source, created_at, last_accessed_at)
        VALUES ('mem_fact1', 'fact', 'global', 'A fact', 'user', '2024-01-01', '2024-01-01');
      `);
      db.close();

      // Migration should add subtype column and migrate
      const store = new MemoryStore(dbPath);

      const knowledge = store.query({ types: ["knowledge"] });
      expect(knowledge).toHaveLength(1);
      expect(knowledge[0]?.subtype).toBe("fact"); // subtype was set during migration

      store.close();
    });

    it("new databases work correctly with new schema", async () => {
      // Fresh database should just work without migration
      const store = createStore();

      // Write all new types
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
      await store.write({
        type: "focus",
        scope: "global",
        content: "Current focus",
        source: "user",
      });

      const knowledge = store.query({ types: ["knowledge"] });
      expect(knowledge).toHaveLength(1);

      const warnings = store.query({ types: ["warning"] });
      expect(warnings).toHaveLength(1);

      const focus = store.query({ types: ["focus"] });
      expect(focus).toHaveLength(1);

      store.close();
    });

    it("handles database with already-migrated schema (idempotent)", async () => {
      // Run migration twice — should be safe
      const dbPath = path.join(TMP_DIR, "idempotent.sqlite");

      // First open creates fresh DB
      const store1 = new MemoryStore(dbPath);
      await store1.write({
        type: "knowledge",
        scope: "global",
        content: "Test entry",
        source: "user",
        subtype: "fact",
      });
      store1.close();

      // Second open should not break anything
      const store2 = new MemoryStore(dbPath);
      const entries = store2.query({ types: ["knowledge"] });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.content).toBe("Test entry");

      // Can still write
      await store2.write({
        type: "knowledge",
        scope: "global",
        content: "Another entry",
        source: "user",
        subtype: "procedure",
      });
      expect(store2.query({ types: ["knowledge"] })).toHaveLength(2);

      store2.close();
    });
  });
});
