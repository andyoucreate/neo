import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupervisorMemory } from "./memory.js";
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

function parseLines(content: string): LogBufferEntry[] {
  const entries: LogBufferEntry[] = [];
  const lines = content.trim().split("\n").filter(Boolean);
  for (const line of lines) {
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
    const content = await readFile(bufferPath(dir), "utf-8");
    return parseLines(content);
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
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
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
    } catch {
      updated.push(line);
    }
  }

  await writeFile(filePath, `${updated.join("\n")}\n`, "utf-8");
}

/**
 * Remove entries with consolidatedAt older than 24h. Cap file at 1MB.
 */
export async function compactLogBuffer(dir: string): Promise<void> {
  const filePath = bufferPath(dir);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
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
}

/**
 * Build a human-readable digest from log buffer entries.
 * Groups by runId, sorts chronologically, adds type markers,
 * deduplicates adjacent identical messages, truncates output.
 */
export function buildAgentDigest(entries: LogBufferEntry[]): string {
  if (entries.length === 0) return "";

  // Group by runId (or "unassigned")
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

  const lines: string[] = [];
  let totalCount = 0;

  for (const [runId, group] of groups) {
    // Sort chronologically
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Dedup adjacent identical messages
    const deduped: LogBufferEntry[] = [];
    for (const entry of group) {
      const last = deduped[deduped.length - 1];
      if (last && last.message === entry.message) continue;
      deduped.push(entry);
    }

    // Truncate per run
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
 * Merge memory + pending buffer entries to compute current hot state.
 */
export function computeHotState(
  memory: SupervisorMemory,
  pendingEntries: LogBufferEntry[],
): { activeWork: string[]; blockers: string[] } {
  const activeWork = new Set(
    memory.activeWork.map((item) => item.description),
  );
  const blockers = new Set(
    memory.blockers.map((item) => item.description),
  );

  for (const entry of pendingEntries) {
    if (entry.type === "blocker") {
      blockers.add(entry.message);
    } else if (entry.type === "milestone") {
      activeWork.add(`✓ ${entry.message}`);
    } else if (entry.type === "progress" || entry.type === "action") {
      const label = entry.agent ? `[${entry.agent}] ${entry.message}` : entry.message;
      activeWork.add(label);
    }
  }

  return {
    activeWork: [...activeWork],
    blockers: [...blockers],
  };
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
