import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/config";
import type { SDKStreamMessage } from "@/sdk-types";
import { ActivityLog } from "@/supervisor/activity-log";
import type { AgentRunner, AgentRunOptions } from "@/supervisor/ai-adapter";
import { EventQueue } from "@/supervisor/event-queue";
import { HeartbeatLoop } from "@/supervisor/heartbeat";
import type { SupervisorDaemonState } from "@/supervisor/schemas";

// ─── Mock Agent Runner ───────────────────────────────────

class MockAgentRunner implements AgentRunner {
  async *run(_options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "Done" }] },
    } as SDKStreamMessage;
    yield {
      type: "result",
      subtype: "success",
      session_id: "mock",
      result: "",
      total_cost_usd: 0.01,
      num_turns: 1,
    } as SDKStreamMessage;
  }
}

vi.mock("@/paths", () => ({
  getDataDir: () => "/tmp/heartbeat-skip-test/.neo",
  getRunsDir: () => "/tmp/heartbeat-skip-test/.neo/runs",
  getJournalsDir: () => "/tmp/heartbeat-skip-test/.neo/journals",
  getSupervisorsDir: () => "/tmp/heartbeat-skip-test/.neo/supervisors",
  toRepoSlug: () => "test-repo",
  getRepoRunsDir: () => "/tmp/heartbeat-skip-test/.neo/runs/test-repo",
}));

// ─── Test Setup ───────────────────────────────────────────

const TMP_DIR = "/tmp/heartbeat-skip-test";
const SUPERVISOR_DIR = path.join(TMP_DIR, "supervisor");
const STATE_PATH = path.join(SUPERVISOR_DIR, "state.json");
const EVENTS_PATH = path.join(SUPERVISOR_DIR, "events");

function createConfig(overrides?: Partial<GlobalConfig["supervisor"]>): GlobalConfig {
  return {
    repos: [],
    concurrency: { maxSessions: 5, maxPerRepo: 2, queueMax: 50 },
    budget: { dailyCapUsd: 100, alertThresholdPct: 80 },
    recovery: { maxRetries: 3, backoffBaseMs: 10 },
    sessions: { initTimeoutMs: 5_000, maxDurationMs: 60_000, dir: "/tmp/neo-sessions" },
    webhooks: [],
    supervisor: {
      port: 7777,
      heartbeatTimeoutMs: 300_000,
      maxConsecutiveFailures: 3,
      maxEventsPerSec: 10,
      dailyCapUsd: 50,
      consolidationIntervalMs: 300_000,
      compactionIntervalMs: 3_600_000,
      eventTimeoutMs: 300_000,
      idleSkipMax: 3,
      activeWorkSkipMax: 2,
      autoDecide: false,
      model: "claude-sonnet-4-5-20251001",
      ...overrides,
    },
    idempotency: { enabled: true, key: "prompt", ttlMs: 60_000 },
    memory: { embeddings: true },
    models: { default: "claude-sonnet-4-6" },
  };
}

async function createState(state: Partial<SupervisorDaemonState>): Promise<void> {
  const fullState: SupervisorDaemonState = {
    pid: process.pid,
    sessionId: "test-session",
    startedAt: new Date().toISOString(),
    port: 7777,
    cwd: "/tmp",
    status: "running",
    heartbeatCount: 0,
    lastHeartbeat: new Date().toISOString(),
    totalCostUsd: 0,
    todayCostUsd: 0,
    costResetDate: new Date().toISOString().slice(0, 10),
    lastConsolidationHeartbeat: 0,
    lastCompactionHeartbeat: 0,
    idleSkipCount: 0,
    activeWorkSkipCount: 0,
    ...state,
  };
  await writeFile(STATE_PATH, JSON.stringify(fullState, null, 2));
}

// ─── Setup / Teardown ─────────────────────────────────────

beforeEach(async () => {
  await mkdir(SUPERVISOR_DIR, { recursive: true });
  await mkdir(EVENTS_PATH, { recursive: true });
  await createState({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Integration Tests ────────────────────────────────────

describe("heartbeat skip integration", () => {
  describe("idle skip behavior", () => {
    it("skips heartbeat when idle and within idleSkipMax threshold", async () => {
      const config = createConfig({ idleSkipMax: 3 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      // Set state with idleSkipCount < idleSkipMax
      await createState({ idleSkipCount: 1 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // Access runHeartbeat via prototype (testing integration)
      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should have logged an idle skip message
      const skipLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("Idle skip"),
      );
      expect(skipLog).toBeDefined();
      expect(skipLog?.[1]).toContain("Idle skip #2/3");
    });

    it("does NOT skip heartbeat after idleSkipMax consecutive idle ticks", async () => {
      const config = createConfig({ idleSkipMax: 3 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      // Set state at threshold (should NOT skip)
      await createState({ idleSkipCount: 3 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should NOT have an idle skip log, should have heartbeat starting log
      const skipLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("Idle skip"),
      );
      expect(skipLog).toBeUndefined();

      const startLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("starting"),
      );
      expect(startLog).toBeDefined();
    });
  });

  describe("active work skip behavior", () => {
    it("does NOT skip heartbeat when hasActiveWork is true", async () => {
      const config = createConfig({ activeWorkSkipMax: 2 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      // Mock getActiveRuns to return active runs
      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // Mock active runs (simulate active work)
      // @ts-expect-error - mocking private method for testing
      vi.spyOn(loop, "getActiveRuns").mockResolvedValue(["run-1 [running] developer on test-repo"]);

      // activeWorkSkipCount at threshold - should NOT skip
      await createState({ activeWorkSkipCount: 2 });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should have heartbeat starting log (not skipped)
      const startLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("starting"),
      );
      expect(startLog).toBeDefined();
    });

    it("skips heartbeat when active runs exist and within activeWorkSkipMax", async () => {
      const config = createConfig({ activeWorkSkipMax: 2 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // Mock active runs
      // @ts-expect-error - mocking private method for testing
      vi.spyOn(loop, "getActiveRuns").mockResolvedValue(["run-1 [running] developer on test-repo"]);

      // activeWorkSkipCount below threshold - should skip
      await createState({ activeWorkSkipCount: 0 });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should have an active-work skip log
      const skipLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("Active-work skip"),
      );
      expect(skipLog).toBeDefined();
      expect(skipLog?.[1]).toContain("Active-work skip #1/2");
    });
  });

  describe("pending consolidation behavior", () => {
    it("does NOT skip heartbeat when hasPendingConsolidation is true", async () => {
      const config = createConfig({ idleSkipMax: 3 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      // Create unconsolidated log buffer entries
      const logBufferPath = path.join(SUPERVISOR_DIR, "log-buffer.jsonl");
      await writeFile(
        logBufferPath,
        `${JSON.stringify({
          id: "entry-1",
          timestamp: new Date().toISOString(),
          type: "observation",
          content: "test entry",
        })}\n`,
      );

      // Even with high idleSkipCount, should NOT skip due to pending consolidation
      await createState({ idleSkipCount: 10 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should have heartbeat starting log (not skipped)
      const startLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("starting"),
      );
      expect(startLog).toBeDefined();
    });
  });

  describe("expired decisions behavior", () => {
    it("does NOT skip heartbeat when hasExpiredDecisions is true", async () => {
      const config = createConfig({ idleSkipMax: 3 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      // Create expired decision
      const decisionsPath = path.join(SUPERVISOR_DIR, "decisions.jsonl");
      const expiredDecision = {
        id: "decision-1",
        question: "Should we proceed?",
        options: ["yes", "no"],
        default: "yes",
        createdAt: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour ago
        expiresAt: new Date(Date.now() - 60_000).toISOString(), // Expired 1 minute ago
      };
      await writeFile(decisionsPath, `${JSON.stringify(expiredDecision)}\n`);

      // Even with high idleSkipCount, should NOT skip due to expired decisions
      await createState({ idleSkipCount: 10 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should have heartbeat starting log (not skipped)
      const startLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("starting"),
      );
      expect(startLog).toBeDefined();
    });
  });

  describe("skip counter reset behavior", () => {
    it("resets skip counters after non-idle heartbeat", async () => {
      const config = createConfig({ idleSkipMax: 3 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });

      // Add an event to make it non-idle
      eventQueue.push({
        kind: "message",
        data: {
          id: "msg-1",
          from: "tui",
          text: "test event",
          timestamp: new Date().toISOString(),
        },
      });

      // Start with non-zero skip counts
      await createState({ idleSkipCount: 2, activeWorkSkipCount: 1 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Read state to verify counters were reset
      const { readFile } = await import("node:fs/promises");
      const stateContent = await readFile(STATE_PATH, "utf-8");
      const state = JSON.parse(stateContent) as SupervisorDaemonState;

      expect(state.idleSkipCount).toBe(0);
      expect(state.activeWorkSkipCount).toBe(0);
    });

    it("increments idleSkipCount when skipping in idle state", async () => {
      const config = createConfig({ idleSkipMax: 5 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });

      // Start with idleSkipCount = 2
      await createState({ idleSkipCount: 2 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Read state to verify counter was incremented
      const { readFile } = await import("node:fs/promises");
      const stateContent = await readFile(STATE_PATH, "utf-8");
      const state = JSON.parse(stateContent) as SupervisorDaemonState;

      expect(state.idleSkipCount).toBe(3);
      expect(state.activeWorkSkipCount).toBe(0);
    });

    it("increments activeWorkSkipCount when skipping with active runs", async () => {
      const config = createConfig({ activeWorkSkipMax: 5 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });

      // Start with activeWorkSkipCount = 1
      await createState({ activeWorkSkipCount: 1 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // Mock active runs
      // @ts-expect-error - mocking private method for testing
      vi.spyOn(loop, "getActiveRuns").mockResolvedValue(["run-1 [running] developer on test-repo"]);

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Read state to verify counter was incremented
      const { readFile } = await import("node:fs/promises");
      const stateContent = await readFile(STATE_PATH, "utf-8");
      const state = JSON.parse(stateContent) as SupervisorDaemonState;

      expect(state.activeWorkSkipCount).toBe(2);
      expect(state.idleSkipCount).toBe(0);
    });
  });

  describe("events pending behavior", () => {
    it("does NOT skip heartbeat when events are pending", async () => {
      const config = createConfig({ idleSkipMax: 1 });
      const activityLog = new ActivityLog(SUPERVISOR_DIR);
      const eventQueue = new EventQueue({ maxEventsPerSec: 10 });
      const logSpy = vi.spyOn(activityLog, "log");

      // Add events to the queue
      eventQueue.push({
        kind: "message",
        data: {
          id: "msg-2",
          from: "tui",
          text: "important message",
          timestamp: new Date().toISOString(),
        },
      });

      // Even with idleSkipCount at max, should NOT skip due to pending events
      await createState({ idleSkipCount: 10 });

      const loop = new HeartbeatLoop({
        config,
        supervisorDir: SUPERVISOR_DIR,
        statePath: STATE_PATH,
        sessionId: "test-session",
        eventQueue,
        activityLog,
        eventsPath: EVENTS_PATH,
        adapter: new MockAgentRunner(),
      });

      // @ts-expect-error - accessing private method for testing
      await loop.runHeartbeat();

      // Should have heartbeat starting log (not skipped)
      const startLog = logSpy.mock.calls.find(
        (call) => call[0] === "heartbeat" && String(call[1]).includes("starting"),
      );
      expect(startLog).toBeDefined();
    });
  });
});
