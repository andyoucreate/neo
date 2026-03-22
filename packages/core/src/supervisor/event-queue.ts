import { createReadStream, type FSWatcher, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
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
  private readonly seenIds = new Set<string>();
  private readonly maxSeenIds = 1000;
  private readonly maxEventsPerSec: number;
  private eventCountThisSecond = 0;
  private currentSecond = 0;
  private watchers: FSWatcher[] = [];
  private fileOffsets = new Map<string, number>();

  /** Resolve function to wake up the heartbeat loop when an event arrives */
  private wakeUp: (() => void) | null = null;

  constructor(options: EventQueueOptions) {
    this.maxEventsPerSec = options.maxEventsPerSec;
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

    // Track seen IDs (LRU-style: evict oldest when full)
    if (id) {
      this.seenIds.add(id);
      if (this.seenIds.size > this.maxSeenIds) {
        const first = this.seenIds.values().next().value;
        if (first) this.seenIds.delete(first);
      }
    }

    this.queue.push(event);
    this.wakeUp?.();
    return true;
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
      } catch {
        // Non-critical: file creation may fail due to permissions or missing parent directory.
        // watchJsonlFile will handle this gracefully by skipping the watch.
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
      this.watchers.push(watcher);
    } catch {
      // Non-critical: file may not exist yet — watcher will be set up when file is created
    }
  }

  private async readNewLines(filePath: string, kind: "message" | "webhook"): Promise<void> {
    const offset = this.fileOffsets.get(filePath) ?? 0;
    let currentOffset = offset;

    try {
      const fileStream = createReadStream(filePath, {
        encoding: "utf-8",
        start: offset,
      });
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      for await (const line of rl) {
        currentOffset += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
        if (!line.trim()) continue;

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

      this.fileOffsets.set(filePath, currentOffset);
    } catch (_err) {
      // Non-critical: file may not exist or be temporarily unavailable during rotation
      // Silently return — the watcher will retry on next change event
      return;
    }
  }

  private async replayFile(filePath: string, kind: "message" | "webhook"): Promise<void> {
    let fileSize = 0;
    try {
      const fileStream = createReadStream(filePath, { encoding: "utf-8" });
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      for await (const line of rl) {
        fileSize += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.processedAt) continue;

          if (kind === "webhook") {
            this.push({ kind: "webhook", data: parsed as unknown as WebhookIncomingEvent });
          } else {
            this.push({ kind: "message", data: parsed as unknown as InboxMessage });
          }
        } catch (_err) {
          // Non-critical: skip malformed JSON lines during replay (may be partial writes)
        }
      }

      // Set offset so watcher doesn't re-read
      this.fileOffsets.set(filePath, fileSize);
    } catch (_err) {
      // Non-critical on replay: file may not exist yet on first startup
      // Events will be captured when file is created and watcher triggers
      return;
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
    try {
      const fileStream = createReadStream(filePath, { encoding: "utf-8" });
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      const updated: string[] = [];
      let changed = false;

      for await (const line of rl) {
        if (!line.trim()) {
          updated.push(line);
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (
            (parsed.receivedAt === matchTimestamp || parsed.timestamp === matchTimestamp) &&
            !parsed.processedAt
          ) {
            parsed.processedAt = processedAt;
            changed = true;
            updated.push(JSON.stringify(parsed));
          } else {
            updated.push(line);
          }
        } catch (_err) {
          // Non-critical: keep malformed lines as-is (manual edits or corruption)
          updated.push(line);
        }
      }

      if (changed) {
        const content = updated.length > 0 ? `${updated.join("\n")}\n` : "";
        await writeFile(filePath, content, "utf-8");
        this.fileOffsets.set(filePath, content.length);
      }
    } catch {
      // Non-critical: marking as processed may fail but events are already handled.
      // Worst case: duplicate processing on restart (idempotent operations).
    }
  }
}
