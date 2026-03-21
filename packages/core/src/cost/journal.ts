import { createReadStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import { fileForDate, toDateKey } from "@/shared/date";
import { ensureDir } from "@/shared/fs";
import type { CostEntry } from "@/types";

// Zod schema for runtime validation of JSONL entries
const costEntrySchema = z.object({
  timestamp: z.string(),
  runId: z.string(),
  step: z.string(),
  sessionId: z.string(),
  agent: z.string(),
  costUsd: z.number(),
  models: z.record(z.string(), z.number()),
  durationMs: z.number(),
  repo: z.string().optional(),
});

/**
 * Append-only JSONL journal for cost tracking.
 * Monthly file rotation: cost-YYYY-MM.jsonl
 */
export class CostJournal {
  private readonly dir: string;
  private readonly dirCache = new Set<string>();
  private dayCache: { key: string; total: number } | null = null;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
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
      const stream = createReadStream(file, { encoding: "utf-8" });
      // CRITICAL: Do NOT insert await between createInterface and for-await loop
      // See Node.js Issue #33463 - timing bug can cause readline to miss data
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = costEntrySchema.parse(JSON.parse(line));
          if (toDateKey(new Date(entry.timestamp)) === dayKey) {
            total += entry.costUsd;
          }
        } catch (error) {
          // Skip malformed entries - log warning but continue processing
          // biome-ignore lint/suspicious/noConsole: Intentional warning for parse failures
          console.warn(
            `[CostJournal] Skipping malformed JSONL line: ${error instanceof Error ? error.message : "unknown error"}`,
          );
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
