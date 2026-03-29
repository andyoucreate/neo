import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryWriteInput,
  SearchResult,
} from "./entry.js";

const esmRequire = createRequire(import.meta.url);

// ─── MemoryStore ─────────────────────────────────────────
// Vector search removed (ADR-cleanup). FTS5 is sufficient.

export class MemoryStore {
  private db: import("better-sqlite3").Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // better-sqlite3 is synchronous — import at module level would break ESM lazy loading
    const Database = esmRequire("better-sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // CRITICAL: Run migration BEFORE initSchema to handle existing DBs with old constraints
    // The migration will detect old schema and recreate table with new constraints
    this.migrateSchemaIfNeeded();
    this.initSchema();
  }

  // ─── Schema initialization ───────────────────────────

  private initSchema(): void {
    // Create table with new type constraint (only runs for fresh DBs)
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
  }

  /**
   * Migrate from old schema to new schema (called BEFORE initSchema):
   * - fact, procedure → knowledge (with subtype)
   * - feedback → warning
   * - episode → delete
   * - task → migrated by TaskStore (deleted here)
   * - Add subtype column if missing
   *
   * CRITICAL: This must run BEFORE initSchema() because existing DBs have
   * CHECK constraints that reject new type values. We must:
   * 1. Detect old schema
   * 2. Rename old table, create new table with new constraints
   * 3. INSERT with transformation (can't UPDATE due to old CHECK constraint)
   * 4. Drop old table
   */
  private migrateSchemaIfNeeded(): void {
    // Check if memories table exists
    const tableInfo = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() as { sql: string } | undefined;

    // No table yet — nothing to migrate, initSchema will create it fresh
    if (!tableInfo) return;

    // Check if old types exist in the CHECK constraint
    // This detects DBs created with old schema that need migration
    const hasOldTypesInConstraint =
      tableInfo.sql.includes("CHECK") &&
      (tableInfo.sql.includes("'fact'") ||
        tableInfo.sql.includes("'procedure'") ||
        tableInfo.sql.includes("'feedback'") ||
        tableInfo.sql.includes("'episode'") ||
        tableInfo.sql.includes("'task'"));

    // Also check for schema without CHECK constraint (comment-based detection for tests)
    const hasOldTypesInComment =
      !tableInfo.sql.includes("CHECK") &&
      (tableInfo.sql.includes("'fact'") || tableInfo.sql.includes("'procedure'"));

    const needsMigration = hasOldTypesInConstraint || hasOldTypesInComment;

    // No old types in schema — no migration needed
    if (!needsMigration) return;

    // Check if subtype column exists in old schema
    const hasSubtype = tableInfo.sql.includes("subtype");

    // Migrate in a transaction
    // CRITICAL: We cannot UPDATE old rows because CHECK constraint blocks new values.
    // Instead: rename → create new → INSERT with CASE transformation → drop old
    this.db.exec("BEGIN TRANSACTION");
    try {
      // Step 1: Rename old table
      this.db.exec("ALTER TABLE memories RENAME TO memories_migration_old");

      // Step 2: Create new table with new CHECK constraint
      this.db.exec(`
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
      `);

      // Step 3: INSERT with transformation using CASE expressions
      // This bypasses the old CHECK constraint since we're reading from old table
      // and inserting into new table with transformed values
      if (hasSubtype) {
        // Old schema had subtype column
        this.db.exec(`
          INSERT INTO memories (
            id, type, scope, content, source, tags, created_at, last_accessed_at,
            access_count, expires_at, outcome, run_id, category, severity, subtype
          )
          SELECT
            id,
            CASE
              WHEN type IN ('fact', 'procedure') THEN 'knowledge'
              WHEN type = 'feedback' THEN 'warning'
              ELSE type
            END as type,
            scope, content, source, tags, created_at, last_accessed_at,
            access_count, expires_at, outcome, run_id, category, severity,
            CASE
              WHEN type = 'fact' THEN 'fact'
              WHEN type = 'procedure' THEN 'procedure'
              WHEN type = 'knowledge' AND subtype IS NULL THEN 'fact'
              ELSE subtype
            END as subtype
          FROM memories_migration_old
          WHERE type NOT IN ('episode', 'task');
        `);
      } else {
        // Old schema didn't have subtype column — need to handle missing column
        this.db.exec(`
          INSERT INTO memories (
            id, type, scope, content, source, tags, created_at, last_accessed_at,
            access_count, expires_at, outcome, run_id, category, severity, subtype
          )
          SELECT
            id,
            CASE
              WHEN type IN ('fact', 'procedure') THEN 'knowledge'
              WHEN type = 'feedback' THEN 'warning'
              ELSE type
            END as type,
            scope, content, source, tags, created_at, last_accessed_at,
            access_count, expires_at, outcome, run_id, category, severity,
            CASE
              WHEN type = 'fact' THEN 'fact'
              WHEN type = 'procedure' THEN 'procedure'
              ELSE 'fact'
            END as subtype
          FROM memories_migration_old
          WHERE type NOT IN ('episode', 'task');
        `);
      }

      // Step 4: Drop old table
      this.db.exec("DROP TABLE memories_migration_old");

      this.db.exec("COMMIT");
    } catch (err) {
      // Attempt rollback — may fail if transaction already aborted
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failed — transaction may already be aborted
      }

      // Try to recover by renaming back if the old table still exists
      try {
        const oldExists = this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_migration_old'",
          )
          .get();
        if (oldExists) {
          // New table might exist partially — try to drop it
          try {
            this.db.exec("DROP TABLE IF EXISTS memories");
          } catch {
            // Ignore
          }
          this.db.exec("ALTER TABLE memories_migration_old RENAME TO memories");
        }
      } catch {
        // Recovery failed too — database may be inconsistent
      }

      // Log the error with context so users know migration failed
      // biome-ignore lint/suspicious/noConsole: Intentional error logging for migration failures
      console.error(
        "[neo] Memory schema migration failed. The database may be in an inconsistent state.",
        "\n  Error:",
        err instanceof Error ? err.message : err,
        "\n  Action: Neo will continue but some memories may not be accessible.",
        "\n  To fix: Back up and delete ~/.neo/memory.sqlite, or manually inspect the schema.",
      );
      // Do NOT re-throw — neo should continue working with graceful degradation
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

    return id;
  }

  // ─── Update ──────────────────────────────────────────

  update(id: string, content: string): void {
    this.db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(content, id);
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
      const tagConditions = opts.tags.map(
        () => "EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)",
      );
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

  // ─── Search (FTS5 full-text search) ────────────────

  async search(text: string, opts: MemoryQuery = {}): Promise<SearchResult[]> {
    // FTS5 full-text search
    const limit = opts.limit ?? 20;
    const ftsQuery = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(" OR ");

    if (!ftsQuery) {
      return this.query(opts).map((e) => ({ ...e, score: 0 }));
    }

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
        .all(ftsQuery, limit) as (RawMemoryRow & { rank: number })[];

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

      if (filtered.length === 0) {
        return [];
      }

      // Normalize FTS rank to 0-1 score
      // FTS5 rank is negative, lower (more negative) is better match
      // We invert and normalize: best match gets score close to 1
      const ranks = filtered.map((r) => r.rank);
      const minRank = Math.min(...ranks);
      const maxRank = Math.max(...ranks);

      return filtered.map((row) => {
        let score: number;
        if (minRank === maxRank) {
          // All same rank, give them equal high score
          score = 0.8;
        } else {
          // Normalize: minRank (best) -> 1, maxRank (worst) -> 0
          score = 1 - (row.rank - minRank) / (maxRank - minRank);
        }
        return {
          ...rowToEntry(row),
          score: Math.max(0, Math.min(1, score)),
        };
      });
    } catch {
      // FTS query syntax error — fall back to LIKE
      return this.query(opts).map((e) => ({ ...e, score: 0 }));
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

  /**
   * Get the top N most-accessed memories.
   */
  topAccessed(limit = 5): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
       ORDER BY access_count DESC
       LIMIT ?`,
      )
      .all(limit) as RawMemoryRow[];

    return rows.map(rowToEntry);
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
