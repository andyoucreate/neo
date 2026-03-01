import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EVENT_JOURNAL_PATH } from "./config.js";
import { logger } from "./logger.js";
import type { PipelineType } from "./types.js";

export type EventType =
  | "dispatch.requested"
  | "dispatch.started"
  | "dispatch.completed"
  | "dispatch.failed"
  | "dispatch.queued"
  | "dispatch.quarantined"
  | "session.killed"
  | "session.timeout"
  | "service.paused"
  | "service.resumed"
  | "service.started"
  | "service.stopped";

export interface JournalEntry {
  ts: string;
  event: EventType;
  pipeline?: PipelineType;
  sessionId?: string;
  ticketId?: string;
  prNumber?: number;
  repository?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

let dirEnsured = false;

/**
 * Append-only JSONL event journal.
 * Records all dispatch lifecycle events for audit trail and replay on restart.
 */
export async function appendEvent(
  event: EventType,
  data?: Omit<JournalEntry, "ts" | "event">,
): Promise<void> {
  if (!dirEnsured) {
    await mkdir(dirname(EVENT_JOURNAL_PATH), { recursive: true });
    dirEnsured = true;
  }

  const entry: JournalEntry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };

  await appendFile(EVENT_JOURNAL_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Read all journal entries (for replay on restart).
 */
export async function readJournal(): Promise<JournalEntry[]> {
  try {
    const content = await readFile(EVENT_JOURNAL_PATH, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
  } catch {
    return [];
  }
}

/**
 * Replay journal to recover pending dispatches after restart.
 * Returns tickets/PRs that were started but never completed.
 */
export async function replayJournal(): Promise<JournalEntry[]> {
  const entries = await readJournal();
  const started = new Map<string, JournalEntry>();

  for (const entry of entries) {
    const key = entry.sessionId ?? entry.ticketId ?? `pr-${entry.prNumber}`;
    if (!key) continue;

    if (entry.event === "dispatch.started") {
      started.set(key, entry);
    } else if (
      entry.event === "dispatch.completed" ||
      entry.event === "dispatch.failed" ||
      entry.event === "session.killed"
    ) {
      started.delete(key);
    }
  }

  const pending = Array.from(started.values());
  if (pending.length > 0) {
    logger.warn(`Journal replay: ${pending.length} unfinished session(s) found`);
  }

  return pending;
}

/**
 * Reset the dirEnsured flag (for testing).
 */
export function resetDirEnsured(): void {
  dirEnsured = false;
}
