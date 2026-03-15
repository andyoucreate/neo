import { appendFile } from "node:fs/promises";
import { fileForDate } from "@/shared/date";
import { ensureDir } from "@/shared/fs";
import type { NeoEvent } from "@/types";

/**
 * Append-only JSONL journal for events.
 * Monthly file rotation: events-YYYY-MM.jsonl
 * Write-only for v0.1 — read API comes in v0.2.
 */
export class EventJournal {
  private readonly dir: string;
  private readonly dirCache = new Set<string>();

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  async append(event: NeoEvent): Promise<void> {
    await ensureDir(this.dir, this.dirCache);
    const file = fileForDate(new Date(event.timestamp), "events", this.dir);
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf-8");
  }
}
