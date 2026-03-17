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
   */
  drainAndGroup(): GroupedEvents {
    const events = this.drain();

    const messageMap = new Map<string, GroupedMessage>();
    const webhooks: QueuedEvent[] = [];
    const runCompletions: QueuedEvent[] = [];

    for (const event of events) {
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
      messages: [...messageMap.values()],
      webhooks,
      runCompletions,
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
      } catch (_err) {
        // Non-critical — watchJsonlFile will handle missing files gracefully
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
        this.readNewLines(filePath, kind).catch((err) => {
          console.error(`[EventQueue] Failed to read new lines from ${filePath}:`, err);
        });
      });
      this.watchers.push(watcher);
    } catch (_err) {
      // File may not exist yet — watcher will be created when file appears
    }
  }

  private async readNewLines(filePath: string, kind: "message" | "webhook"): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      // Critical: file existed when watcher was created but is now unreadable
      console.error(`[EventQueue] Failed to read ${filePath}:`, err);
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
        // Skip malformed JSON lines — non-critical, file may contain partial writes
      }
    }
  }

  private async replayFile(filePath: string, kind: "message" | "webhook"): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (_err) {
      // Non-critical: file may not exist on first startup — nothing to replay
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
        // Skip malformed JSON lines — non-critical, file may contain partial writes
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
          // Keep malformed lines as-is — preserve file integrity
        }
        return line;
      });

      if (changed) {
        await writeFile(filePath, updated.join("\n"), "utf-8");
        this.fileOffsets.set(filePath, updated.join("\n").length);
      }
    } catch (_err) {
      // Non-critical: marking processed is best-effort, events will be deduped on next run
    }
  }
}
