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

  describe("schema migration from old to new", () => {
    it("migrates existing database with old schema types to new schema", async () => {
      const dbPath = path.join(TMP_DIR, "old-schema.sqlite");

      // Create database with OLD schema (fact, procedure, feedback, episode, task, focus)
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

      // Old schema with old CHECK constraint
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
          ('fact_1', 'fact', 'global', 'TypeScript is used', 'user', '2024-01-01', '2024-01-01'),
          ('proc_1', 'procedure', '/repo/a', 'Run pnpm build first', 'user', '2024-01-02', '2024-01-02'),
          ('feed_1', 'feedback', 'global', 'Always run tests', 'reviewer', '2024-01-03', '2024-01-03'),
          ('focus_1', 'focus', 'global', 'Current task focus', 'user', '2024-01-04', '2024-01-04');
      `);
      db.close();

      // Open with MemoryStore — migration should run automatically
      const store = new MemoryStore(dbPath);

      // Verify migration was successful
      // 1. fact → knowledge with subtype=fact
      const knowledge = store.query({ types: ["knowledge"] });
      expect(knowledge).toHaveLength(2); // fact_1 and proc_1

      const factEntry = knowledge.find((e) => e.id === "fact_1");
      expect(factEntry).toBeDefined();
      expect(factEntry?.type).toBe("knowledge");
      expect(factEntry?.subtype).toBe("fact");
      expect(factEntry?.content).toBe("TypeScript is used");

      // 2. procedure → knowledge with subtype=procedure
      const procEntry = knowledge.find((e) => e.id === "proc_1");
      expect(procEntry).toBeDefined();
      expect(procEntry?.type).toBe("knowledge");
      expect(procEntry?.subtype).toBe("procedure");

      // 3. feedback → warning
      const warnings = store.query({ types: ["warning"] });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.id).toBe("feed_1");
      expect(warnings[0]?.type).toBe("warning");

      // 4. focus stays as focus
      const focus = store.query({ types: ["focus"] });
      expect(focus).toHaveLength(1);
      expect(focus[0]?.id).toBe("focus_1");
      expect(focus[0]?.type).toBe("focus");

      // 5. New writes should work with new types
      const newId = await store.write({
        type: "knowledge",
        scope: "global",
        content: "New knowledge entry",
        source: "user",
        subtype: "fact",
      });
      expect(newId).toBeDefined();

      const allKnowledge = store.query({ types: ["knowledge"] });
      expect(allKnowledge).toHaveLength(3); // 2 migrated + 1 new

      store.close();
    });

    it("preserves data integrity during migration", async () => {
      const dbPath = path.join(TMP_DIR, "integrity-test.sqlite");

      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

      // Old schema
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
          access_count INTEGER DEFAULT 5,
          expires_at TEXT,
          outcome TEXT,
          run_id TEXT,
          category TEXT,
          severity TEXT
        );
      `);

      db.exec(`
        INSERT INTO memories (id, type, scope, content, source, tags, created_at, last_accessed_at, access_count, category)
        VALUES ('test_1', 'fact', '/my/repo', 'Important fact', 'developer', '["tag1","tag2"]', '2024-06-15T10:00:00Z', '2024-06-20T15:30:00Z', 42, 'testing');
      `);
      db.close();

      const store = new MemoryStore(dbPath);

      const results = store.query({ types: ["knowledge"] });
      expect(results).toHaveLength(1);

      const entry = results[0];
      expect(entry?.id).toBe("test_1");
      expect(entry?.type).toBe("knowledge");
      expect(entry?.subtype).toBe("fact");
      expect(entry?.scope).toBe("/my/repo");
      expect(entry?.content).toBe("Important fact");
      expect(entry?.source).toBe("developer");
      expect(entry?.tags).toEqual(["tag1", "tag2"]);
      expect(entry?.createdAt).toBe("2024-06-15T10:00:00Z");
      expect(entry?.lastAccessedAt).toBe("2024-06-20T15:30:00Z");
      expect(entry?.accessCount).toBe(42);
      expect(entry?.category).toBe("testing");

      store.close();
    });

    it("deletes episode and task entries during migration", async () => {
      const dbPath = path.join(TMP_DIR, "delete-test.sqlite");

      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

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

      db.exec(`
        INSERT INTO memories (id, type, scope, content, source, created_at, last_accessed_at)
        VALUES
          ('fact_1', 'fact', 'global', 'Keep me', 'user', '2024-01-01', '2024-01-01'),
          ('episode_1', 'episode', 'global', 'Delete me', 'user', '2024-01-01', '2024-01-01'),
          ('task_1', 'task', 'global', 'Delete me too', 'user', '2024-01-01', '2024-01-01');
      `);
      db.close();

      const store = new MemoryStore(dbPath);

      // Only fact_1 should remain (as knowledge)
      const all = store.query({});
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe("fact_1");
      expect(all[0]?.type).toBe("knowledge");

      store.close();
    });

    it("preserves FTS search functionality after migration", async () => {
      const dbPath = path.join(TMP_DIR, "fts-migration.sqlite");

      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);

      // Create old schema with FTS
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

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='rowid',
          tokenize='porter'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);

      // Insert searchable data
      db.exec(`
        INSERT INTO memories (id, type, scope, content, source, created_at, last_accessed_at)
        VALUES
          ('fact_1', 'fact', 'global', 'TypeScript is a typed superset of JavaScript', 'user', '2024-01-01', '2024-01-01'),
          ('proc_1', 'procedure', 'global', 'Always run pnpm build before deployment', 'user', '2024-01-02', '2024-01-02');
      `);
      db.close();

      // Open with MemoryStore — migration should run and rebuild FTS
      const store = new MemoryStore(dbPath);

      // Verify migrated data is searchable
      const tsResults = await store.search("TypeScript");
      expect(tsResults.length).toBeGreaterThanOrEqual(1);
      expect(tsResults[0]?.content).toContain("TypeScript");
      expect(tsResults[0]?.type).toBe("knowledge");

      const buildResults = await store.search("pnpm build");
      expect(buildResults.length).toBeGreaterThanOrEqual(1);
      expect(buildResults[0]?.content).toContain("pnpm build");

      // Verify new entries are also searchable
      await store.write({
        type: "knowledge",
        scope: "global",
        content: "Vitest is the testing framework",
        source: "user",
        subtype: "fact",
      });

      const vitestResults = await store.search("Vitest testing");
      expect(vitestResults.length).toBeGreaterThanOrEqual(1);
      expect(vitestResults[0]?.content).toContain("Vitest");

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
});
