import { appendFile, stat } from "node:fs/promises";
import { fileForDate } from "@/shared/date";
import { ensureDir } from "@/shared/fs";
import type { NeoEvent } from "@/types";

/**
 * Error thrown when a journal file exceeds the maximum allowed size.
 * Re-exported from cost/journal for consistency.
 */
export class JournalFileSizeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly fileSizeBytes: number,
    public readonly maxSizeBytes: number,
  ) {
    super(
      `Journal file exceeds maximum size: ${filePath} (${(fileSizeBytes / 1024 / 1024).toFixed(2)}MB > ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB)`,
    );
    this.name = "JournalFileSizeError";
  }
}

/**
 * Append-only JSONL journal for events.
 * Monthly file rotation: events-YYYY-MM.jsonl
 * Write-only for v0.1 — read API comes in v0.2.
 */
export class EventJournal {
  private readonly dir: string;
  private readonly dirCache = new Set<string>();
  private readonly maxFileSizeBytes: number;

  constructor(options: { dir: string; maxFileSizeBytes?: number }) {
    this.dir = options.dir;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 500 * 1024 * 1024; // 500MB default
  }

  async append(event: NeoEvent): Promise<void> {
    await ensureDir(this.dir, this.dirCache);
    const file = fileForDate(new Date(event.timestamp), "events", this.dir);

    // Validate file size before appending to prevent unbounded growth
    try {
      const stats = await stat(file);
      if (stats.size > this.maxFileSizeBytes) {
        throw new JournalFileSizeError(file, stats.size, this.maxFileSizeBytes);
      }
    } catch (error) {
      // File doesn't exist yet — safe to append
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await appendFile(file, `${JSON.stringify(event)}\n`, "utf-8");
  }
}
