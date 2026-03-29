import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LogBufferEntry } from "./schemas.js";

const LOG_BUFFER_FILE = "log-buffer.jsonl";
const MAX_FILE_BYTES = 1024 * 1024; // 1MB cap
const COMPACTION_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES_PER_RUN = 5;
const MAX_DIGEST_ENTRIES = 30;

// ─── Module-level write lock ─────────────────────────────
// Keyed by directory path to allow concurrent operations on different buffers

const writeLocks = new Map<string, Promise<void>>();

/**
 * Acquire the write lock for a directory and execute a callback.
 * Serializes write operations per-directory to prevent race conditions.
 */
async function withWriteLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto the existing lock for this directory
  const release = writeLocks.get(dir) ?? Promise.resolve();
  let releaseLock: () => void = () => {};
  const newLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  writeLocks.set(dir, newLock);

  try {
    // Wait for previous operation to complete
    await release;
    return await fn();
  } finally {
    // Release the lock for the next operation
    releaseLock();
    // Clean up if this was the last lock in the chain
    if (writeLocks.get(dir) === newLock) {
      writeLocks.delete(dir);
    }
  }
}

// ─── Type markers for digest formatting ─────────────────

const TYPE_MARKERS: Record<string, string> = {
  milestone: "★",
  decision: "◆",
  blocker: "⚠",
  progress: "·",
  action: "→",
  discovery: "◇",
};

// ─── Core read/write ────────────────────────────────────

function bufferPath(dir: string): string {
  return path.join(dir, LOG_BUFFER_FILE);
}

function parseLines(content: string): LogBufferEntry[] {
  const entries: LogBufferEntry[] = [];
  const lines = content.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LogBufferEntry);
    } catch (err) {
      // Skip malformed JSONL line
      console.debug(
        `[log-buffer] Skipping malformed line: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return entries;
}

/**
 * Read all entries from log-buffer.jsonl.
 */
export async function readLogBuffer(dir: string): Promise<LogBufferEntry[]> {
  try {
    const content = await readFile(bufferPath(dir), "utf-8");
    return parseLines(content);
  } catch (err) {
    // Buffer file not found or unreadable
    console.debug(
      `[log-buffer] Failed to read buffer: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Read entries with timestamp > since.
 */
export async function readLogBufferSince(dir: string, since: string): Promise<LogBufferEntry[]> {
  const entries = await readLogBuffer(dir);
  return entries.filter((e) => e.timestamp > since);
}

/**
 * Read entries where consolidatedAt is null/undefined.
 */
export async function readUnconsolidated(dir: string): Promise<LogBufferEntry[]> {
  const entries = await readLogBuffer(dir);
  return entries.filter((e) => !e.consolidatedAt);
}

/**
 * Set consolidatedAt on entries by id.
 * Rewrites the file with updated entries.
 * Uses a mutex to serialize concurrent calls and prevent race conditions.
 */
export async function markConsolidated(dir: string, ids: string[]): Promise<void> {
  return withWriteLock(dir, async () => {
    const filePath = bufferPath(dir);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      // Buffer file not found — nothing to mark
      console.debug(
        `[log-buffer] Failed to read for consolidation: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const idSet = new Set(ids);
    const now = new Date().toISOString();
    const lines = content.trim().split("\n").filter(Boolean);
    const updated: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogBufferEntry;
        if (idSet.has(entry.id) && !entry.consolidatedAt) {
          entry.consolidatedAt = now;
        }
        updated.push(JSON.stringify(entry));
      } catch (err) {
        // Preserve malformed lines as-is during consolidation
        console.debug(
          `[log-buffer] Preserving malformed line during consolidation: ${err instanceof Error ? err.message : String(err)}`,
        );
        updated.push(line);
      }
    }

    // Write atomically: temp file then rename to prevent data loss
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${updated.join("\n")}\n`, "utf-8");
    await rename(tempPath, filePath);
  });
}

/**
 * Remove entries with consolidatedAt older than 24h. Cap file at 1MB.
 * Uses a mutex to serialize concurrent calls and prevent race conditions.
 */
export async function compactLogBuffer(dir: string): Promise<void> {
  return withWriteLock(dir, async () => {
    const filePath = bufferPath(dir);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      // Buffer file not found — nothing to compact
      console.debug(
        `[log-buffer] Failed to read for compaction: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const now = Date.now();
    const lines = content.trim().split("\n").filter(Boolean);
    const kept: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogBufferEntry;
        if (entry.consolidatedAt) {
          const consolidatedTime = new Date(entry.consolidatedAt).getTime();
          if (now - consolidatedTime > COMPACTION_AGE_MS) {
            continue; // Drop old consolidated entries
          }
        }
        kept.push(JSON.stringify(entry));
      } catch (err) {
        // Drop malformed lines during compaction
        console.debug(
          `[log-buffer] Dropping malformed line during compaction: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Cap at 1MB — drop oldest entries first
    let result = `${kept.join("\n")}\n`;
    while (Buffer.byteLength(result, "utf-8") > MAX_FILE_BYTES && kept.length > 0) {
      kept.shift();
      result = `${kept.join("\n")}\n`;
    }

    // Write atomically: temp file then rename to prevent data loss
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, result, "utf-8");
    await rename(tempPath, filePath);
  });
}

// ─── Digest helpers ──────────────────────────────────────

function groupEntriesByRunId(entries: LogBufferEntry[]): Map<string, LogBufferEntry[]> {
  const groups = new Map<string, LogBufferEntry[]>();
  for (const entry of entries) {
    const key = entry.runId ?? "unassigned";
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  return groups;
}

function dedupeAdjacentEntries(entries: LogBufferEntry[]): LogBufferEntry[] {
  const deduped: LogBufferEntry[] = [];
  for (const entry of entries) {
    const last = deduped[deduped.length - 1];
    if (last && last.message === entry.message) continue;
    deduped.push(entry);
  }
  return deduped;
}

/**
 * Build a human-readable digest from log buffer entries.
 * Groups by runId, sorts chronologically, adds type markers,
 * deduplicates adjacent identical messages, truncates output.
 */
export function buildAgentDigest(entries: LogBufferEntry[]): string {
  if (entries.length === 0) return "";

  const groups = groupEntriesByRunId(entries);
  const lines: string[] = [];
  let totalCount = 0;

  for (const [runId, group] of groups) {
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const deduped = dedupeAdjacentEntries(group);
    const limited = deduped.slice(0, MAX_ENTRIES_PER_RUN);

    const agentLabel = limited[0]?.agent ?? "unknown";
    lines.push(`[${runId}] (${agentLabel}):`);

    for (const entry of limited) {
      if (totalCount >= MAX_DIGEST_ENTRIES) break;
      const marker = TYPE_MARKERS[entry.type] ?? "·";
      lines.push(`  ${marker} ${entry.message}`);
      totalCount++;
    }

    if (totalCount >= MAX_DIGEST_ENTRIES) {
      lines.push("  ... (truncated)");
      break;
    }
  }

  return lines.join("\n");
}

/**
 * Append a single entry to the log buffer file.
 * Uses a mutex to serialize concurrent calls and prevent race conditions.
 */
export async function appendLogBuffer(dir: string, entry: LogBufferEntry): Promise<void> {
  return withWriteLock(dir, async () => {
    try {
      // Ensure directory exists (appendFile will create the file but not the dir)
      await appendFile(bufferPath(dir), `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (err) {
      // Best-effort — don't crash the CLI if buffer write fails
      console.debug(
        `[log-buffer] Failed to append entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Get file size of the log buffer (for monitoring).
 */
export async function getLogBufferSize(dir: string): Promise<number> {
  try {
    const stats = await stat(bufferPath(dir));
    return stats.size;
  } catch (err) {
    // Buffer file not found or inaccessible
    console.debug(
      `[log-buffer] Failed to get buffer size: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
