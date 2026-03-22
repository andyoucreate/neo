import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NeoConfig } from "@/config";
import { EventJournal } from "@/events/journal";
import { Orchestrator } from "@/orchestrator";
import type { NeoEvent } from "@/types";

describe("Error logging in .catch() blocks", () => {
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("logs event journal append failures", async () => {
    const mockConfig: NeoConfig = {
      repos: [],
      budget: { dailyCapUsd: 10, alertThresholdPct: 80 },
      concurrency: { maxSessions: 1, maxPerRepo: 1, queueMax: 10 },
      sessions: { dir: "/tmp/test-sessions", initTimeoutMs: 5000, maxDurationMs: 60000 },
      recovery: { maxRetries: 3, backoffBaseMs: 1000 },
      supervisor: {
        port: 7777,
        dailyCapUsd: 10,
        eventTimeoutMs: 1000,
        heartbeatTimeoutMs: 30000,
        maxConsecutiveFailures: 3,
        maxEventsPerSec: 10,
        consolidationIntervalMs: 300000,
        compactionIntervalMs: 3600000,
        idleSkipMax: 5,
        activeWorkSkipMax: 3,
        autoDecide: false,
      },
      webhooks: [],
      memory: { embeddings: false },
    };

    const orchestrator = new Orchestrator(mockConfig, {
      journalDir: "/nonexistent-path-to-trigger-error",
      skipOrphanRecovery: true,
    });

    await orchestrator.start();

    // Create a mock event journal that always fails
    const failingJournal = new EventJournal({ dir: "/nonexistent/path" });
    vi.spyOn(failingJournal, "append").mockRejectedValue(new Error("Write failed"));

    // Replace the journal with our failing one
    // @ts-expect-error - accessing private field for testing
    orchestrator.eventJournal = failingJournal;

    // Emit an event that should trigger the journal append
    const event: NeoEvent = {
      type: "session:start",
      sessionId: "test-session",
      runId: "test-run",
      step: "execute",
      agent: "developer",
      repo: "/tmp/test",
      timestamp: new Date().toISOString(),
    };

    orchestrator.emit(event);

    // Wait for async catch handler to execute
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that console.debug was called with the error
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[neo] Event journal append failed:",
      expect.stringContaining("Write failed"),
    );

    await orchestrator.shutdown();
    consoleDebugSpy.mockRestore();
  });
});
