import { type FSWatcher, watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { InboxMessage, QueuedEvent, WebhookIncomingEvent } from "./schemas.js";

interface EventQueueOptions {
  maxEventsPerSec: number;
}

export interface GroupedMessage {
  text: string;
  from: string;
  count: number;
}

export interface GroupedEvents {
  messages: GroupedMessage[];
  webhooks: QueuedEvent[];
  runCompletions: QueuedEvent[];
}

export interface DrainAndGroupResult {
  grouped: GroupedEvents;
  rawEvents: QueuedEvent[];
}

/**
 * In-memory event queue with deduplication, rate limiting, and file watching.
 *
 * Accumulates events from 3 sources:
 * - Webhooks (pushed directly by WebhookServer)
 * - Inbox messages (watched from inbox.jsonl)
 * - Run completions (watched from runs directory)
 *
 * The daemon drains this queue at each heartbeat.
 */
export class EventQueue {
  private readonly queue: QueuedEvent[] = [];
  /** Set of event IDs for deduplication. Map preserves insertion order, so first entry is oldest. */
  private readonly seenIds = new Map<string, true>();
  private readonly maxSeenIds = 1000;
  private readonly maxEventsPerSec: number;
  private eventCountThisSecond = 0;
  private currentSecond = 0;
  private watchers: FSWatcher[] = [];
  private fileOffsets = new Map<string, number>();

  /** Resolve function to wake up the heartbeat loop when an event arrives */
  private wakeUp: (() => void) | null = null;

  /** Write locks keyed by file path to serialize read-modify-write operations */
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(options: EventQueueOptions) {
    this.maxEventsPerSec = options.maxEventsPerSec;
  }

  /**
   * Acquire the write lock for a file path and execute a callback.
   * Serializes write operations per-file to prevent race conditions during read-modify-write.
   */
  private async withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const release = this.writeLocks.get(filePath) ?? Promise.resolve();
    let releaseLock: () => void = () => {};
    const newLock = new Promise<void>((r) => {
      releaseLock = r;
    });
    this.writeLocks.set(filePath, newLock);

    try {
      await release;
      return await fn();
    } finally {
      releaseLock();
      if (this.writeLocks.get(filePath) === newLock) {
        this.writeLocks.delete(filePath);
      }
    }
  }

  /**
   * Push an event into the queue. Applies dedup and rate limiting.
   */
  push(event: QueuedEvent): boolean {
    // Deduplication by event ID
    const id = this.getEventId(event);
    if (id && this.seenIds.has(id)) return false;

    // Rate limiting
    const now = Math.floor(Date.now() / 1000);
    if (now !== this.currentSecond) {
      this.currentSecond = now;
      this.eventCountThisSecond = 0;
    }
    if (this.eventCountThisSecond >= this.maxEventsPerSec) return false;
    this.eventCountThisSecond++;

    // Track seen IDs for deduplication. Map preserves insertion order.
    if (id) {
      this.seenIds.set(id, true);
      if (this.seenIds.size > this.maxSeenIds) {
        this.evictOldestSeenId();
      }
    }

    this.queue.push(event);
    this.wakeUp?.();
    return true;
  }

  /**
   * Evicts the oldest entry from seenIds.
   * Map preserves insertion order, so the first key is the oldest — O(1) eviction.
   */
  private evictOldestSeenId(): void {
    const firstKey = this.seenIds.keys().next().value;
    if (firstKey !== undefined) {
      this.seenIds.delete(firstKey);
    }
  }

  /**
   * Drain all queued events and return them. Clears the queue.
   */
  drain(): QueuedEvent[] {
    const events = [...this.queue];
    this.queue.length = 0;
    return events;
  }

  /**
   * Drain and group events: deduplicates messages by content,
   * keeps webhooks and run completions separate.
   * Returns both grouped events AND original raw events for later marking as processed.
   */
  drainAndGroup(): DrainAndGroupResult {
    const rawEvents = this.drain();

    const messageMap = new Map<string, GroupedMessage>();
    const webhooks: QueuedEvent[] = [];
    const runCompletions: QueuedEvent[] = [];

    for (const event of rawEvents) {
      if (event.kind === "message") {
        if (!event.data.text) continue;
        const key = event.data.text.trim().toLowerCase();
        const existing = messageMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          messageMap.set(key, { text: event.data.text, from: event.data.from, count: 1 });
        }
      } else if (event.kind === "webhook") {
        webhooks.push(event);
      } else {
        runCompletions.push(event);
      }
    }

    return {
      grouped: {
        messages: [...messageMap.values()],
        webhooks,
        runCompletions,
      },
      rawEvents,
    };
  }

  size(): number {
    return this.queue.length;
  }

  /**
   * Start watching inbox.jsonl and events.jsonl for new entries.
   * New lines are parsed and pushed into the queue.
   */
  async startWatching(inboxPath: string, eventsPath: string): Promise<void> {
    // Ensure files exist before watching — fs.watch() throws on missing files
    for (const p of [inboxPath, eventsPath]) {
      try {
        await writeFile(p, "", { flag: "a" });
      } catch (err) {
        // Non-critical: file creation may fail due to permissions or missing parent directory.
        // watchJsonlFile will handle this gracefully by skipping the watch.
        // biome-ignore lint/suspicious/noConsole: Log file creation failures for debugging
        console.debug(`[neo] Failed to ensure file exists ${p}:`, err);
      }
    }
    this.watchJsonlFile(inboxPath, "message");
    this.watchJsonlFile(eventsPath, "webhook");
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.fileOffsets.clear();
  }

  /**
   * Replay unprocessed events from disk on startup.
   */
  async replayUnprocessed(inboxPath: string, eventsPath: string): Promise<void> {
    await this.replayFile(inboxPath, "message");
    await this.replayFile(eventsPath, "webhook");
  }

  /**
   * Returns a promise that resolves when a new event arrives or timeout is reached.
   */
  waitForEvent(timeoutMs: number): Promise<void> {
    if (this.queue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, timeoutMs);

      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  /**
   * Interrupt any pending waitForEvent — used during shutdown.
   */
  interrupt(): void {
    this.wakeUp?.();
  }

  private getEventId(event: QueuedEvent): string | undefined {
    if (event.kind === "webhook") return event.data.id;
    if (event.kind === "message") return event.data.id;
    if (event.kind === "run_complete") return `run:${event.runId}`;
    return undefined;
  }

  private watchJsonlFile(filePath: string, kind: "message" | "webhook"): void {
    try {
      const watcher = watch(filePath, () => {
        // Non-critical: file may have been deleted or become unreadable between watch trigger and read
        this.readNewLines(filePath, kind).catch((err) => {
          // biome-ignore lint/suspicious/noConsole: Log file watch read failures for debugging
          console.debug(`[neo] Failed to read new lines from ${filePath}:`, err);
        });
      });

      // Clean up watcher on error (e.g., file deleted, permissions changed)
      watcher.on("error", (err) => {
        // biome-ignore lint/suspicious/noConsole: Log watcher errors for debugging
        console.debug(`[neo] Watcher error for ${filePath}, cleaning up:`, err);
        this.cleanupWatcher(watcher);
      });

      this.watchers.push(watcher);
    } catch (err) {
      // Non-critical: file may not exist yet — watcher will be set up when file is created
      // biome-ignore lint/suspicious/noConsole: Log watcher setup failures for debugging
      console.debug(`[neo] Failed to watch file ${filePath}:`, err);
    }
  }

  /**
   * Properly close and remove a watcher from the active list.
   */
  private cleanupWatcher(watcher: FSWatcher): void {
    try {
      watcher.close();
    } catch (err) {
      // Ignore errors during close — watcher may already be closed
      // biome-ignore lint/suspicious/noConsole: Log watcher cleanup failures for debugging
      console.debug("[neo] Error closing watcher:", err);
    }
    const index = this.watchers.indexOf(watcher);
    if (index !== -1) {
      this.watchers.splice(index, 1);
    }
  }

  private async readNewLines(filePath: string, kind: "message" | "webhook"): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (_err) {
      // Non-critical: file may not exist or be temporarily unavailable during rotation
      // Silently return — the watcher will retry on next change event
      return;
    }

    const offset = this.fileOffsets.get(filePath) ?? 0;
    if (content.length <= offset) return;

    const newContent = content.slice(offset);
    this.fileOffsets.set(filePath, content.length);

    const lines = newContent.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.processedAt) continue; // Already processed

        if (kind === "webhook") {
          this.push({ kind: "webhook", data: parsed as unknown as WebhookIncomingEvent });
        } else {
          this.push({ kind: "message", data: parsed as unknown as InboxMessage });
        }
      } catch (_err) {
        // Non-critical: skip malformed JSON lines (may be partial writes or corrupted entries)
      }
    }
  }

  private async replayFile(filePath: string, kind: "message" | "webhook"): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (_err) {
      // Non-critical on replay: file may not exist yet on first startup
      // Events will be captured when file is created and watcher triggers
      return;
    }

    // Set offset so watcher doesn't re-read
    this.fileOffsets.set(filePath, content.length);

    const lines = content.trim().split("\n").filter(Boolean);
    const unprocessed: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.processedAt) continue;

        if (kind === "webhook") {
          this.push({ kind: "webhook", data: parsed as unknown as WebhookIncomingEvent });
        } else {
          this.push({ kind: "message", data: parsed as unknown as InboxMessage });
        }
        unprocessed.push(line);
      } catch (_err) {
        // Non-critical: skip malformed JSON lines during replay (may be partial writes)
      }
    }
  }

  /**
   * Mark events as processed by rewriting the source files.
   */
  async markProcessed(inboxPath: string, eventsPath: string, events: QueuedEvent[]): Promise<void> {
    const now = new Date().toISOString();

    for (const event of events) {
      if (event.kind === "webhook") {
        await this.markInFile(eventsPath, event.data.receivedAt, now);
      } else if (event.kind === "message") {
        await this.markInFile(inboxPath, event.data.timestamp, now);
      }
    }
  }

  private async markInFile(
    filePath: string,
    matchTimestamp: string,
    processedAt: string,
  ): Promise<void> {
    return this.withWriteLock(filePath, async () => {
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");
        let changed = false;

        const updated = lines.map((line) => {
          if (!line.trim()) return line;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (
              (parsed.receivedAt === matchTimestamp || parsed.timestamp === matchTimestamp) &&
              !parsed.processedAt
            ) {
              parsed.processedAt = processedAt;
              changed = true;
              return JSON.stringify(parsed);
            }
          } catch (_err) {
            // Non-critical: keep malformed lines as-is (manual edits or corruption)
          }
          return line;
        });

        if (changed) {
          await writeFile(filePath, updated.join("\n"), "utf-8");
          this.fileOffsets.set(filePath, updated.join("\n").length);
        }
      } catch (err) {
        // Non-critical: marking as processed may fail but events are already handled.
        // Worst case: duplicate processing on restart (idempotent operations).
        // biome-ignore lint/suspicious/noConsole: Log mark processed failures for debugging
        console.debug(`[neo] Failed to mark events processed in ${filePath}:`, err);
      }
    });
  }
}
