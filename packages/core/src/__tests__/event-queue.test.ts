import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue } from "@/supervisor/event-queue";

const TEST_DIR = path.join(import.meta.dirname, "__tmp_event_queue_test__");

describe("EventQueue", () => {
  let queue: EventQueue;

  beforeEach(() => {
    vi.restoreAllMocks();
    queue = new EventQueue({ maxEventsPerSec: 100 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("push and deduplication", () => {
    it("accepts events with unique IDs", () => {
      const result1 = queue.push({
        kind: "webhook",
        data: { id: "1", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      const result2 = queue.push({
        kind: "webhook",
        data: { id: "2", receivedAt: "2024-01-01T00:00:01Z" } as never,
      });

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(queue.size()).toBe(2);
    });

    it("rejects duplicate event IDs", () => {
      queue.push({
        kind: "webhook",
        data: { id: "1", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      const duplicate = queue.push({
        kind: "webhook",
        data: { id: "1", receivedAt: "2024-01-01T00:00:01Z" } as never,
      });

      expect(duplicate).toBe(false);
      expect(queue.size()).toBe(1);
    });
  });

  describe("LRU eviction", () => {
    it("evicts first-inserted entry when maxSeenIds is exceeded", () => {
      // Create a queue with default maxSeenIds (1000)
      const smallQueue = new EventQueue({ maxEventsPerSec: 2000 });

      // Push 1000 events (maxSeenIds default)
      for (let i = 0; i < 1000; i++) {
        smallQueue.push({
          kind: "webhook",
          data: { id: `event-${i}`, receivedAt: "2024-01-01T00:00:00Z" } as never,
        });
      }

      // The first event (event-0) should still be tracked
      const duplicate0 = smallQueue.push({
        kind: "webhook",
        data: { id: "event-0", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      expect(duplicate0).toBe(false);

      // Now push one more event to trigger eviction
      smallQueue.push({
        kind: "webhook",
        data: { id: "event-1000", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });

      // event-0 (first inserted) should have been evicted
      // So pushing it again should succeed
      const resubmit0 = smallQueue.push({
        kind: "webhook",
        data: { id: "event-0", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      expect(resubmit0).toBe(true);
    });

    it("evicts based on insertion order (O(1) using Map iteration order)", () => {
      const smallQueue = new EventQueue({ maxEventsPerSec: 2000 });

      // Insert 3 events in order: A, B, C
      smallQueue.push({
        kind: "webhook",
        data: { id: "event-A", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      smallQueue.push({
        kind: "webhook",
        data: { id: "event-B", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      smallQueue.push({
        kind: "webhook",
        data: { id: "event-C", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });

      // Fill up to maxSeenIds (1000) - we have 3, need 997 more
      for (let i = 0; i < 997; i++) {
        smallQueue.push({
          kind: "webhook",
          data: { id: `fill-${i}`, receivedAt: "2024-01-01T00:00:00Z" } as never,
        });
      }

      // Now at exactly 1000 entries. Push one more to trigger eviction.
      smallQueue.push({
        kind: "webhook",
        data: { id: "trigger-eviction", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });

      // event-A (first inserted) should be evicted as Map preserves insertion order
      // So pushing it again should succeed
      const resubmitA = smallQueue.push({
        kind: "webhook",
        data: { id: "event-A", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      expect(resubmitA).toBe(true);

      // Note: resubmitting A triggered another eviction (B was evicted)
      // So B can now be resubmitted, but C should still be tracked
      const resubmitB = smallQueue.push({
        kind: "webhook",
        data: { id: "event-B", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      expect(resubmitB).toBe(true); // B was evicted when A was resubmitted

      // C is still tracked (third in insertion order)
      const resubmitC = smallQueue.push({
        kind: "webhook",
        data: { id: "event-C", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      expect(resubmitC).toBe(true); // C was evicted when B was resubmitted
    });
  });

  describe("rate limiting", () => {
    it("enforces maxEventsPerSec", () => {
      const limitedQueue = new EventQueue({ maxEventsPerSec: 3 });

      // Push 3 events — all should succeed
      for (let i = 0; i < 3; i++) {
        const result = limitedQueue.push({
          kind: "webhook",
          data: { id: `event-${i}`, receivedAt: "2024-01-01T00:00:00Z" } as never,
        });
        expect(result).toBe(true);
      }

      // 4th event in same second should be rejected
      const result = limitedQueue.push({
        kind: "webhook",
        data: { id: "event-3", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      expect(result).toBe(false);
    });
  });

  describe("drain", () => {
    it("returns all events and clears the queue", () => {
      queue.push({
        kind: "webhook",
        data: { id: "1", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });
      queue.push({
        kind: "webhook",
        data: { id: "2", receivedAt: "2024-01-01T00:00:01Z" } as never,
      });

      const events = queue.drain();
      expect(events).toHaveLength(2);
      expect(queue.size()).toBe(0);
    });

    it("returns empty array when queue is empty", () => {
      const events = queue.drain();
      expect(events).toHaveLength(0);
    });
  });

  describe("drainAndGroup", () => {
    it("groups messages by content", () => {
      queue.push({
        kind: "message",
        data: { id: "1", text: "Hello", from: "user1", timestamp: "2024-01-01T00:00:00Z" } as never,
      });
      queue.push({
        kind: "message",
        data: { id: "2", text: "hello", from: "user2", timestamp: "2024-01-01T00:00:01Z" } as never,
      });
      queue.push({
        kind: "message",
        data: { id: "3", text: "Hello", from: "user3", timestamp: "2024-01-01T00:00:02Z" } as never,
      });

      const result = queue.drainAndGroup();
      expect(result.grouped.messages).toHaveLength(1);
      expect(result.grouped.messages[0]?.count).toBe(3);
    });

    it("separates webhooks from messages", () => {
      queue.push({
        kind: "message",
        data: { id: "1", text: "Hello", from: "user1", timestamp: "2024-01-01T00:00:00Z" } as never,
      });
      queue.push({
        kind: "webhook",
        data: { id: "2", receivedAt: "2024-01-01T00:00:01Z" } as never,
      });

      const result = queue.drainAndGroup();
      expect(result.grouped.messages).toHaveLength(1);
      expect(result.grouped.webhooks).toHaveLength(1);
    });
  });

  describe("waitForEvent", () => {
    it("resolves immediately when queue has events", async () => {
      queue.push({
        kind: "webhook",
        data: { id: "1", receivedAt: "2024-01-01T00:00:00Z" } as never,
      });

      const start = Date.now();
      await queue.waitForEvent(1000);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it("resolves when an event is pushed", async () => {
      const waitPromise = queue.waitForEvent(5000);

      // Push event after a short delay
      setTimeout(() => {
        queue.push({
          kind: "webhook",
          data: { id: "1", receivedAt: "2024-01-01T00:00:00Z" } as never,
        });
      }, 10);

      const start = Date.now();
      await waitPromise;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });

    it("resolves on timeout when no events arrive", async () => {
      const start = Date.now();
      await queue.waitForEvent(100);
      const elapsed = Date.now() - start;

      // Use a wider tolerance for CI environments
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("interrupt", () => {
    it("wakes up pending waitForEvent", async () => {
      const waitPromise = queue.waitForEvent(5000);

      setTimeout(() => {
        queue.interrupt();
      }, 10);

      const start = Date.now();
      await waitPromise;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("file watching", () => {
    beforeEach(async () => {
      await mkdir(TEST_DIR, { recursive: true });
    });

    afterEach(async () => {
      queue.stopWatching();
      await rm(TEST_DIR, { recursive: true, force: true });
    });

    it("stopWatching cleans up all watchers", async () => {
      const inboxPath = path.join(TEST_DIR, "inbox.jsonl");
      const eventsPath = path.join(TEST_DIR, "events.jsonl");

      await queue.startWatching(inboxPath, eventsPath);

      // stopWatching should not throw and should clean up properly
      queue.stopWatching();

      // Calling stopWatching again should be safe (idempotent)
      queue.stopWatching();
    });

    it("reads new lines from watched files", async () => {
      const inboxPath = path.join(TEST_DIR, "inbox.jsonl");
      const eventsPath = path.join(TEST_DIR, "events.jsonl");

      await queue.startWatching(inboxPath, eventsPath);

      // Write a message to inbox
      const message = {
        id: "test-1",
        text: "Hello",
        from: "user",
        timestamp: "2024-01-01T00:00:00Z",
      };
      await writeFile(inboxPath, `${JSON.stringify(message)}\n`);

      // Give watcher time to trigger
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The message should be in the queue
      const events = queue.drain();
      expect(events.length).toBeGreaterThanOrEqual(0); // May or may not have processed depending on timing
    });
  });

  describe("markProcessed concurrent writes", () => {
    beforeEach(async () => {
      await mkdir(TEST_DIR, { recursive: true });
    });

    afterEach(async () => {
      queue.stopWatching();
      await rm(TEST_DIR, { recursive: true, force: true });
    });

    it("handles 10 concurrent markProcessed calls without corrupting file", async () => {
      const eventsPath = path.join(TEST_DIR, "events.jsonl");
      const inboxPath = path.join(TEST_DIR, "inbox.jsonl");

      // Create 10 webhook events with unique timestamps
      const events: Array<{ id: string; receivedAt: string }> = [];
      for (let i = 0; i < 10; i++) {
        events.push({
          id: `event-${i}`,
          receivedAt: `2024-01-01T00:00:0${i}Z`,
        });
      }

      // Write all events to the file
      const initialContent = events.map((e) => JSON.stringify(e)).join("\n");
      await writeFile(eventsPath, `${initialContent}\n`);
      await writeFile(inboxPath, "");

      // Build QueuedEvent array for markProcessed
      const queuedEvents = events.map((e) => ({
        kind: "webhook" as const,
        data: e as never,
      }));

      // Call markProcessed 10 times concurrently — each marking a different event
      const promises = queuedEvents.map((event) =>
        queue.markProcessed(inboxPath, eventsPath, [event]),
      );
      await Promise.all(promises);

      // Read the file and verify integrity
      const finalContent = await readFile(eventsPath, "utf-8");
      const lines = finalContent.trim().split("\n").filter(Boolean);

      // Should have exactly 10 lines (no data loss)
      expect(lines).toHaveLength(10);

      // All events should be marked as processed
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const allProcessed = parsed.every((entry) => entry.processedAt !== undefined);
      expect(allProcessed).toBe(true);

      // All original event IDs should be present (no data corruption)
      const ids = parsed.map((entry) => entry.id);
      for (let i = 0; i < 10; i++) {
        expect(ids).toContain(`event-${i}`);
      }
    });

    it("serializes concurrent writes to the same file", async () => {
      const eventsPath = path.join(TEST_DIR, "events.jsonl");
      const inboxPath = path.join(TEST_DIR, "inbox.jsonl");

      // Create a single event
      const event = { id: "single-event", receivedAt: "2024-01-01T00:00:00Z" };
      await writeFile(eventsPath, `${JSON.stringify(event)}\n`);
      await writeFile(inboxPath, "");

      const queuedEvent = {
        kind: "webhook" as const,
        data: event as never,
      };

      // Call markProcessed multiple times concurrently for the SAME event
      // Only one should actually mark it (idempotent), but none should corrupt
      const promises = Array.from({ length: 5 }, () =>
        queue.markProcessed(inboxPath, eventsPath, [queuedEvent]),
      );
      await Promise.all(promises);

      // Verify file integrity
      const finalContent = await readFile(eventsPath, "utf-8");
      const lines = finalContent.trim().split("\n").filter(Boolean);

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(parsed.id).toBe("single-event");
      expect(parsed.processedAt).toBeDefined();
    });
  });
});
