import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CostEntry } from "@/types";

/**
 * Append-only JSONL journal for cost tracking.
 * Monthly file rotation: cost-YYYY-MM.jsonl
 */
export class CostJournal {
  private readonly dir: string;
  private dirCreated = false;
  private dayCache: { key: string; total: number } | null = null;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  async append(entry: CostEntry): Promise<void> {
    await this.ensureDir();
    const file = this.fileForDate(new Date(entry.timestamp));
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

    const file = this.fileForDate(d);
    let total = 0;

    try {
      const content = await readFile(file, "utf-8");
      for (const line of content.split("\n")) {
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

  private fileForDate(date: Date): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    return path.join(this.dir, `cost-${yyyy}-${mm}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(this.dir, { recursive: true });
    this.dirCreated = true;
  }
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
