import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "./schemas.js";

const ACTIVITY_FILE = "activity.jsonl";
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB rotation threshold

export class ActivityLog {
  readonly filePath: string;
  private readonly dir: string;
  /** Promise-based mutex to serialize write operations */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.filePath = path.join(dir, ACTIVITY_FILE);
  }

  /**
   * Acquire the write lock and execute a callback.
   * Serializes write operations to prevent race conditions during rotation.
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the existing lock
    const release = this.writeLock;
    let releaseLock: () => void = () => {};
    this.writeLock = new Promise((r) => {
      releaseLock = r;
    });

    try {
      // Wait for previous operation to complete
      await release;
      return await fn();
    } finally {
      // Release the lock for the next operation
      releaseLock();
    }
  }

  /**
   * Append a structured entry to the activity log.
   * Rotates the file if it exceeds MAX_SIZE_BYTES.
   * Uses a mutex to serialize concurrent calls and prevent race conditions.
   */
  async append(entry: ActivityEntry): Promise<void> {
    return this.withWriteLock(async () => {
      await this.checkRotation();
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(this.filePath, line, "utf-8");
    });
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
    } catch (err) {
      // Activity log file not found — no entries yet
      console.debug(
        `[ActivityLog] Failed to read activity log: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const lastLines = lines.slice(-n);

    const entries: ActivityEntry[] = [];
    for (const line of lastLines) {
      try {
        entries.push(JSON.parse(line) as ActivityEntry);
      } catch (err) {
        // Skip malformed JSONL line
        console.debug(
          `[ActivityLog] Skipping malformed line: ${err instanceof Error ? err.message : String(err)}`,
        );
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
