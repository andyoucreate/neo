import { createReadStream } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileForDate, toDateKey } from "@/shared/date";
import { ensureDir } from "@/shared/fs";
import type { CostEntry } from "@/types";

/**
 * Error thrown when a journal file exceeds the maximum allowed size.
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
 * Append-only JSONL journal for cost tracking.
 * Monthly file rotation: cost-YYYY-MM.jsonl
 */
export class CostJournal {
  private readonly dir: string;
  private readonly dirCache = new Set<string>();
  private dayCache: { key: string; total: number } | null = null;
  private readonly maxFileSizeBytes: number;

  constructor(options: { dir: string; maxFileSizeBytes?: number }) {
    this.dir = options.dir;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 100 * 1024 * 1024; // 100MB default
  }

  async append(entry: CostEntry): Promise<void> {
    await ensureDir(this.dir, this.dirCache);
    const file = fileForDate(new Date(entry.timestamp), "cost", this.dir);
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
    // Invalidate cache — the day total may have changed
    this.dayCache = null;
  }

  async getDayTotal(date?: Date): Promise<number> {
    const d = date ?? new Date();
    const dayKey = toDateKey(d);

    if (this.dayCache?.key === dayKey) {
      return this.dayCache.total;
    }

    const file = fileForDate(d, "cost", this.dir);
    let total = 0;

    try {
      // Validate file size before reading
      const stats = await stat(file);
      if (stats.size > this.maxFileSizeBytes) {
        throw new JournalFileSizeError(file, stats.size, this.maxFileSizeBytes);
      }

      const stream = createReadStream(file, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

      for await (const line of rl) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as CostEntry;
        if (toDateKey(new Date(entry.timestamp)) === dayKey) {
          total += entry.costUsd;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // File doesn't exist yet — total is 0
    }

    this.dayCache = { key: dayKey, total };
    return total;
  }
}
