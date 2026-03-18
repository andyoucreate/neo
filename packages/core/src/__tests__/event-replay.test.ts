import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue } from "@/supervisor/event-queue";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_event_replay_test__");

/**
 * Integration test for event replay fix (PR #71).
 *
 * Verifies that events marked as processed are NOT replayed when
 * a supervisor restarts. This prevents duplicate processing of
 * webhooks and inbox messages after supervisor crashes/restarts.
 */
describe("EventQueue replay on restart", () => {
  let inboxPath: string;
  let eventsPath: string;

  beforeEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(TMP_DIR, { recursive: true });
    inboxPath = path.join(TMP_DIR, "inbox.jsonl");
    eventsPath = path.join(TMP_DIR, "events.jsonl");
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("does not replay events that were marked as processed", async () => {
    // === Phase 1: First supervisor instance processes events ===

    // Write initial events to disk (simulating incoming webhooks/messages)
    const webhook1 = {
      id: "webhook-1",
      type: "pull_request",
      receivedAt: "2026-03-18T10:00:00.000Z",
    };
    const webhook2 = {
      id: "webhook-2",
      type: "issue",
      receivedAt: "2026-03-18T10:01:00.000Z",
    };
    const message1 = {
      id: "msg-1",
      text: "Hello",
      from: "user",
      timestamp: "2026-03-18T10:02:00.000Z",
    };

    await writeFile(eventsPath, `${JSON.stringify(webhook1)}\n${JSON.stringify(webhook2)}\n`);
    await writeFile(inboxPath, `${JSON.stringify(message1)}\n`);

    // Create first supervisor's EventQueue and replay unprocessed events
    const queue1 = new EventQueue({ maxEventsPerSec: 100 });
    await queue1.replayUnprocessed(inboxPath, eventsPath);

    // Verify all 3 events were queued
    expect(queue1.size()).toBe(3);

    // Drain and group events (simulates heartbeat processing)
    const { grouped, rawEvents } = queue1.drainAndGroup();
    expect(grouped.webhooks).toHaveLength(2);
    expect(grouped.messages).toHaveLength(1);
    expect(rawEvents).toHaveLength(3);

    // Mark events as processed (this is the fix from PR #71)
    await queue1.markProcessed(inboxPath, eventsPath, rawEvents);

    // Verify events are marked with processedAt in files
    const eventsContent = await readFile(eventsPath, "utf-8");
    const inboxContent = await readFile(inboxPath, "utf-8");

    for (const line of eventsContent.trim().split("\n")) {
      const parsed = JSON.parse(line);
      expect(parsed.processedAt).toBeDefined();
    }
    for (const line of inboxContent.trim().split("\n")) {
      const parsed = JSON.parse(line);
      expect(parsed.processedAt).toBeDefined();
    }

    queue1.stopWatching();

    // === Phase 2: Simulate supervisor restart with new instance ===

    // Create second supervisor's EventQueue (simulates restart)
    const queue2 = new EventQueue({ maxEventsPerSec: 100 });
    await queue2.replayUnprocessed(inboxPath, eventsPath);

    // CRITICAL ASSERTION: No events should be queued because all were processed
    expect(queue2.size()).toBe(0);

    queue2.stopWatching();
  });

  it("replays only unprocessed events after partial processing", async () => {
    // Write 3 events, but only mark 2 as processed
    const webhook1 = {
      id: "webhook-1",
      type: "pull_request",
      receivedAt: "2026-03-18T10:00:00.000Z",
      processedAt: "2026-03-18T10:05:00.000Z", // Already processed
    };
    const webhook2 = {
      id: "webhook-2",
      type: "issue",
      receivedAt: "2026-03-18T10:01:00.000Z",
      // Not processed yet
    };
    const message1 = {
      id: "msg-1",
      text: "Hello",
      from: "user",
      timestamp: "2026-03-18T10:02:00.000Z",
      processedAt: "2026-03-18T10:05:00.000Z", // Already processed
    };

    await writeFile(eventsPath, `${JSON.stringify(webhook1)}\n${JSON.stringify(webhook2)}\n`);
    await writeFile(inboxPath, `${JSON.stringify(message1)}\n`);

    // Create supervisor's EventQueue and replay
    const queue = new EventQueue({ maxEventsPerSec: 100 });
    await queue.replayUnprocessed(inboxPath, eventsPath);

    // Only the unprocessed webhook2 should be queued
    expect(queue.size()).toBe(1);

    const { grouped } = queue.drainAndGroup();
    expect(grouped.webhooks).toHaveLength(1);
    const webhookEvent = grouped.webhooks[0];
    expect(webhookEvent?.kind).toBe("webhook");
    if (webhookEvent?.kind === "webhook") {
      expect(webhookEvent.data.id).toBe("webhook-2");
    }
    expect(grouped.messages).toHaveLength(0);

    queue.stopWatching();
  });

  it("handles empty files gracefully on restart", async () => {
    // Create empty files
    await writeFile(eventsPath, "");
    await writeFile(inboxPath, "");

    const queue = new EventQueue({ maxEventsPerSec: 100 });
    await queue.replayUnprocessed(inboxPath, eventsPath);

    expect(queue.size()).toBe(0);

    queue.stopWatching();
  });

  it("handles missing files gracefully on restart", async () => {
    const queue = new EventQueue({ maxEventsPerSec: 100 });

    // Should not throw when files don't exist
    await expect(queue.replayUnprocessed(inboxPath, eventsPath)).resolves.not.toThrow();

    expect(queue.size()).toBe(0);

    queue.stopWatching();
  });

  it("full restart cycle: process, restart, add new events, process again", async () => {
    // === Phase 1: Initial events ===
    const webhook1 = {
      id: "webhook-1",
      type: "push",
      receivedAt: "2026-03-18T10:00:00.000Z",
    };
    await writeFile(eventsPath, `${JSON.stringify(webhook1)}\n`);
    await writeFile(inboxPath, "");

    const queue1 = new EventQueue({ maxEventsPerSec: 100 });
    await queue1.replayUnprocessed(inboxPath, eventsPath);
    expect(queue1.size()).toBe(1);

    const { rawEvents: rawEvents1 } = queue1.drainAndGroup();
    await queue1.markProcessed(inboxPath, eventsPath, rawEvents1);
    queue1.stopWatching();

    // === Phase 2: Restart and add new event ===
    const webhook2 = {
      id: "webhook-2",
      type: "issue",
      receivedAt: "2026-03-18T11:00:00.000Z",
    };

    // Append new event to existing file (which has processed webhook1)
    const existingContent = await readFile(eventsPath, "utf-8");
    await writeFile(eventsPath, `${existingContent}${JSON.stringify(webhook2)}\n`);

    const queue2 = new EventQueue({ maxEventsPerSec: 100 });
    await queue2.replayUnprocessed(inboxPath, eventsPath);

    // Only the new unprocessed webhook2 should be queued
    expect(queue2.size()).toBe(1);

    const { grouped, rawEvents: rawEvents2 } = queue2.drainAndGroup();
    expect(grouped.webhooks).toHaveLength(1);
    const webhookEvent = grouped.webhooks[0];
    expect(webhookEvent?.kind).toBe("webhook");
    if (webhookEvent?.kind === "webhook") {
      expect(webhookEvent.data.id).toBe("webhook-2");
    }

    // Mark as processed
    await queue2.markProcessed(inboxPath, eventsPath, rawEvents2);
    queue2.stopWatching();

    // === Phase 3: Final restart - nothing should be replayed ===
    const queue3 = new EventQueue({ maxEventsPerSec: 100 });
    await queue3.replayUnprocessed(inboxPath, eventsPath);

    expect(queue3.size()).toBe(0);

    queue3.stopWatching();
  });
});
