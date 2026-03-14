import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NeoEvent } from "@/types";

/**
 * Append-only JSONL journal for events.
 * Monthly file rotation: events-YYYY-MM.jsonl
 * Write-only for v0.1 — read API comes in v0.2.
 */
export class EventJournal {
  private readonly dir: string;
  private dirCreated = false;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  async append(event: NeoEvent): Promise<void> {
    await this.ensureDir();
    const file = this.fileForDate(new Date(event.timestamp));
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf-8");
  }

  private fileForDate(date: Date): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    return path.join(this.dir, `events-${yyyy}-${mm}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(this.dir, { recursive: true });
    this.dirCreated = true;
  }
}
