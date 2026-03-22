import { createReadStream } from "node:fs";
import { appendFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { LogBufferEntry } from "./schemas.js";

const LOG_BUFFER_FILE = "log-buffer.jsonl";
const MAX_FILE_BYTES = 1024 * 1024; // 1MB cap
const COMPACTION_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES_PER_RUN = 5;
const MAX_DIGEST_ENTRIES = 30;

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

/**
 * Read all entries from log-buffer.jsonl using streaming.
 */
export async function readLogBuffer(dir: string): Promise<LogBufferEntry[]> {
  const entries: LogBufferEntry[] = [];
  try {
    const fileStream = createReadStream(bufferPath(dir), { encoding: "utf-8" });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LogBufferEntry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return [];
  }
  return entries;
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
 */
export async function markConsolidated(dir: string, ids: string[]): Promise<void> {
  const filePath = bufferPath(dir);
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  const updated: string[] = [];

  try {
    const fileStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogBufferEntry;
        if (idSet.has(entry.id) && !entry.consolidatedAt) {
          entry.consolidatedAt = now;
        }
        updated.push(JSON.stringify(entry));
      } catch {
        updated.push(line);
      }
    }

    await writeFile(filePath, `${updated.join("\n")}\n`, "utf-8");
  } catch {
    return;
  }
}

/**
 * Remove entries with consolidatedAt older than 24h. Cap file at 1MB.
 */
export async function compactLogBuffer(dir: string): Promise<void> {
  const filePath = bufferPath(dir);
  const now = Date.now();
  const kept: string[] = [];

  try {
    const fileStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogBufferEntry;
        if (entry.consolidatedAt) {
          const consolidatedTime = new Date(entry.consolidatedAt).getTime();
          if (now - consolidatedTime > COMPACTION_AGE_MS) {
            continue; // Drop old consolidated entries
          }
        }
        kept.push(JSON.stringify(entry));
      } catch {
        // Drop malformed lines during compaction
      }
    }

    // Cap at 1MB — drop oldest entries first
    let result = `${kept.join("\n")}\n`;
    while (Buffer.byteLength(result, "utf-8") > MAX_FILE_BYTES && kept.length > 0) {
      kept.shift();
      result = `${kept.join("\n")}\n`;
    }

    await writeFile(filePath, result, "utf-8");
  } catch {
    return;
  }
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
 */
export async function appendLogBuffer(dir: string, entry: LogBufferEntry): Promise<void> {
  try {
    // Ensure directory exists (appendFile will create the file but not the dir)
    await appendFile(bufferPath(dir), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Best-effort — don't crash the CLI if buffer write fails
  }
}

/**
 * Get file size of the log buffer (for monitoring).
 */
export async function getLogBufferSize(dir: string): Promise<number> {
  try {
    const stats = await stat(bufferPath(dir));
    return stats.size;
  } catch {
    return 0;
  }
}
