import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";

const esmRequire = createRequire(import.meta.url);

// ─── Task schemas ────────────────────────────────────────

export const taskStatusSchema = z.enum(["pending", "in_progress", "done", "blocked", "abandoned"]);

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
    } catch (err) {
      // Migration failed — memories table may not have task type yet
      // biome-ignore lint/suspicious/noConsole: Log migration failures for debugging
      console.debug("[neo] Task migration from memories table failed:", err);
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
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | RawTaskRow
      | undefined;
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
