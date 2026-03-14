import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "./schemas.js";

const ACTIVITY_FILE = "activity.jsonl";
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB rotation threshold

export class ActivityLog {
  private readonly filePath: string;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.filePath = path.join(dir, ACTIVITY_FILE);
  }

  /**
   * Append a structured entry to the activity log.
   * Rotates the file if it exceeds MAX_SIZE_BYTES.
   */
  async append(entry: ActivityEntry): Promise<void> {
    await this.checkRotation();
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(this.filePath, line, "utf-8");
  }

  /**
   * Create and append a new entry with auto-generated id and timestamp.
   */
  async log(type: ActivityEntry["type"], summary: string, detail?: unknown): Promise<void> {
    await this.append({
      id: randomUUID(),
      type,
      summary,
      detail,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Read the last N entries from the activity log.
   */
  async tail(n: number): Promise<ActivityEntry[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const lastLines = lines.slice(-n);

    const entries: ActivityEntry[] = [];
    for (const line of lastLines) {
      try {
        entries.push(JSON.parse(line) as ActivityEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  private async checkRotation(): Promise<void> {
    try {
      const stats = await stat(this.filePath);
      if (stats.size > MAX_SIZE_BYTES) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotatedPath = path.join(this.dir, `activity-${timestamp}.jsonl`);
        await rename(this.filePath, rotatedPath);
      }
    } catch {
      // File doesn't exist yet — no rotation needed
    }
  }
}
