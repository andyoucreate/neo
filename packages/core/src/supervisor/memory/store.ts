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

    // better-sqlite3 is synchronous — import at module level would break ESM lazy loading
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('fact','procedure','episode','focus','feedback','task')),
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
        supersedes TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mem_type_scope ON memories(type, scope);
      CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);
    `);

    // Migrate CHECK constraint if table predates 'task' type
    this.migrateCheckConstraint();

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

    // sqlite-vec for vector search (optional — may not be installed)
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
        // sqlite-vec not available — fall back to FTS
        this.hasVec = false;
      }
    }
  }

  /**
   * Migrate existing tables whose CHECK constraint predates the 'task' type.
   * SQLite doesn't allow ALTER CHECK, so we recreate the table if needed.
   */
  private migrateCheckConstraint(): void {
    const tableInfo = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() as { sql: string } | undefined;
    if (!tableInfo || tableInfo.sql.includes("'task'")) return;

    this.db.exec(`
      ALTER TABLE memories RENAME TO memories_old;

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('fact','procedure','episode','focus','feedback','task')),
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
        supersedes TEXT
      );

      INSERT INTO memories SELECT * FROM memories_old;
      DROP TABLE memories_old;
    `);
  }

  // ─── Write ───────────────────────────────────────────

  async write(input: MemoryWriteInput): Promise<string> {
    const id = `mem_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memories (id, type, scope, content, source, tags, created_at, last_accessed_at, access_count, expires_at, outcome, run_id, category, severity, supersedes)
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
        input.supersedes ?? null,
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

    // Re-embedding happens lazily on next search if needed
    // For now, remove stale vector
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy: string;
    switch (opts.sortBy) {
      case "accessCount":
        orderBy = "ORDER BY access_count DESC";
        break;
      case "createdAt":
        orderBy = "ORDER BY created_at DESC";
        break;
      case "relevance":
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

        // Build scope/type filter for post-filtering
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

        // Post-filter by scope and type
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
      // FTS query syntax error — fall back to LIKE
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
    // Delete stale low-access memories
    const staleResult = this.db
      .prepare(
        `DELETE FROM memories
       WHERE access_count < ?
         AND julianday('now') - julianday(last_accessed_at) > ?
         AND type NOT IN ('focus', 'task')`,
      )
      .run(minAccessCount, maxAgeDays);

    // Delete completed tasks older than 7 days
    const taskResult = this.db
      .prepare(
        `DELETE FROM memories
       WHERE type = 'task'
         AND outcome = 'done'
         AND julianday('now') - julianday(last_accessed_at) > 7`,
      )
      .run();

    return staleResult.changes + taskResult.changes;
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
  supersedes: string | null;
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
    supersedes: row.supersedes ?? undefined,
  };
}
