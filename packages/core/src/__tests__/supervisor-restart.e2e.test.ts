import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue } from "@/supervisor/event-queue";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_supervisor_restart_test__");

/**
 * Integration test for supervisor clean restart (PR #83).
 *
 * Verifies that when a supervisor restarts (with persistSession: false),
 * previously processed events are NOT replayed. This ensures:
 * - No duplicate webhook processing
 * - No duplicate message handling
 * - Clean state after restart
 *
 * The fix adds `persistSession: false` to the SDK query options in
 * heartbeat.ts, ensuring each heartbeat is a fresh conversation and
 * supervisor restarts don't replay old Claude session history.
 *
 * This test validates the event-level behavior that complements
 * the SDK session behavior.
 */
describe("supervisor clean restart", () => {
  let supervisorDir: string;
  let inboxPath: string;
  let eventsPath: string;

  beforeEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(TMP_DIR, { recursive: true });
    supervisorDir = TMP_DIR;
    inboxPath = path.join(supervisorDir, "inbox.jsonl");
    eventsPath = path.join(supervisorDir, "events.jsonl");
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("does not reprocess events after clean supervisor restart", async () => {
    // === Phase 1: First supervisor instance starts and processes events ===

    // Simulate incoming webhook event
    const webhookEvent = {
      id: "webhook-pr-123",
      type: "pull_request",
      action: "opened",
      receivedAt: "2026-03-19T10:00:00.000Z",
    };

    await writeFile(eventsPath, `${JSON.stringify(webhookEvent)}\n`);
    await writeFile(inboxPath, "");

    // First supervisor instance starts and replays unprocessed events
    const supervisor1Queue = new EventQueue({ maxEventsPerSec: 100 });
    await supervisor1Queue.replayUnprocessed(inboxPath, eventsPath);

    // Verify the event was queued
    expect(supervisor1Queue.size()).toBe(1);

    // Supervisor processes the event (drains and groups)
    const { grouped: grouped1, rawEvents: rawEvents1 } = supervisor1Queue.drainAndGroup();
    expect(grouped1.webhooks).toHaveLength(1);
    expect(grouped1.webhooks[0]?.kind).toBe("webhook");

    // Mark event as processed (this happens in heartbeat.ts after SDK call)
    await supervisor1Queue.markProcessed(inboxPath, eventsPath, rawEvents1);

    // Verify the event file now has processedAt marker
    const eventsContent = await readFile(eventsPath, "utf-8");
    const parsedEvent = JSON.parse(eventsContent.trim());
    expect(parsedEvent.processedAt).toBeDefined();

    // First supervisor shuts down
    supervisor1Queue.stopWatching();

    // === Phase 2: Supervisor restarts (new instance) ===

    // Second supervisor instance starts — simulates restart
    const supervisor2Queue = new EventQueue({ maxEventsPerSec: 100 });
    await supervisor2Queue.replayUnprocessed(inboxPath, eventsPath);

    // CRITICAL: No events should be replayed because all were processed
    expect(supervisor2Queue.size()).toBe(0);

    // Verify drain returns empty
    const { grouped: grouped2 } = supervisor2Queue.drainAndGroup();
    expect(grouped2.webhooks).toHaveLength(0);
    expect(grouped2.messages).toHaveLength(0);
    expect(grouped2.runCompletions).toHaveLength(0);

    supervisor2Queue.stopWatching();
  });

  it("processes only new events after restart, ignores old processed ones", async () => {
    // === Phase 1: Initial events processed ===

    const oldWebhook = {
      id: "webhook-old-1",
      type: "push",
      receivedAt: "2026-03-19T09:00:00.000Z",
    };

    const oldMessage = {
      id: "msg-old-1",
      text: "dispatch agent to repo",
      from: "slack",
      timestamp: "2026-03-19T09:01:00.000Z",
    };

    await writeFile(eventsPath, `${JSON.stringify(oldWebhook)}\n`);
    await writeFile(inboxPath, `${JSON.stringify(oldMessage)}\n`);

    // First supervisor processes these events
    const queue1 = new EventQueue({ maxEventsPerSec: 100 });
    await queue1.replayUnprocessed(inboxPath, eventsPath);

    expect(queue1.size()).toBe(2);
    const { rawEvents: rawEvents1 } = queue1.drainAndGroup();
    await queue1.markProcessed(inboxPath, eventsPath, rawEvents1);
    queue1.stopWatching();

    // === Phase 2: New events arrive, then restart ===

    const newWebhook = {
      id: "webhook-new-1",
      type: "issue",
      action: "created",
      receivedAt: "2026-03-19T10:00:00.000Z",
    };

    // Append new event to existing file
    const existingContent = await readFile(eventsPath, "utf-8");
    await writeFile(eventsPath, `${existingContent}${JSON.stringify(newWebhook)}\n`);

    // Supervisor restarts
    const queue2 = new EventQueue({ maxEventsPerSec: 100 });
    await queue2.replayUnprocessed(inboxPath, eventsPath);

    // Only the NEW event should be queued
    expect(queue2.size()).toBe(1);

    const { grouped, rawEvents: rawEvents2 } = queue2.drainAndGroup();
    expect(grouped.webhooks).toHaveLength(1);
    expect(grouped.messages).toHaveLength(0); // Old message was already processed

    // Verify it's the new webhook
    const webhookEvent = grouped.webhooks[0];
    expect(webhookEvent?.kind).toBe("webhook");
    if (webhookEvent?.kind === "webhook") {
      expect(webhookEvent.data.id).toBe("webhook-new-1");
    }

    // Mark new event as processed
    await queue2.markProcessed(inboxPath, eventsPath, rawEvents2);
    queue2.stopWatching();

    // === Phase 3: Another restart — nothing should be replayed ===

    const queue3 = new EventQueue({ maxEventsPerSec: 100 });
    await queue3.replayUnprocessed(inboxPath, eventsPath);

    expect(queue3.size()).toBe(0);
    queue3.stopWatching();
  });

  it("handles crash recovery: unprocessed events are replayed", async () => {
    // Simulate a crash scenario where events were NOT marked as processed

    const crashedWebhook = {
      id: "webhook-crash-1",
      type: "pull_request",
      action: "merged",
      receivedAt: "2026-03-19T10:00:00.000Z",
      // Note: NO processedAt — simulates crash before marking
    };

    const processedWebhook = {
      id: "webhook-ok-1",
      type: "push",
      receivedAt: "2026-03-19T09:00:00.000Z",
      processedAt: "2026-03-19T09:05:00.000Z", // This one was processed before crash
    };

    // Write both to events file
    await writeFile(
      eventsPath,
      `${JSON.stringify(processedWebhook)}\n${JSON.stringify(crashedWebhook)}\n`,
    );
    await writeFile(inboxPath, "");

    // Supervisor restarts after crash
    const queue = new EventQueue({ maxEventsPerSec: 100 });
    await queue.replayUnprocessed(inboxPath, eventsPath);

    // Only the unprocessed (crashed) webhook should be replayed
    expect(queue.size()).toBe(1);

    const { grouped } = queue.drainAndGroup();
    expect(grouped.webhooks).toHaveLength(1);

    const webhookEvent = grouped.webhooks[0];
    expect(webhookEvent?.kind).toBe("webhook");
    if (webhookEvent?.kind === "webhook") {
      expect(webhookEvent.data.id).toBe("webhook-crash-1");
    }

    queue.stopWatching();
  });

  it("multiple restart cycles maintain correct state", async () => {
    // Simulate realistic scenario: multiple restarts over time

    // Restart 1: Initial event
    const event1 = {
      id: "event-1",
      type: "push",
      receivedAt: "2026-03-19T08:00:00.000Z",
    };
    await writeFile(eventsPath, `${JSON.stringify(event1)}\n`);
    await writeFile(inboxPath, "");

    const q1 = new EventQueue({ maxEventsPerSec: 100 });
    await q1.replayUnprocessed(inboxPath, eventsPath);
    expect(q1.size()).toBe(1);
    const { rawEvents: r1 } = q1.drainAndGroup();
    await q1.markProcessed(inboxPath, eventsPath, r1);
    q1.stopWatching();

    // Restart 2: Second event arrives
    const event2 = {
      id: "event-2",
      type: "issue",
      receivedAt: "2026-03-19T09:00:00.000Z",
    };
    const content1 = await readFile(eventsPath, "utf-8");
    await writeFile(eventsPath, `${content1}${JSON.stringify(event2)}\n`);

    const q2 = new EventQueue({ maxEventsPerSec: 100 });
    await q2.replayUnprocessed(inboxPath, eventsPath);
    expect(q2.size()).toBe(1); // Only event2
    const { grouped: g2, rawEvents: r2 } = q2.drainAndGroup();
    expect(g2.webhooks[0]?.kind).toBe("webhook");
    if (g2.webhooks[0]?.kind === "webhook") {
      expect(g2.webhooks[0].data.id).toBe("event-2");
    }
    await q2.markProcessed(inboxPath, eventsPath, r2);
    q2.stopWatching();

    // Restart 3: Third event arrives
    const event3 = {
      id: "event-3",
      type: "pr",
      receivedAt: "2026-03-19T10:00:00.000Z",
    };
    const content2 = await readFile(eventsPath, "utf-8");
    await writeFile(eventsPath, `${content2}${JSON.stringify(event3)}\n`);

    const q3 = new EventQueue({ maxEventsPerSec: 100 });
    await q3.replayUnprocessed(inboxPath, eventsPath);
    expect(q3.size()).toBe(1); // Only event3
    const { grouped: g3, rawEvents: r3 } = q3.drainAndGroup();
    expect(g3.webhooks[0]?.kind).toBe("webhook");
    if (g3.webhooks[0]?.kind === "webhook") {
      expect(g3.webhooks[0].data.id).toBe("event-3");
    }
    await q3.markProcessed(inboxPath, eventsPath, r3);
    q3.stopWatching();

    // Final restart: All events processed, nothing to replay
    const q4 = new EventQueue({ maxEventsPerSec: 100 });
    await q4.replayUnprocessed(inboxPath, eventsPath);
    expect(q4.size()).toBe(0);
    q4.stopWatching();

    // Verify all 3 events have processedAt
    const finalContent = await readFile(eventsPath, "utf-8");
    const lines = finalContent.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.processedAt).toBeDefined();
    }
  });

  it("handles mixed inbox messages and webhook events correctly", async () => {
    // Write both types of events
    const webhook = {
      id: "webhook-mixed-1",
      type: "pull_request",
      receivedAt: "2026-03-19T10:00:00.000Z",
    };

    const message = {
      id: "msg-mixed-1",
      text: "Please review PR #42",
      from: "user@example.com",
      timestamp: "2026-03-19T10:01:00.000Z",
    };

    await writeFile(eventsPath, `${JSON.stringify(webhook)}\n`);
    await writeFile(inboxPath, `${JSON.stringify(message)}\n`);

    // First supervisor processes both
    const queue1 = new EventQueue({ maxEventsPerSec: 100 });
    await queue1.replayUnprocessed(inboxPath, eventsPath);

    expect(queue1.size()).toBe(2);

    const { grouped, rawEvents } = queue1.drainAndGroup();
    expect(grouped.webhooks).toHaveLength(1);
    expect(grouped.messages).toHaveLength(1);
    expect(grouped.messages[0]?.text).toBe("Please review PR #42");

    // Mark all as processed
    await queue1.markProcessed(inboxPath, eventsPath, rawEvents);
    queue1.stopWatching();

    // Restart — nothing should be replayed
    const queue2 = new EventQueue({ maxEventsPerSec: 100 });
    await queue2.replayUnprocessed(inboxPath, eventsPath);

    expect(queue2.size()).toBe(0);

    queue2.stopWatching();
  });
});
