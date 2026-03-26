# Memory System Refactor Implementation Plan

**Goal:** Fix the broken information pipeline between agents and supervisor by consolidating memory types, separating tasks into a dedicated store, implementing semantic search, and adding role-specific memory guidance.

**Architecture:** Replace 6 memory types with 3 (knowledge, warning, focus), extract tasks to a separate TaskStore table, implement semantic retrieval using task prompt, and add agent-role-specific memory write instructions.

**Tech Stack:** SQLite (better-sqlite3), Zod schemas, TypeScript, Vitest

---

## File Structure Map

### Files to Modify
1. `packages/core/src/supervisor/memory/entry.ts` — Schema definitions
2. `packages/core/src/supervisor/memory/store.ts` — MemoryStore with migration
3. `packages/core/src/supervisor/memory/format.ts` — Formatting for prompts
4. `packages/core/src/supervisor/memory/index.ts` — Exports
5. `packages/core/src/supervisor/prompt-builder.ts` — Supervisor prompt building
6. `packages/core/src/supervisor/heartbeat.ts` — gatherEventContext
7. `packages/core/src/orchestrator/prompt-builder.ts` — Agent reporting instructions
8. `packages/core/src/orchestrator.ts` — loadMemoryContext with semantic search
9. `packages/cli/src/commands/memory.ts` — CLI with new types

### Files to Create
1. `packages/core/src/supervisor/task-store.ts` — Dedicated TaskStore

### Files to Update Tests
1. `packages/core/src/__tests__/memory-store.test.ts`
2. `packages/core/src/__tests__/prompt-builder.test.ts`
3. `packages/core/src/__tests__/task-store.test.ts` (new)

---

## Task 1: Update Memory Entry Schemas

**Files:**
- Modify: `packages/core/src/supervisor/memory/entry.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/memory-entry.test.ts
import { describe, expect, it } from "vitest";
import {
  memoryEntrySchema,
  memoryTypeSchema,
  memoryWriteInputSchema,
} from "@/supervisor/memory/entry";

describe("memoryTypeSchema", () => {
  it("accepts new types: knowledge, warning, focus", () => {
    expect(memoryTypeSchema.parse("knowledge")).toBe("knowledge");
    expect(memoryTypeSchema.parse("warning")).toBe("warning");
    expect(memoryTypeSchema.parse("focus")).toBe("focus");
  });

  it("rejects old types: fact, procedure, episode, feedback, task", () => {
    expect(() => memoryTypeSchema.parse("fact")).toThrow();
    expect(() => memoryTypeSchema.parse("procedure")).toThrow();
    expect(() => memoryTypeSchema.parse("episode")).toThrow();
    expect(() => memoryTypeSchema.parse("feedback")).toThrow();
    expect(() => memoryTypeSchema.parse("task")).toThrow();
  });
});

describe("memoryWriteInputSchema", () => {
  it("accepts subtype for knowledge entries", () => {
    const input = {
      type: "knowledge",
      content: "Test content",
      subtype: "fact",
    };
    const result = memoryWriteInputSchema.parse(input);
    expect(result.subtype).toBe("fact");
  });

  it("accepts subtype procedure for knowledge entries", () => {
    const input = {
      type: "knowledge",
      content: "Test content",
      subtype: "procedure",
    };
    const result = memoryWriteInputSchema.parse(input);
    expect(result.subtype).toBe("procedure");
  });
});

describe("memoryEntrySchema", () => {
  it("includes optional subtype field", () => {
    const entry = {
      id: "mem_abc123",
      type: "knowledge",
      scope: "global",
      content: "Test",
      source: "user",
      tags: [],
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      subtype: "fact",
    };
    const result = memoryEntrySchema.parse(entry);
    expect(result.subtype).toBe("fact");
  });

  it("does not require supersedes field", () => {
    const entry = {
      id: "mem_abc123",
      type: "knowledge",
      scope: "global",
      content: "Test",
      source: "user",
      tags: [],
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
    };
    const result = memoryEntrySchema.parse(entry);
    expect(result.supersedes).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/memory-entry.test.ts`
Expected: FAIL with schema validation errors (old types still exist)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/memory/entry.ts
import { z } from "zod";

// ─── Memory types ────────────────────────────────────────

export const memoryTypeSchema = z.enum([
  "knowledge", // replaces fact + procedure
  "warning",   // replaces feedback, always injected
  "focus",     // unchanged, ephemeral working memory
]);

export type MemoryType = z.infer<typeof memoryTypeSchema>;

// ─── Subtype for knowledge entries ───────────────────────

export const knowledgeSubtypeSchema = z.enum(["fact", "procedure"]);

export type KnowledgeSubtype = z.infer<typeof knowledgeSubtypeSchema>;

// ─── Memory entry (persisted in SQLite) ──────────────────

export const memoryEntrySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  scope: z.string(), // "global" | repo path
  content: z.string(),
  source: z.string(), // "developer" | "reviewer" | "supervisor" | "user"
  tags: z.array(z.string()).default([]),

  // Lifecycle
  createdAt: z.string(),
  lastAccessedAt: z.string(),
  accessCount: z.number().default(0),

  // Optional per-type fields
  expiresAt: z.string().optional(), // focus TTL
  outcome: z.string().optional(),   // legacy, kept for task migration
  runId: z.string().optional(),
  category: z.string().optional(),  // warning: category
  severity: z.string().optional(),
  subtype: z.string().optional(),   // knowledge: "fact" | "procedure"
  // supersedes removed — dead code
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

// ─── Write input (id and timestamps are auto-generated) ──

export const memoryWriteInputSchema = z.object({
  type: memoryTypeSchema,
  scope: z.string().default("global"),
  content: z.string(),
  source: z.string().default("user"),
  tags: z.array(z.string()).default([]),
  expiresAt: z.string().optional(),
  outcome: z.string().optional(),
  runId: z.string().optional(),
  category: z.string().optional(),
  severity: z.string().optional(),
  subtype: z.string().optional(), // "fact" | "procedure" for knowledge type
});

export type MemoryWriteInput = z.input<typeof memoryWriteInputSchema>;

// ─── Query options ───────────────────────────────────────

export interface MemoryQuery {
  scope?: string;
  types?: MemoryType[];
  since?: string; // ISO timestamp
  limit?: number;
  sortBy?: "relevance" | "createdAt" | "accessCount";
  tags?: string[];
}

// ─── Stats ───────────────────────────────────────────────

export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/memory-entry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/memory/entry.ts packages/core/src/__tests__/memory-entry.test.ts
git commit -m "$(cat <<'EOF'
refactor(memory): replace 6 types with 3 (knowledge, warning, focus)

- Remove fact, procedure, episode, feedback, task types
- Add knowledge type with subtype field (fact | procedure)
- Add warning type (always injected, replaces feedback)
- Keep focus type unchanged
- Remove supersedes field (dead code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create TaskStore

**Files:**
- Create: `packages/core/src/supervisor/task-store.ts`
- Test: `packages/core/src/__tests__/task-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/task-store.test.ts
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "@/supervisor/task-store";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_task_store_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createStore(): TaskStore {
  return new TaskStore(path.join(TMP_DIR, "memory.sqlite"));
}

describe("TaskStore", () => {
  describe("createTask", () => {
    it("creates a task and returns its id", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Implement auth middleware",
        scope: "/repos/myapp",
        status: "pending",
        priority: "high",
      });
      expect(id).toMatch(/^mem_/);
      store.close();
    });

    it("creates task with all optional fields", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task with metadata",
        scope: "/repos/myapp",
        status: "pending",
        priority: "critical",
        initiative: "auth-v2",
        dependsOn: "mem_abc123",
        context: "neo runs abc123",
        runId: "run_xyz",
      });
      const task = store.getTask(id);
      expect(task?.priority).toBe("critical");
      expect(task?.initiative).toBe("auth-v2");
      expect(task?.dependsOn).toBe("mem_abc123");
      expect(task?.context).toBe("neo runs abc123");
      expect(task?.runId).toBe("run_xyz");
      store.close();
    });
  });

  describe("getTask", () => {
    it("retrieves a task by id", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Test task",
        scope: "global",
        status: "pending",
      });
      const task = store.getTask(id);
      expect(task).toBeDefined();
      expect(task?.title).toBe("Test task");
      expect(task?.status).toBe("pending");
      store.close();
    });

    it("returns undefined for non-existent task", () => {
      const store = createStore();
      const task = store.getTask("mem_nonexistent");
      expect(task).toBeUndefined();
      store.close();
    });
  });

  describe("updateStatus", () => {
    it("updates task status", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task to update",
        scope: "global",
        status: "pending",
      });
      store.updateStatus(id, "in_progress");
      const task = store.getTask(id);
      expect(task?.status).toBe("in_progress");
      store.close();
    });

    it("updates runId when provided", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task with run",
        scope: "global",
        status: "pending",
      });
      store.updateStatus(id, "in_progress", "run_123");
      const task = store.getTask(id);
      expect(task?.runId).toBe("run_123");
      store.close();
    });
  });

  describe("getTasks", () => {
    it("filters by initiative", () => {
      const store = createStore();
      store.createTask({
        title: "Auth task",
        scope: "global",
        status: "pending",
        initiative: "auth-v2",
      });
      store.createTask({
        title: "Billing task",
        scope: "global",
        status: "pending",
        initiative: "billing",
      });
      const tasks = store.getTasks({ initiative: "auth-v2" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Auth task");
      store.close();
    });

    it("filters by status", () => {
      const store = createStore();
      store.createTask({
        title: "Pending task",
        scope: "global",
        status: "pending",
      });
      store.createTask({
        title: "Done task",
        scope: "global",
        status: "done",
      });
      const tasks = store.getTasks({ status: ["pending"] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Pending task");
      store.close();
    });

    it("filters by scope", () => {
      const store = createStore();
      store.createTask({
        title: "Repo A task",
        scope: "/repos/a",
        status: "pending",
      });
      store.createTask({
        title: "Repo B task",
        scope: "/repos/b",
        status: "pending",
      });
      const tasks = store.getTasks({ scope: "/repos/a" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Repo A task");
      store.close();
    });
  });

  describe("deleteTask", () => {
    it("removes a task", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task to delete",
        scope: "global",
        status: "pending",
      });
      store.deleteTask(id);
      const task = store.getTask(id);
      expect(task).toBeUndefined();
      store.close();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/task-store.test.ts`
Expected: FAIL with "Cannot find module '@/supervisor/task-store'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/task-store.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";

const esmRequire = createRequire(import.meta.url);

// ─── Task schemas ────────────────────────────────────────

export const taskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "blocked",
  "abandoned",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskPrioritySchema = z.enum(["critical", "high", "medium", "low"]);

export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema.optional(),
  initiative: z.string().optional(),
  dependsOn: z.string().optional(),
  context: z.string().optional(), // retrieval command
  runId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskEntry = z.infer<typeof taskEntrySchema>;

export interface TaskCreateInput {
  title: string;
  scope: string;
  status: TaskStatus;
  priority?: TaskPriority;
  initiative?: string;
  dependsOn?: string;
  context?: string;
  runId?: string;
}

export interface TaskQuery {
  initiative?: string;
  status?: TaskStatus[];
  scope?: string;
}

// ─── TaskStore ───────────────────────────────────────────

export class TaskStore {
  private db: import("better-sqlite3").Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const Database = esmRequire("better-sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.initSchema();
  }

  // ─── Schema initialization ───────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','blocked','abandoned')),
        priority TEXT CHECK(priority IN ('critical','high','medium','low')),
        initiative TEXT,
        depends_on TEXT,
        context TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_initiative ON tasks(initiative);
      CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
    `);

    // Migrate task entries from memories table if it exists
    this.migrateFromMemories();
  }

  /**
   * Migrate existing task-type memory entries to the tasks table.
   * One-time migration on first open.
   */
  private migrateFromMemories(): void {
    try {
      // Check if memories table exists
      const tableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
        .get() as { name: string } | undefined;
      if (!tableExists) return;

      // Check if there are task entries to migrate
      const taskCount = this.db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE type = 'task'")
        .get() as { count: number };
      if (taskCount.count === 0) return;

      // Migrate task entries
      this.db.exec(`
        INSERT OR IGNORE INTO tasks (id, title, scope, status, priority, initiative, depends_on, context, run_id, created_at, updated_at)
        SELECT
          id,
          content,
          scope,
          COALESCE(outcome, 'pending'),
          severity,
          NULL,
          NULL,
          category,
          run_id,
          created_at,
          last_accessed_at
        FROM memories
        WHERE type = 'task';

        DELETE FROM memories WHERE type = 'task';
      `);
    } catch {
      // Migration failed — memories table may not have task type yet
    }
  }

  // ─── CRUD operations ─────────────────────────────────

  createTask(input: TaskCreateInput): string {
    const id = `mem_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, scope, status, priority, initiative, depends_on, context, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.scope,
        input.status,
        input.priority ?? null,
        input.initiative ?? null,
        input.dependsOn ?? null,
        input.context ?? null,
        input.runId ?? null,
        now,
        now,
      );

    return id;
  }

  getTask(id: string): TaskEntry | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as RawTaskRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  updateStatus(id: string, status: TaskStatus, runId?: string): void {
    const now = new Date().toISOString();
    if (runId !== undefined) {
      this.db
        .prepare("UPDATE tasks SET status = ?, run_id = ?, updated_at = ? WHERE id = ?")
        .run(status, runId, now, id);
    } else {
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, id);
    }
  }

  getTasks(query: TaskQuery = {}): TaskEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.initiative) {
      conditions.push("initiative = ?");
      params.push(query.initiative);
    }

    if (query.status && query.status.length > 0) {
      const placeholders = query.status.map(() => "?").join(",");
      conditions.push(`status IN (${placeholders})`);
      params.push(...query.status);
    }

    if (query.scope) {
      conditions.push("scope = ?");
      params.push(query.scope);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
      .all(...params) as RawTaskRow[];

    return rows.map(rowToEntry);
  }

  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}

// ─── Internal helpers ────────────────────────────────────

interface RawTaskRow {
  id: string;
  title: string;
  scope: string;
  status: string;
  priority: string | null;
  initiative: string | null;
  depends_on: string | null;
  context: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: RawTaskRow): TaskEntry {
  return {
    id: row.id,
    title: row.title,
    scope: row.scope,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority | undefined,
    initiative: row.initiative ?? undefined,
    dependsOn: row.depends_on ?? undefined,
    context: row.context ?? undefined,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/task-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/task-store.ts packages/core/src/__tests__/task-store.test.ts
git commit -m "$(cat <<'EOF'
feat(memory): add TaskStore for dedicated task management

- Create separate tasks table in memory.sqlite
- Implement CRUD operations: createTask, getTask, updateStatus, getTasks, deleteTask
- Add filtering by initiative, status, and scope
- Auto-migrate existing task-type memories on first open

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update MemoryStore with Migration

**Files:**
- Modify: `packages/core/src/supervisor/memory/store.ts`
- Modify: `packages/core/src/__tests__/memory-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to packages/core/src/__tests__/memory-store.test.ts

describe("MemoryStore migration", () => {
  it("migrates fact type to knowledge with subtype fact", async () => {
    const store = createStore();

    // Write using new API
    const id = await store.write({
      type: "knowledge",
      scope: "global",
      content: "Test fact",
      source: "user",
      subtype: "fact",
    });

    const results = store.query({ types: ["knowledge"] });
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("knowledge");
    expect(results[0]?.subtype).toBe("fact");
    store.close();
  });

  it("writes warning type entries", async () => {
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
    expect(results[0]?.type).toBe("warning");
    expect(results[0]?.category).toBe("testing");
    store.close();
  });

  it("implements tag filter in query", async () => {
    const store = createStore();
    await store.write({
      type: "knowledge",
      scope: "global",
      content: "Tagged entry",
      source: "user",
      tags: ["important", "auth"],
    });
    await store.write({
      type: "knowledge",
      scope: "global",
      content: "Untagged entry",
      source: "user",
    });

    const results = store.query({ tags: ["important"] });
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("Tagged entry");
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/memory-store.test.ts`
Expected: FAIL with type validation errors (old types in schema)

- [ ] **Step 3: Write minimal implementation**

Update `packages/core/src/supervisor/memory/store.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryQuery, MemoryStats, MemoryWriteInput } from "./entry.js";

const esmRequire = createRequire(import.meta.url);

// ─── MemoryStore ─────────────────────────────────────────

export class MemoryStore {
  private db: import("better-sqlite3").Database;
  private embedder: Embedder | null;
  private hasVec: boolean;

  constructor(dbPath: string, embedder?: Embedder | null) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const Database = esmRequire("better-sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.embedder = embedder ?? null;
    this.hasVec = false;

    this.initSchema();
  }

  // ─── Schema initialization ───────────────────────────

  private initSchema(): void {
    // Create table with new type constraint
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('knowledge','warning','focus')),
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

      CREATE INDEX IF NOT EXISTS idx_mem_type_scope ON memories(type, scope);
      CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);
    `);

    // Run migration from old schema if needed
    this.migrateSchema();

    // FTS5 for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid',
        tokenize='porter'
      );
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);

    // sqlite-vec for vector search (optional)
    if (this.embedder) {
      try {
        const sqliteVec = esmRequire("sqlite-vec");
        sqliteVec.load(this.db);
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
            memory_id TEXT,
            embedding float[${this.embedder.dimensions}]
          );
        `);
        this.hasVec = true;
      } catch {
        this.hasVec = false;
      }
    }
  }

  /**
   * Migrate from old schema to new schema:
   * - fact, procedure → knowledge (with subtype)
   * - feedback → warning
   * - episode → delete
   * - task → migrated by TaskStore (deleted here)
   * - Add subtype column if missing
   */
  private migrateSchema(): void {
    try {
      // Check if we need to migrate (old types exist)
      const tableInfo = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
        .get() as { sql: string } | undefined;

      if (!tableInfo) return;

      // Add subtype column if missing
      const hasSubtype = tableInfo.sql.includes("subtype");
      if (!hasSubtype) {
        this.db.exec("ALTER TABLE memories ADD COLUMN subtype TEXT");
      }

      // Check if old types exist
      const oldTypes = this.db
        .prepare("SELECT DISTINCT type FROM memories WHERE type IN ('fact', 'procedure', 'feedback', 'episode', 'task')")
        .all() as { type: string }[];

      if (oldTypes.length === 0) return;

      // Migrate in a transaction
      this.db.exec("BEGIN TRANSACTION");
      try {
        // Capture subtypes before migration
        this.db.exec(`
          UPDATE memories SET subtype = 'fact' WHERE type = 'fact';
          UPDATE memories SET subtype = 'procedure' WHERE type = 'procedure';
        `);

        // Migrate fact and procedure to knowledge
        this.db.exec(`
          UPDATE memories SET type = 'knowledge' WHERE type IN ('fact', 'procedure');
        `);

        // Migrate feedback to warning
        this.db.exec(`
          UPDATE memories SET type = 'warning' WHERE type = 'feedback';
        `);

        // Delete episodes (write-only, never read)
        this.db.exec(`
          DELETE FROM memories WHERE type = 'episode';
        `);

        // Delete tasks (migrated by TaskStore)
        this.db.exec(`
          DELETE FROM memories WHERE type = 'task';
        `);

        // Recreate table with new constraint
        this.db.exec(`
          ALTER TABLE memories RENAME TO memories_old;

          CREATE TABLE memories (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('knowledge','warning','focus')),
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

          INSERT INTO memories SELECT
            id, type, scope, content, source, tags, created_at, last_accessed_at,
            access_count, expires_at, outcome, run_id, category, severity, subtype
          FROM memories_old;

          DROP TABLE memories_old;
        `);

        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } catch {
      // Migration not needed or failed — continue
    }
  }

  // ─── Write ───────────────────────────────────────────

  async write(input: MemoryWriteInput): Promise<string> {
    const id = `mem_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memories (id, type, scope, content, source, tags, created_at, last_accessed_at, access_count, expires_at, outcome, run_id, category, severity, subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.scope ?? "global",
        input.content,
        input.source ?? "user",
        JSON.stringify(input.tags ?? []),
        now,
        now,
        input.expiresAt ?? null,
        input.outcome ?? null,
        input.runId ?? null,
        input.category ?? null,
        input.severity ?? null,
        input.subtype ?? null,
      );

    // Embed and store vector
    if (this.embedder && this.hasVec) {
      try {
        const [vector] = await this.embedder.embed([input.content]);
        const rowid = this.db.prepare("SELECT rowid FROM memories WHERE id = ?").get(id) as
          | { rowid: number }
          | undefined;
        if (rowid && vector) {
          this.db
            .prepare("INSERT INTO memories_vec (rowid, memory_id, embedding) VALUES (?, ?, ?)")
            .run(rowid.rowid, id, new Float32Array(vector));
        }
      } catch {
        // Embedding failed — entry still saved without vector
      }
    }

    return id;
  }

  // ─── Update ──────────────────────────────────────────

  update(id: string, content: string): void {
    this.db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(content, id);

    if (this.hasVec) {
      const row = this.db.prepare("SELECT rowid FROM memories WHERE id = ?").get(id) as
        | { rowid: number }
        | undefined;
      if (row) {
        this.db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(row.rowid);
      }
    }
  }

  // ─── Update fields ───────────────────────────────────

  updateFields(id: string, fields: { content?: string; outcome?: string; runId?: string }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.content !== undefined) {
      sets.push("content = ?");
      params.push(fields.content);
    }
    if (fields.outcome !== undefined) {
      sets.push("outcome = ?");
      params.push(fields.outcome);
    }
    if (fields.runId !== undefined) {
      sets.push("run_id = ?");
      params.push(fields.runId);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  // ─── Forget ──────────────────────────────────────────

  forget(id: string): void {
    const row = this.db.prepare("SELECT rowid FROM memories WHERE id = ?").get(id) as
      | { rowid: number }
      | undefined;
    if (row && this.hasVec) {
      this.db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(row.rowid);
    }
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  // ─── Query (synchronous — structured filters) ───────

  query(opts: MemoryQuery = {}): MemoryEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.scope) {
      conditions.push("(scope = ? OR scope = 'global')");
      params.push(opts.scope);
    }

    if (opts.types && opts.types.length > 0) {
      const placeholders = opts.types.map(() => "?").join(",");
      conditions.push(`type IN (${placeholders})`);
      params.push(...opts.types);
    }

    if (opts.since) {
      conditions.push("created_at > ?");
      params.push(opts.since);
    }

    // Tag filter using JSON_EACH
    if (opts.tags && opts.tags.length > 0) {
      const tagConditions = opts.tags.map(() => "EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)");
      conditions.push(`(${tagConditions.join(" OR ")})`);
      params.push(...opts.tags);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy: string;
    switch (opts.sortBy) {
      case "accessCount":
        orderBy = "ORDER BY access_count DESC";
        break;
      case "createdAt":
        orderBy = "ORDER BY created_at DESC";
        break;
      default:
        orderBy =
          "ORDER BY (access_count * MAX(0, 1.0 - (julianday('now') - julianday(last_accessed_at)) / 60.0)) DESC";
        break;
    }

    const limit = opts.limit ? `LIMIT ${opts.limit}` : "LIMIT 50";

    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ${orderBy} ${limit}`)
      .all(...params) as RawMemoryRow[];

    return rows.map(rowToEntry);
  }

  // ─── Search (async — semantic or FTS) ────────────────

  async search(text: string, opts: MemoryQuery = {}): Promise<MemoryEntry[]> {
    // Try vector search first
    if (this.embedder && this.hasVec) {
      try {
        const [queryVec] = await this.embedder.embed([text]);
        const limit = opts.limit ?? 20;

        const candidates = this.db
          .prepare(
            `SELECT m.*, v.distance
           FROM memories_vec v
           JOIN memories m ON m.rowid = v.rowid
           WHERE v.embedding MATCH ?
           ORDER BY v.distance
           LIMIT ?`,
          )
          .all(new Float32Array(queryVec as number[]), limit * 3) as (RawMemoryRow & {
          distance: number;
        })[];

        const filtered = candidates.filter((row) => {
          if (opts.scope && row.scope !== opts.scope && row.scope !== "global") return false;
          if (
            opts.types &&
            opts.types.length > 0 &&
            !opts.types.includes(row.type as MemoryEntry["type"])
          )
            return false;
          return true;
        });

        return filtered.slice(0, limit).map((row) => rowToEntry(row));
      } catch {
        // Fall through to FTS
      }
    }

    // Fallback: FTS5 full-text search
    const limit = opts.limit ?? 20;
    const ftsQuery = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(" OR ");

    if (!ftsQuery) return this.query(opts);

    try {
      const rows = this.db
        .prepare(
          `SELECT m.*, rank
         FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
        )
        .all(ftsQuery, limit) as RawMemoryRow[];

      const filtered = rows.filter((row) => {
        if (opts.scope && row.scope !== opts.scope && row.scope !== "global") return false;
        if (
          opts.types &&
          opts.types.length > 0 &&
          !opts.types.includes(row.type as MemoryEntry["type"])
        )
          return false;
        return true;
      });

      return filtered.map(rowToEntry);
    } catch {
      return this.query(opts);
    }
  }

  // ─── Lifecycle ───────────────────────────────────────

  markAccessed(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
    );
    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(now, id);
      }
    });
    transaction();
  }

  decay(maxAgeDays = 30, minAccessCount = 3): number {
    // Delete stale low-access memories (focus excluded)
    const staleResult = this.db
      .prepare(
        `DELETE FROM memories
       WHERE access_count < ?
         AND julianday('now') - julianday(last_accessed_at) > ?
         AND type NOT IN ('focus')`,
      )
      .run(minAccessCount, maxAgeDays);

    return staleResult.changes;
  }

  expireEphemeral(): number {
    const result = this.db
      .prepare(
        `DELETE FROM memories
       WHERE type = 'focus'
         AND expires_at IS NOT NULL
         AND expires_at < ?`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }

  // ─── Stats ───────────────────────────────────────────

  stats(): MemoryStats {
    const total = (
      this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number }
    ).count;

    const byTypeRows = this.db
      .prepare("SELECT type, COUNT(*) as count FROM memories GROUP BY type")
      .all() as { type: string; count: number }[];
    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.type] = row.count;
    }

    const byScopeRows = this.db
      .prepare("SELECT scope, COUNT(*) as count FROM memories GROUP BY scope")
      .all() as { scope: string; count: number }[];
    const byScope: Record<string, number> = {};
    for (const row of byScopeRows) {
      byScope[row.scope] = row.count;
    }

    return { total, byType, byScope };
  }

  // ─── Cleanup ─────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ─── Internal helpers ────────────────────────────────────

interface RawMemoryRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  source: string;
  tags: string;
  created_at: string;
  last_accessed_at: string;
  access_count: number;
  expires_at: string | null;
  outcome: string | null;
  run_id: string | null;
  category: string | null;
  severity: string | null;
  subtype: string | null;
}

function rowToEntry(row: RawMemoryRow): MemoryEntry {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }

  return {
    id: row.id,
    type: row.type as MemoryEntry["type"],
    scope: row.scope,
    content: row.content,
    source: row.source,
    tags,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    expiresAt: row.expires_at ?? undefined,
    outcome: row.outcome ?? undefined,
    runId: row.run_id ?? undefined,
    category: row.category ?? undefined,
    severity: row.severity ?? undefined,
    subtype: row.subtype ?? undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/memory-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/memory/store.ts packages/core/src/__tests__/memory-store.test.ts
git commit -m "$(cat <<'EOF'
refactor(memory): migrate store to new type system

- Add subtype column for knowledge entries
- Migrate fact/procedure → knowledge with subtype
- Migrate feedback → warning
- Delete episode entries (write-only, never read)
- Implement tag filter using JSON_EACH
- Remove task handling (moved to TaskStore)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update Memory Format

**Files:**
- Modify: `packages/core/src/supervisor/memory/format.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to packages/core/src/__tests__/memory-format.test.ts
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@/supervisor/memory/entry";
import { formatMemoriesForPrompt } from "@/supervisor/memory/format";

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_test",
    type: "knowledge",
    scope: "global",
    content: "Test content",
    source: "user",
    tags: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    ...overrides,
  };
}

describe("formatMemoriesForPrompt", () => {
  it("formats knowledge entries with subtype fact", () => {
    const memories = [makeEntry({ type: "knowledge", subtype: "fact", content: "API uses JWT" })];
    const result = formatMemoriesForPrompt(memories);
    expect(result).toContain("Facts");
    expect(result).toContain("API uses JWT");
  });

  it("formats knowledge entries with subtype procedure", () => {
    const memories = [makeEntry({ type: "knowledge", subtype: "procedure", content: "Run build first" })];
    const result = formatMemoriesForPrompt(memories);
    expect(result).toContain("How-to");
    expect(result).toContain("Run build first");
  });

  it("formats warning entries with icon", () => {
    const memories = [makeEntry({ type: "warning", content: "Never skip tests" })];
    const result = formatMemoriesForPrompt(memories);
    expect(result).toContain("⚠");
    expect(result).toContain("Critical patterns");
    expect(result).toContain("Never skip tests");
  });

  it("groups by type correctly", () => {
    const memories = [
      makeEntry({ type: "knowledge", subtype: "fact", content: "Fact 1" }),
      makeEntry({ type: "warning", content: "Warning 1" }),
      makeEntry({ type: "knowledge", subtype: "procedure", content: "Procedure 1" }),
    ];
    const result = formatMemoriesForPrompt(memories);
    expect(result).toContain("Facts");
    expect(result).toContain("How-to");
    expect(result).toContain("Critical patterns");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/memory-format.test.ts`
Expected: FAIL (old type labels)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/supervisor/memory/format.ts
import type { MemoryEntry } from "./entry.js";

const TYPE_LABELS: Record<string, string> = {
  knowledge: "Fact", // default, overridden by subtype
  warning: "Critical pattern",
  focus: "Current focus",
};

const SUBTYPE_LABELS: Record<string, string> = {
  fact: "Fact",
  procedure: "How-to",
};

const TYPE_ICONS: Record<string, string> = {
  knowledge: "·",
  warning: "⚠",
  focus: "★",
};

const SUBTYPE_ICONS: Record<string, string> = {
  fact: "·",
  procedure: "→",
};

/**
 * Format a list of memories for injection into an agent or supervisor prompt.
 * Groups by type/subtype, renders as concise markdown.
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";

  // Group by display key (type + subtype for knowledge)
  const grouped = new Map<string, MemoryEntry[]>();
  for (const m of memories) {
    let key = m.type;
    if (m.type === "knowledge" && m.subtype) {
      key = `knowledge:${m.subtype}`;
    }
    const group = grouped.get(key) ?? [];
    group.push(m);
    grouped.set(key, group);
  }

  const sections: string[] = [];

  for (const [key, entries] of grouped) {
    let label: string;
    let icon: string;

    if (key.startsWith("knowledge:")) {
      const subtype = key.split(":")[1];
      label = SUBTYPE_LABELS[subtype ?? ""] ?? "Fact";
      icon = SUBTYPE_ICONS[subtype ?? ""] ?? "·";
    } else {
      label = TYPE_LABELS[key] ?? key;
      icon = TYPE_ICONS[key] ?? "·";
    }

    const lines = entries.map((e) => {
      const confidence = e.accessCount >= 3 ? "" : " (unconfirmed)";
      return `${icon} ${e.content}${confidence}`;
    });

    // Pluralize label
    const pluralLabel = entries.length === 1 ? label : `${label}s`;
    sections.push(`### ${pluralLabel}\n${lines.join("\n")}`);
  }

  return `## Known context for this repository\n\n${sections.join("\n\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/memory-format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/memory/format.ts packages/core/src/__tests__/memory-format.test.ts
git commit -m "$(cat <<'EOF'
refactor(memory): update format for new type system

- Format knowledge entries with subtype-specific labels
- Add warning type with ⚠ icon and "Critical patterns" header
- Group by type/subtype for clear organization

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update Memory Index Exports

**Files:**
- Modify: `packages/core/src/supervisor/memory/index.ts`

- [ ] **Step 1: Update exports**

```typescript
// packages/core/src/supervisor/memory/index.ts
export type { Embedder } from "./embedder.js";
export { cosineSimilarity, LocalEmbedder } from "./embedder.js";
export type {
  KnowledgeSubtype,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
  MemoryWriteInput,
} from "./entry.js";
export {
  knowledgeSubtypeSchema,
  memoryEntrySchema,
  memoryTypeSchema,
  memoryWriteInputSchema,
} from "./entry.js";
export { formatMemoriesForPrompt } from "./format.js";
export { MemoryStore } from "./store.js";
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/supervisor/memory/index.ts
git commit -m "$(cat <<'EOF'
refactor(memory): export new schema types

- Add KnowledgeSubtype export
- Add knowledgeSubtypeSchema export

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update Orchestrator Memory Loading

**Files:**
- Modify: `packages/core/src/orchestrator.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to existing orchestrator tests or create orchestrator-memory.test.ts
import { describe, expect, it, vi } from "vitest";

describe("loadMemoryContext", () => {
  it("uses semantic search when taskPrompt is provided", async () => {
    // This test validates the new signature
    // Implementation detail: search() is called instead of query()
  });

  it("always includes warning entries regardless of relevance", async () => {
    // Warnings should be appended after semantic search results
  });
});
```

- [ ] **Step 2: Update implementation**

In `packages/core/src/orchestrator.ts`, update `loadMemoryContext`:

```typescript
// Change signature to accept taskPrompt
private loadMemoryContext(repoPath: string, taskPrompt?: string): string | undefined {
  try {
    const store = this.getMemoryStore();

    let memories: MemoryEntry[] = [];

    // Semantic search when task prompt available
    if (taskPrompt) {
      // Primary: semantic search for knowledge
      const knowledgeResults = await store.search(taskPrompt, {
        scope: repoPath,
        types: ["knowledge"],
        limit: 10,
      });
      memories = knowledgeResults;
    } else {
      // Fallback: structured query
      memories = store.query({
        scope: repoPath,
        types: ["knowledge"],
        limit: 25,
        sortBy: "relevance",
      });
    }

    // Always append warnings (no limit, no filtering)
    const warnings = store.query({
      scope: repoPath,
      types: ["warning"],
    });

    const allMemories = [...memories, ...warnings];

    if (allMemories.length === 0) return undefined;
    store.markAccessed(allMemories.map((m) => m.id));
    return formatMemoriesForPrompt(allMemories);
  } catch (err) {
    console.debug(
      `[orchestrator] Failed to load memories: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
```

Also update the call site in `runAgentSession` to pass the prompt:

```typescript
const memoryContext = this.loadMemoryContext(input.repo, input.prompt);
```

Remove the episode write calls (lines ~430-445 and ~574-590):

```typescript
// DELETE these blocks:
// - "Write episode to memory store" in catch block
// - "Write episode to memory store" in runAgentSession
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/orchestrator.ts
git commit -m "$(cat <<'EOF'
feat(memory): implement semantic retrieval for agent context

- Change loadMemoryContext to accept taskPrompt parameter
- Use semantic search for knowledge when prompt available
- Always append warnings regardless of relevance
- Remove episode write calls (type deleted)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update Agent Reporting Instructions

**Files:**
- Modify: `packages/core/src/orchestrator/prompt-builder.ts`

- [ ] **Step 1: Update buildReportingInstructions**

```typescript
// packages/core/src/orchestrator/prompt-builder.ts

export function buildReportingInstructions(runId: string, agentName?: string): string {
  const baseInstructions = `## Reporting & Memory

You have two tools to communicate what you learn and do: \`neo log\` (real-time visibility) and \`neo memory\` (persistent knowledge for future agents). Use both deliberately throughout your work.

### Progress reporting — \`neo log\`

Chain \`neo log\` with the command that triggered the event — never call it standalone.

<log-types>
| Type | When to use | Example |
|------|------------|---------|
| \`milestone\` | A meaningful goal is achieved (tests pass, build succeeds, feature complete) | \`neo log milestone "auth middleware passing all tests"\` |
| \`action\` | You performed a significant action (push, PR, deploy) | \`neo log action "pushed 3 commits to feat/auth"\` |
| \`decision\` | You made a non-obvious choice — record WHY | \`neo log decision "chose JWT over sessions — stateless, simpler for MVP"\` |
| \`blocker\` | Something is preventing progress | \`neo log blocker "CI fails: missing DATABASE_URL in test env"\` |
| \`discovery\` | You found something surprising or important about the codebase | \`neo log discovery "API rate limiter is disabled in dev — tests hit real endpoints"\` |
| \`progress\` | General progress update | \`neo log progress "3/5 endpoints migrated"\` |
</log-types>

<log-rules>
- **Chain with commands**: \`pnpm test && neo log milestone "tests passing" || neo log blocker "tests failing"\`
- **Log decisions with reasoning**: the "why" is more valuable than the "what"
- **Log blockers immediately**: do not continue silently — surface problems so the supervisor can act
- **Log at natural boundaries**: after completing a subtask, before switching context, when hitting an obstacle
</log-rules>

### Memory — \`neo memory\`

Memory is persistent knowledge injected into future agent prompts. Write a memory when you learn something that would change HOW the next agent approaches work on this repo.

<memory-types>
| Type | Subtype | When to write | Example |
|------|---------|--------------|---------|
| \`knowledge\` | \`fact\` | Stable truth that affects workflow decisions | Build quirks, CI config, auth patterns, deployment constraints |
| \`knowledge\` | \`procedure\` | Non-obvious multi-step workflow learned from failure | "Run X before Y otherwise Z breaks" |
| \`warning\` | — | Critical/recurring issue that ALL future agents must know | Security patterns, known pitfalls, things that break silently |
</memory-types>

<memory-decision-tree>
Before writing a memory, apply this test:
1. Can \`cat package.json\`, \`ls\`, or reading the README answer this? → Do NOT memorize.
2. Would knowing this change how you approach the task? → Write a \`knowledge --subtype fact\`.
3. Did you fail before discovering this workflow? → Write a \`knowledge --subtype procedure\`.
4. Is this a critical pattern that must NEVER be filtered out? → Write a \`warning\`.
5. Is this just a detail about what you did (file counts, line numbers, component names)? → Do NOT memorize.
</memory-decision-tree>

<memory-examples type="good">
# Affects workflow — non-obvious build/CI constraints
neo memory write --type knowledge --subtype fact --scope $NEO_REPOSITORY "CI requires pnpm build before push — no auto-rebuild in pipeline"
neo memory write --type knowledge --subtype fact --scope $NEO_REPOSITORY "Biome enforces complexity max 20 — extract helpers for large functions"

# Learned from failure — save the next agent from the same mistake
neo memory write --type knowledge --subtype procedure --scope $NEO_REPOSITORY "Run pnpm db:generate after any schema.prisma change — TypeScript types won't update otherwise"
neo memory write --type knowledge --subtype procedure --scope $NEO_REPOSITORY "E2E tests need STRIPE_TEST_KEY in .env.test — tests hang silently without it"

# Critical patterns — always injected regardless of relevance
neo memory write --type warning --scope $NEO_REPOSITORY "NEVER commit .env files — use .env.example instead"
</memory-examples>

<memory-examples type="bad">
# NEVER write these — trivial or derivable
# "packages/core has 71 files" → derivable from ls
# "Uses React 19" → visible in package.json
# "Main entry is src/index.ts" → visible in package.json
# "Tests use vitest" → visible in config files
</memory-examples>

<when-to-write>
Write memories at these key moments:
- **After resolving a non-obvious issue**: the fix revealed a constraint future agents should know
- **After discovering a build/CI/deploy quirk**: the next agent will hit the same wall without this
- **Before finishing your task**: review what you learned — anything that would save the next agent 10+ minutes?
- **After a failed attempt**: if you tried something that seemed right but failed, document why
</when-to-write>`;

  // Add role-specific instructions
  const roleInstructions = getRoleSpecificInstructions(agentName);

  return roleInstructions ? `${baseInstructions}\n\n${roleInstructions}` : baseInstructions;
}

function getRoleSpecificInstructions(agentName?: string): string | null {
  if (!agentName) return null;

  switch (agentName.toLowerCase()) {
    case "developer":
      return `### Memory requirements for developer agents

**MANDATORY before finishing your task:**
- Write 1-3 knowledge entries for non-obvious things you learned
- If you failed before succeeding, write a \`knowledge --subtype procedure\` explaining what you tried and what worked
- If you discovered a pattern that could break silently, write a \`warning\``;

    case "reviewer":
      return `### Memory requirements for reviewer agents

**MANDATORY after review:**
- If you flagged the same issue category 2+ times in this PR, write a \`warning\` entry
- Warnings are injected into ALL future agents on this repo — use them for recurring patterns`;

    case "scout":
      return `### Memory requirements for scout agents

**Write every notable discovery as a knowledge entry:**
- Use \`knowledge --subtype fact\` for stable truths about the codebase
- If critical (security issue, broken infrastructure), write as \`warning\` instead`;

    case "architect":
      return `### Memory requirements for architect agents

**Write architectural decisions as knowledge entries:**
- Use \`knowledge --subtype fact\` for constraints that affect future agents
- Document WHY not just WHAT — the reasoning helps future decisions`;

    default:
      return null;
  }
}
```

- [ ] **Step 2: Update buildFullPrompt signature**

```typescript
export function buildFullPrompt(
  agentPrompt: string | undefined,
  repoInstructions: string | undefined,
  gitInstructions: string | null,
  taskPrompt: string,
  memoryContext?: string | undefined,
  cwdInstructions?: string | undefined,
  reportingInstructions?: string | undefined,
  agentName?: string | undefined,
): string {
  const sections: string[] = [];

  if (agentPrompt) sections.push(agentPrompt);
  if (cwdInstructions) sections.push(cwdInstructions);
  if (memoryContext) sections.push(memoryContext);
  if (repoInstructions) sections.push(`## Repository instructions\n\n${repoInstructions}`);
  if (gitInstructions) sections.push(gitInstructions);

  // Pass agentName to reporting instructions
  const reporting = reportingInstructions ?? buildReportingInstructions("", agentName);
  sections.push(reporting);

  sections.push(`## Task\n\n${taskPrompt}`);

  return sections.join("\n\n---\n\n");
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/orchestrator/prompt-builder.ts
git commit -m "$(cat <<'EOF'
feat(memory): add role-specific memory write instructions

- Update memory types documentation (knowledge + warning)
- Add subtype flag for knowledge entries
- Add MANDATORY memory requirements per agent role:
  - developer: write learnings before finishing
  - reviewer: write warnings for recurring issues
  - scout: write all discoveries
  - architect: write architectural decisions

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update Supervisor Prompt Builder

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`

- [ ] **Step 1: Update buildMemoryRulesCore**

```typescript
// In packages/core/src/supervisor/prompt-builder.ts

function buildMemoryRulesCore(supervisorDir: string): string {
  const notesDir = `${supervisorDir}/notes`;
  return `### Memory

<memory-types>
| Type | Subtype | Store when | TTL |
|------|---------|-----------|-----|
| \`knowledge\` | \`fact\` | Stable truth affecting dispatch decisions | Permanent (decays) |
| \`knowledge\` | \`procedure\` | Same failure 3+ times | Permanent |
| \`warning\` | — | Critical pattern that must NEVER be filtered | Permanent (always injected) |
| \`focus\` | — | After every dispatch/deferral | --expires required |
</memory-types>

<memory-rules>
- Focus is free-form working memory — rewrite at end of EVERY heartbeat (see <focus>).
- NEVER store: file counts, line numbers, completed work details, data available via \`neo runs <id>\`.
- After PR merge: forget related facts unless they are reusable architectural truths.
- Pattern escalation: same failure 3+ times → write a \`knowledge --subtype procedure\`.
- Critical patterns: if something breaks silently or has security implications → write a \`warning\`.
- Every memory that references external context MUST include a retrieval command.
</memory-rules>

<notes>
Notes directory: \`${notesDir}/\`
Use notes for any initiative with 3+ tasks (persists across heartbeats).
- Write: \`cat > ${notesDir}/plan-<initiative>.md << 'EOF' ... EOF\`
- Delete when initiative is done
</notes>`;
}
```

- [ ] **Step 2: Update buildMemoryRulesExamples**

```typescript
function buildMemoryRulesExamples(supervisorDir: string): string {
  const notesDir = `${supervisorDir}/notes`;
  return `<memory-examples>
neo memory write --type focus --expires 2h "ACTIVE: 5900a64a developer 'T1' branch:feat/x (cat ${notesDir}/plan-YC-2670-kanban.md)"
neo memory write --type knowledge --subtype fact --scope /repo "main branch uses protected merges — agents must create PRs, never push directly"
neo memory write --type knowledge --subtype fact --scope /repo "pnpm build must pass before push — CI does not rebuild, run 2g589f34a5a failed without it"
neo memory write --type knowledge --subtype procedure --scope /repo "After architect run: read plan path from output, dispatch developer with plan per SUPERVISOR.md routing"
neo memory write --type knowledge --subtype procedure --scope /repo "When developer run fails with ENOSPC: the repo has large fixtures — use --branch with shallow clone flag"
neo memory write --type warning --scope /repo "User wants PR descriptions in French even though code is in English"
neo memory forget <id>
</memory-examples>`;
}
```

- [ ] **Step 3: Update buildKnowledgeSection**

```typescript
/**
 * Build the knowledge section: knowledge (with subtype) and warnings.
 * Focus is excluded — it's rendered separately at context top level.
 */
function buildKnowledgeSection(memories: MemoryEntry[]): string {
  const factEntries = memories.filter((m) => m.type === "knowledge" && m.subtype === "fact");
  const procedureEntries = memories.filter((m) => m.type === "knowledge" && m.subtype === "procedure");
  const warningEntries = memories.filter((m) => m.type === "warning");

  const parts: string[] = [];

  // Known facts — grouped by scope with staleness signal
  if (factEntries.length > 0) {
    const byScope = new Map<string, MemoryEntry[]>();
    for (const m of factEntries) {
      const scope = m.scope === "global" ? "global" : (m.scope.split("/").pop() ?? m.scope);
      const group = byScope.get(scope) ?? [];
      group.push(m);
      byScope.set(scope, group);
    }

    const scopeSections: string[] = [];
    for (const [scope, entries] of byScope) {
      const oldestAccess = Math.min(
        ...entries.map((m) => Date.now() - new Date(m.lastAccessedAt).getTime()),
      );
      const daysAgo = Math.floor(oldestAccess / 86_400_000);
      const staleHint = daysAgo >= 5 ? ` (last accessed ${daysAgo}d ago)` : "";
      const lines = entries
        .map((m) => {
          const confidence = m.accessCount >= 3 ? "" : " (unconfirmed)";
          return `  - ${m.content}${confidence}`;
        })
        .join("\n");
      scopeSections.push(`  [${scope}]${staleHint} (${entries.length})\n${lines}`);
    }
    parts.push(`Known facts:\n${scopeSections.join("\n")}`);
  }

  // Procedures
  if (procedureEntries.length > 0) {
    const lines = procedureEntries.map((m) => `→ ${m.content}`).join("\n");
    parts.push(`How-tos:\n${lines}`);
  }

  // Warnings (always shown, critical patterns)
  if (warningEntries.length > 0) {
    const lines = warningEntries
      .map((m) => `⚠ [${m.category ?? "general"}] ${m.content}`)
      .join("\n");
    parts.push(`## ⚠ Critical patterns\n${lines}`);
  }

  return parts.join("\n\n");
}
```

- [ ] **Step 4: Update buildWorkQueueSection to use TaskEntry**

This requires importing TaskEntry from TaskStore and updating the function signature. However, for backward compatibility during migration, we'll keep the MemoryEntry signature and filter appropriately.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/prompt-builder.ts
git commit -m "$(cat <<'EOF'
refactor(supervisor): update prompt builder for new memory types

- Update memory type documentation (knowledge + warning)
- Update examples to use --subtype flag
- Update buildKnowledgeSection for new types
- Add warning section with ⚠ Critical patterns header

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update Heartbeat Memory Loading

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Update gatherEventContext**

```typescript
// In gatherEventContext method:

private async gatherEventContext(): Promise<EventContext> {
  const { grouped, rawEvents } = this.eventQueue.drainAndGroup();
  const totalEventCount =
    grouped.messages.length + grouped.webhooks.length + grouped.runCompletions.length;
  const activeRuns = await this.getActiveRuns();

  const mcpServerNames = this.config.mcpServers ? Object.keys(this.config.mcpServers) : [];
  const store = this.getMemoryStore();

  // Load knowledge and warning types (no task prompt available at supervisor level)
  const memories: MemoryEntry[] = store
    ? store.query({
        types: ["knowledge", "warning", "focus"],
        limit: 40,
        sortBy: "relevance"
      })
    : [];

  const recentActions = await this.activityLog.tail(20);

  return {
    grouped,
    rawEvents,
    totalEventCount,
    activeRuns,
    memories,
    recentActions,
    mcpServerNames,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "$(cat <<'EOF'
refactor(heartbeat): update memory loading for new types

- Query knowledge, warning, and focus types
- Remove task type (now in TaskStore)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update CLI Memory Command

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Update VALID_TYPES and add subtype**

```typescript
// packages/cli/src/commands/memory.ts

const VALID_TYPES = ["knowledge", "warning", "focus"] as const;
const VALID_SUBTYPES = ["fact", "procedure"] as const;

interface ParsedArgs {
  value: string | undefined;
  type: string | undefined;
  subtype: string | undefined; // Add subtype
  scope: string;
  source: string;
  expires: string | undefined;
  name: string;
  outcome: string | undefined;
  severity: string | undefined;
  category: string | undefined;
  tags: string | undefined;
}
```

- [ ] **Step 2: Update handleWrite**

```typescript
async function handleWrite(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo memory write <content> --type <type> [--subtype <subtype>] [--scope <scope>]");
    process.exitCode = 1;
    return;
  }

  const type = args.type ?? "knowledge";
  if (!VALID_TYPES.includes(type as MemoryType)) {
    printError(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Validate subtype for knowledge type
  if (type === "knowledge" && args.subtype) {
    if (!VALID_SUBTYPES.includes(args.subtype as (typeof VALID_SUBTYPES)[number])) {
      printError(`Invalid subtype "${args.subtype}". Must be one of: ${VALID_SUBTYPES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  let expiresAt: string | undefined;
  if (args.expires) {
    expiresAt = parseDuration(args.expires);
    if (!expiresAt) {
      printError('Invalid --expires format. Use e.g. "2h" or "30m".');
      process.exitCode = 1;
      return;
    }
  }

  const store = openStore(args.name, true);
  try {
    const tags = args.tags ? args.tags.split(",").map((t) => t.trim()) : [];
    const id = await store.write({
      type: type as MemoryType,
      scope: args.scope,
      content: args.value,
      source: args.source,
      tags,
      expiresAt,
      severity: args.severity,
      category: args.category,
      outcome: args.outcome,
      subtype: args.subtype, // Add subtype
    });
    printSuccess(`Memory written: ${id}`);
  } finally {
    store.close();
  }
}
```

- [ ] **Step 3: Add subtype argument**

```typescript
export default defineCommand({
  meta: {
    name: "memory",
    description: "Manage the supervisor memory store",
  },
  args: {
    // ... existing args ...
    subtype: {
      type: "string",
      description: "Knowledge subtype: fact, procedure (only for --type knowledge)",
    },
    // ... rest of args ...
  },
  // ...
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/memory.ts
git commit -m "$(cat <<'EOF'
feat(cli): update memory command for new type system

- Change VALID_TYPES to: knowledge, warning, focus
- Add --subtype flag for knowledge entries (fact | procedure)
- Validate subtype when type is knowledge
- Update help text and examples

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Update Tests for New Types

**Files:**
- Modify: `packages/core/src/__tests__/memory-store.test.ts`
- Modify: `packages/core/src/__tests__/prompt-builder.test.ts`

- [ ] **Step 1: Update memory-store.test.ts**

Replace old type references with new types. Update tests that use `fact`, `procedure`, `feedback`, `task`, `episode` to use `knowledge`, `warning`, `focus`.

Key changes:
- Replace `type: "fact"` with `type: "knowledge", subtype: "fact"`
- Replace `type: "procedure"` with `type: "knowledge", subtype: "procedure"`
- Replace `type: "feedback"` with `type: "warning"`
- Remove `type: "episode"` tests
- Remove `type: "task"` tests (moved to task-store.test.ts)

- [ ] **Step 2: Update prompt-builder.test.ts**

Update `makeMemory` helper and tests to use new types:

```typescript
function makeMemory(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    type: "knowledge",
    scope: "global",
    content: "test memory",
    source: "user",
    tags: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    subtype: "fact", // Add default subtype
    ...overrides,
  };
}
```

Update test cases:
- Change `type: "fact"` to `type: "knowledge", subtype: "fact"`
- Change `type: "procedure"` to `type: "knowledge", subtype: "procedure"`
- Change `type: "feedback"` to `type: "warning"`

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/memory-store.test.ts packages/core/src/__tests__/prompt-builder.test.ts
git commit -m "$(cat <<'EOF'
test(memory): update tests for new type system

- Update memory-store.test.ts for knowledge/warning/focus types
- Update prompt-builder.test.ts for new type structure
- Add subtype field to test fixtures

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Final Validation

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: All tests pass

- [ ] **Step 2: Verify no references to old types**

```bash
# Should return no results in source files
grep -r "type.*episode\|type.*feedback\|supersedes" packages/core/src packages/cli/src --include="*.ts" | grep -v test | grep -v ".d.ts"
```

- [ ] **Step 3: Commit final cleanup**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(memory): final cleanup and validation

- Verify all tests pass
- Confirm no references to deprecated types remain
- Ready for review

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Risk Assessment

### Migration Risks

1. **Data Loss**: Existing memories with old types will be migrated. Episode entries are deleted (write-only, never read). Task entries are migrated to TaskStore.
   - **Mitigation**: Migration runs in a transaction, rollback on failure.

2. **Schema Mismatch**: SQLite CHECK constraints must be updated.
   - **Mitigation**: Table recreation pattern (rename, create, copy, drop).

3. **API Breaking Change**: CLI `--type` values change.
   - **Mitigation**: Clear error messages for invalid types.

### Dependency Order

```
Task 1 (entry.ts)
    ↓
Task 2 (task-store.ts) ← independent
    ↓
Task 3 (store.ts) ← depends on entry.ts, task-store.ts
    ↓
Task 4 (format.ts) ← depends on entry.ts
    ↓
Task 5 (index.ts) ← depends on all memory files
    ↓
Task 6 (orchestrator.ts) ← depends on store.ts
Task 7 (orchestrator/prompt-builder.ts) ← independent
Task 8 (supervisor/prompt-builder.ts) ← depends on entry.ts
Task 9 (heartbeat.ts) ← depends on store.ts
Task 10 (cli/memory.ts) ← depends on entry.ts
    ↓
Task 11 (tests) ← depends on all source changes
    ↓
Task 12 (validation)
```

### Files Affected Summary

| File | Action | Risk |
|------|--------|------|
| `entry.ts` | Modify | Low — schema change |
| `store.ts` | Modify | Medium — migration logic |
| `format.ts` | Modify | Low — display only |
| `index.ts` | Modify | Low — exports only |
| `task-store.ts` | Create | Low — new file |
| `orchestrator.ts` | Modify | Medium — removes episode writes |
| `orchestrator/prompt-builder.ts` | Modify | Low — add role instructions |
| `supervisor/prompt-builder.ts` | Modify | Medium — multiple sections |
| `heartbeat.ts` | Modify | Low — query change |
| `cli/memory.ts` | Modify | Low — CLI only |
| Tests | Modify | Low — test updates |

---

## Acceptance Criteria Checklist

- [ ] `pnpm build && pnpm typecheck && pnpm test` passes
- [ ] Existing memory entries are migrated correctly (no data loss)
- [ ] `neo memory write --type knowledge --subtype fact` works
- [ ] `neo memory write --type warning` works
- [ ] `neo memory list --type knowledge` shows all knowledge entries
- [ ] Semantic search is used when task prompt is available
- [ ] TaskStore is separate from MemoryStore
- [ ] No references to supersedes, episode, feedback types remain
