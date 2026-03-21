import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, rename, stat, unlink } from "node:fs/promises";
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

async function parseLines(filePath: string): Promise<LogBufferEntry[]> {
  const entries: LogBufferEntry[] = [];
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogBufferEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Read all entries from log-buffer.jsonl.
 */
export async function readLogBuffer(dir: string): Promise<LogBufferEntry[]> {
  try {
    return await parseLines(bufferPath(dir));
  } catch {
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
 */
export async function markConsolidated(dir: string, ids: string[]): Promise<void> {
  const filePath = bufferPath(dir);
  const tempPath = `${filePath}.tmp`;
  const idSet = new Set(ids);
  const now = new Date().toISOString();

  try {
    const readStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: readStream, crlfDelay: Number.POSITIVE_INFINITY });
    const writeStream = createWriteStream(tempPath, { encoding: "utf-8" });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let outputLine = line;
        try {
          const entry = JSON.parse(line) as LogBufferEntry;
          if (idSet.has(entry.id) && !entry.consolidatedAt) {
            entry.consolidatedAt = now;
          }
          outputLine = JSON.stringify(entry);
        } catch {
          // Keep original line if parsing fails
        }
        writeStream.write(`${outputLine}\n`);
      }
    } finally {
      rl.close();
      writeStream.end();
    }

    // Wait for write stream to finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Replace original file with updated temp file
    await rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    // If the error is ENOENT (file doesn't exist), silently return
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Filter entries: keep unconsolidated entries and recently consolidated ones (within 24h).
 */
function shouldKeepEntry(entry: LogBufferEntry, now: number): boolean {
  if (!entry.consolidatedAt) return true;
  const consolidatedTime = new Date(entry.consolidatedAt).getTime();
  return now - consolidatedTime <= COMPACTION_AGE_MS;
}

/**
 * Calculate which entries to keep based on size limit (1MB cap).
 * Returns the start index — entries from startIndex to end should be kept.
 */
function calculateSizeLimitedRange(
  entries: Array<{ line: string; size: number }>,
  maxBytes: number,
): number {
  let cumulativeSize = 0;
  let startIndex = entries.length;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    const potentialSize = cumulativeSize + entry.size;
    if (potentialSize > maxBytes) break;
    cumulativeSize = potentialSize;
    startIndex = i;
  }

  return startIndex;
}

/**
 * Remove entries with consolidatedAt older than 24h. Cap file at 1MB.
 */
export async function compactLogBuffer(dir: string): Promise<void> {
  const filePath = bufferPath(dir);
  const tempPath = `${filePath}.tmp`;
  const now = Date.now();

  try {
    const readStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: readStream, crlfDelay: Number.POSITIVE_INFINITY });
    const writeStream = createWriteStream(tempPath, { encoding: "utf-8" });

    // First pass: collect valid entries with their size
    const validEntries: Array<{ line: string; size: number }> = [];

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as LogBufferEntry;
          if (!shouldKeepEntry(entry, now)) continue;
          const serialized = JSON.stringify(entry);
          const lineSize = Buffer.byteLength(serialized, "utf-8") + 1; // +1 for newline
          validEntries.push({ line: serialized, size: lineSize });
        } catch {
          // Drop malformed lines during compaction
        }
      }
    } finally {
      rl.close();
    }

    // Calculate which entries to keep based on size limit
    const startIndex = calculateSizeLimitedRange(validEntries, MAX_FILE_BYTES);

    // Write kept entries
    for (let i = startIndex; i < validEntries.length; i++) {
      const entry = validEntries[i];
      if (!entry) continue;
      writeStream.write(`${entry.line}\n`);
    }

    writeStream.end();

    // Wait for write stream to finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Replace original file with compacted temp file
    await rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    // If the error is ENOENT (file doesn't exist), silently return
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // Re-throw other errors
    throw error;
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
