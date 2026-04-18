import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NeoConfig,
  NeoEvent,
  ResolvedAgent,
  SessionCompleteEvent,
  SessionStartEvent,
} from "@/index";
import { Orchestrator } from "@/orchestrator";
import {
  cleanupTestRepo,
  createTestFile,
  createTestRepo,
  MockWebhookServer,
  type WebhookPayload,
} from "./fixtures/e2e-setup.js";

// ─── Session Mock (dry-run mode) ─────────────────────────

let mockCallCounter = 0;

// Mock the session module directly to avoid flaky dynamic import issues with SDK mock
// This provides more reliable isolation as runSession is imported statically
vi.mock("@/runner/session", () => ({
  runSession: async () => {
    const callId = ++mockCallCounter;
    const uniqueSessionId = `e2e-session-${callId}-${Date.now()}`;
    return {
      sessionId: uniqueSessionId,
      output: "E2E task completed successfully",
      costUsd: 0.02,
      durationMs: 500,
      turnCount: 2,
    };
  },
  SessionError: class SessionError extends Error {
    constructor(
      message: string,
      public readonly errorType: string,
      public readonly sessionId: string,
    ) {
      super(message);
      this.name = "SessionError";
    }
  },
}));

// ─── Git/Clone Mocks ─────────────────────────────────────

vi.mock("@/isolation/clone", () => ({
  createSessionClone: (options: {
    repoPath: string;
    branch: string;
    baseBranch: string;
    sessionDir: string;
  }) =>
    Promise.resolve({
      // Use the unique sessionDir passed by orchestrator to avoid race conditions
      // when concurrent dispatches share the same mock path
      path: options.sessionDir,
      branch: options.branch,
      repoPath: options.sessionDir,
    }),
  removeSessionClone: () => Promise.resolve(undefined),
  listSessionClones: () => Promise.resolve([]),
  validateGitRef: () => undefined,
}));

vi.mock("@/isolation/git", () => ({
  pushSessionBranch: () => Promise.resolve(undefined),
}));

// Mock MemoryStore to avoid SQLite race conditions in concurrent tests
vi.mock("@/supervisor/memory/index.js", () => ({
  MemoryStore: class MockMemoryStore {
    query() {
      return [];
    }
    markAccessed() {
      // No-op
    }
  },
  formatMemoriesForPrompt: () => undefined,
}));

// ─── Test directories ────────────────────────────────────

const TMP_BASE = path.join(import.meta.dirname, "__tmp_orchestrator_e2e__");
const TEST_REPO_DIR = path.join(TMP_BASE, "test-repo");
const GLOBAL_DATA_DIR = path.join(TMP_BASE, ".neo-global");
const GLOBAL_RUNS_DIR = path.join(GLOBAL_DATA_DIR, "runs");
const GLOBAL_JOURNALS_DIR = path.join(GLOBAL_DATA_DIR, "journals");
const SESSIONS_DIR = path.join(TMP_BASE, "sessions");

vi.mock("@/paths", async () => {
  const p = await import("node:path");
  const base = p.join(import.meta.dirname, "__tmp_orchestrator_e2e__");
  const dataDir = p.join(base, ".neo-global");
  return {
    getDataDir: () => dataDir,
    getJournalsDir: () => p.join(dataDir, "journals"),
    getRunsDir: () => p.join(dataDir, "runs"),
    toRepoSlug: (repo: { name?: string; path: string }) => {
      const raw = repo.name ?? p.basename(repo.path);
      return raw
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    },
    getRepoRunsDir: (slug: string) => p.join(dataDir, "runs", slug),
    getSupervisorsDir: () => p.join(dataDir, "supervisors"),
  };
});

// ─── Helpers ─────────────────────────────────────────────

function makeConfig(repoPath: string): NeoConfig {
  return {
    repos: [
      {
        path: repoPath,
        defaultBranch: "main",
        branchPrefix: "feat",
        pushRemote: "origin",
        gitStrategy: "branch",
      },
    ],
    concurrency: { maxSessions: 5, maxPerRepo: 2, queueMax: 50 },
    budget: { dailyCapUsd: 100, alertThresholdPct: 80 },
    recovery: { maxRetries: 1, backoffBaseMs: 10 },
    sessions: { initTimeoutMs: 5_000, maxDurationMs: 60_000, dir: SESSIONS_DIR },
    webhooks: [],
    idempotency: { enabled: false, key: "prompt", ttlMs: 60_000 },
    supervisor: {
      port: 7777,
      heartbeatTimeoutMs: 300_000,
      maxConsecutiveFailures: 3,
      maxEventsPerSec: 10,
      dailyCapUsd: 50,
      consolidationIntervalMs: 300_000,
      compactionIntervalMs: 3_600_000,
      eventTimeoutMs: 300_000,
      idleSkipMax: 20,
      activeWorkSkipMax: 3,
      autoDecide: false,
      model: "claude-sonnet-4-5-20251001",
    },
    memory: { embeddings: true },
    models: { default: "claude-sonnet-4-6" },
  };
}

function makeAgent(): ResolvedAgent {
  return {
    name: "e2e-developer",
    definition: {
      description: "E2E test developer agent",
      prompt: "You are a test agent for E2E testing.",
      model: "claude-sonnet-4-6",
    },
    sandbox: "writable",
    source: "built-in",
  };
}

// ─── Setup / Teardown ────────────────────────────────────

beforeEach(async () => {
  mockCallCounter = 0; // Reset counter for consistent test isolation

  // Create all required directories
  await mkdir(TMP_BASE, { recursive: true });
  await mkdir(GLOBAL_DATA_DIR, { recursive: true });
  await mkdir(GLOBAL_RUNS_DIR, { recursive: true });
  await mkdir(GLOBAL_JOURNALS_DIR, { recursive: true });
  await mkdir(SESSIONS_DIR, { recursive: true });

  // Create a real git repository for E2E testing
  await createTestRepo(TEST_REPO_DIR);
  await createTestFile(TEST_REPO_DIR, "README.md", "# E2E Test Repository\n");
});

afterEach(async () => {
  // Clean up all test directories
  await cleanupTestRepo(TEST_REPO_DIR);
  await rm(TMP_BASE, { recursive: true, force: true });
});

// ─── E2E Tests: Orchestrator Happy Path ──────────────────

describe("orchestrator E2E: happy path lifecycle", () => {
  it("completes full lifecycle: init → running → complete", async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    // Track status transitions via events
    const statusTransitions: string[] = [];
    const events: NeoEvent[] = [];

    orchestrator.on("session:start", (e) => {
      statusTransitions.push("running");
      events.push(e);
    });

    orchestrator.on("session:complete", (e) => {
      statusTransitions.push("complete");
      events.push(e);
    });

    // Start orchestrator
    await orchestrator.start();
    statusTransitions.push("init");

    // Dispatch a task
    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Create a hello world function",
      branch: "feat/e2e-test",
    });

    // Verify status transitions occurred in correct order
    expect(statusTransitions).toEqual(["init", "running", "complete"]);

    // Verify task result
    expect(result.status).toBe("success");
    expect(result.agent).toBe("e2e-developer");
    expect(result.repo).toBe(TEST_REPO_DIR);
    expect(result.runId).toBeDefined();
    expect(result.costUsd).toBe(0.02);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify step result
    const executeStep = result.steps.execute;
    expect(executeStep).toBeDefined();
    expect(executeStep?.status).toBe("success");
    expect(executeStep?.agent).toBe("e2e-developer");
    expect(executeStep?.costUsd).toBe(0.02);

    // Verify events were emitted correctly
    const startEvent = events.find((e) => e.type === "session:start");
    const completeEvent = events.find((e) => e.type === "session:complete");

    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();

    if (startEvent?.type === "session:start") {
      expect(startEvent.agent).toBe("e2e-developer");
      expect(startEvent.agent).toBe("e2e-developer");
      expect(startEvent.repo).toBe(TEST_REPO_DIR);
    }

    if (completeEvent?.type === "session:complete") {
      expect(completeEvent.status).toBe("success");
      expect(completeEvent.runId).toBe(result.runId);
    }

    // Cleanup
    await orchestrator.shutdown();
  });

  it("properly cleans up session after completion", async () => {
    const cloneMod = await import("@/isolation/clone");
    const removeCloneSpy = vi.spyOn(cloneMod, "removeSessionClone");

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test cleanup",
      branch: "feat/e2e-cleanup",
    });

    // Verify cleanup was called
    expect(removeCloneSpy).toHaveBeenCalled();

    // Verify no active sessions remain
    expect(orchestrator.activeSessions).toHaveLength(0);

    await orchestrator.shutdown();
  });

  it("tracks cost correctly through the lifecycle", async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const costEvents: NeoEvent[] = [];
    orchestrator.on("cost:update", (e) => costEvents.push(e));

    await orchestrator.start();

    // Initial cost should be 0
    expect(orchestrator.status.costToday).toBe(0);

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test cost tracking",
      branch: "feat/e2e-cost",
    });

    // Cost should be updated
    expect(orchestrator.status.costToday).toBe(0.02);

    // Verify cost event was emitted
    expect(costEvents).toHaveLength(1);
    const costEvent = costEvents[0];
    if (costEvent?.type === "cost:update") {
      expect(costEvent.sessionCost).toBe(0.02);
      expect(costEvent.todayTotal).toBe(0.02);
    }

    await orchestrator.shutdown();
  });

  it("maintains correct orchestrator status throughout lifecycle", async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    // Before start
    const initialStatus = orchestrator.status;
    expect(initialStatus.paused).toBe(false);
    expect(initialStatus.activeSessions).toHaveLength(0);
    expect(initialStatus.queueDepth).toBe(0);
    expect(initialStatus.costToday).toBe(0);
    expect(initialStatus.uptime).toBe(0);

    // After start
    await orchestrator.start();
    // Small delay to allow uptime to increase
    await new Promise((resolve) => setTimeout(resolve, 10));

    const runningStatus = orchestrator.status;
    expect(runningStatus.paused).toBe(false);
    expect(runningStatus.uptime).toBeGreaterThan(0);

    // After dispatch
    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test status",
      branch: "feat/e2e-status",
    });

    const afterDispatchStatus = orchestrator.status;
    expect(afterDispatchStatus.activeSessions).toHaveLength(0);
    expect(afterDispatchStatus.costToday).toBe(0.02);

    // After shutdown
    await orchestrator.shutdown();
    expect(orchestrator.status.paused).toBe(true);
  });

  it("handles multiple sequential dispatches correctly", async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    // First dispatch
    const result1 = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "First task",
      branch: "feat/e2e-first",
    });

    // Second dispatch
    const result2 = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Second task",
      branch: "feat/e2e-second",
    });

    // Both should succeed
    expect(result1.status).toBe("success");
    expect(result2.status).toBe("success");

    // Should have different runIds
    expect(result1.runId).not.toBe(result2.runId);

    // Cost should accumulate
    expect(orchestrator.status.costToday).toBe(0.04);

    await orchestrator.shutdown();
  });
});

// ─── E2E Tests: Concurrent Run Handling ───────────────────

describe("orchestrator E2E: concurrent run handling", () => {
  beforeEach(() => {
    // Reset mocks for concurrent tests - use real timers
    vi.useRealTimers();
  });

  it("handles concurrent dispatches with isolated state and accumulated cost", {
    timeout: 15000,
  }, async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    // Track events per run
    const eventsByRun = new Map<string, NeoEvent[]>();
    const costEvents: NeoEvent[] = [];

    orchestrator.on("session:start", (e) => {
      const event = e as SessionStartEvent;
      const events = eventsByRun.get(event.runId) ?? [];
      events.push(event);
      eventsByRun.set(event.runId, events);
    });

    orchestrator.on("session:complete", (e) => {
      const event = e as SessionCompleteEvent;
      const events = eventsByRun.get(event.runId) ?? [];
      events.push(event);
      eventsByRun.set(event.runId, events);
    });

    orchestrator.on("cost:update", (e) => costEvents.push(e));

    await orchestrator.start();

    // Initial cost should be 0
    expect(orchestrator.status.costToday).toBe(0);

    // Dispatch 2 concurrent runs with distinct metadata
    const [result1, result2] = await Promise.all([
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Concurrent task 1",
        branch: "feat/concurrent-1",
        metadata: { taskId: "task-1" },
      }),
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Concurrent task 2",
        branch: "feat/concurrent-2",
        metadata: { taskId: "task-2" },
      }),
    ]);

    // Both should succeed with unique runIds
    expect(result1.status).toBe("success");
    expect(result2.status).toBe("success");
    expect(result1.runId).not.toBe(result2.runId);

    // Verify run isolation - each has its own events
    const run1Events = eventsByRun.get(result1.runId) ?? [];
    const run2Events = eventsByRun.get(result2.runId) ?? [];
    expect(run1Events).toHaveLength(2);
    expect(run2Events).toHaveLength(2);

    // Verify metadata isolation
    expect(result1.metadata?.taskId).toBe("task-1");
    expect(result2.metadata?.taskId).toBe("task-2");

    // Verify concurrent budget tracking - total cost 2 * 0.02 = 0.04
    expect(orchestrator.status.costToday).toBe(0.04);
    expect(costEvents).toHaveLength(2);

    // Verify accumulated totals
    const todayTotals = costEvents
      .filter((e): e is Extract<NeoEvent, { type: "cost:update" }> => e.type === "cost:update")
      .map((e) => e.todayTotal)
      .sort((a, b) => a - b);
    expect(todayTotals).toEqual([0.02, 0.04]);

    await orchestrator.shutdown();
  });

  it("allows status queries during execution and verifies final state", {
    timeout: 30000,
  }, async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const completedRuns: string[] = [];

    // Attach listener BEFORE any async operations to avoid race conditions
    // across Node versions where event emission timing may differ
    orchestrator.on("session:complete", (e) => {
      completedRuns.push((e as SessionCompleteEvent).runId);
    });

    await orchestrator.start();

    // Query status before dispatch
    expect(orchestrator.status.activeSessions).toHaveLength(0);
    expect(orchestrator.status.queueDepth).toBe(0);
    expect(orchestrator.status.costToday).toBe(0);

    // Dispatch concurrent runs - dispatch() returns only after session:complete is emitted
    // so we don't need a separate promise to wait for events
    const [result1, result2] = await Promise.all([
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Status task 1",
        branch: "feat/status-1",
      }),
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Status task 2",
        branch: "feat/status-2",
      }),
    ]);

    // Allow microtask queue to flush for any pending event callbacks
    await new Promise((resolve) => setImmediate(resolve));

    // Verify both completed
    expect(result1.status).toBe("success");
    expect(result2.status).toBe("success");
    expect(completedRuns).toHaveLength(2);

    // Verify final state
    expect(orchestrator.status.activeSessions).toHaveLength(0);
    expect(orchestrator.status.queueDepth).toBe(0);
    expect(orchestrator.status.costToday).toBe(0.04);

    await orchestrator.shutdown();
  });

  it("runs complete independently without affecting each other", { timeout: 30000 }, async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const completedRuns: string[] = [];

    // Attach listener BEFORE any async operations to avoid race conditions
    // on Node 22 where event emission timing may differ from Node 24
    orchestrator.on("session:complete", (e) => {
      completedRuns.push((e as SessionCompleteEvent).runId);
    });

    await orchestrator.start();

    // Dispatch concurrent runs - dispatch() returns only after session:complete is emitted
    // so we don't need a separate promise to wait for events
    const [result1, result2] = await Promise.all([
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Independent task 1",
        branch: "feat/indep-1",
      }),
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Independent task 2",
        branch: "feat/indep-2",
      }),
    ]);

    // Allow microtask queue to flush for any pending event callbacks
    await new Promise((resolve) => setImmediate(resolve));

    // Both complete successfully
    expect(result1.status).toBe("success");
    expect(result2.status).toBe("success");
    expect(completedRuns).toHaveLength(2);
    expect(completedRuns).toContain(result1.runId);
    expect(completedRuns).toContain(result2.runId);

    await orchestrator.shutdown();
  });

  it("emits events in correct order for each run", { timeout: 30000 }, async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const allEvents: Array<{ type: string; runId: string }> = [];

    // Attach listeners BEFORE any async operations to avoid race conditions
    // on Node 24 where event emission timing may differ
    orchestrator.on("session:start", (e) => {
      allEvents.push({ type: "session:start", runId: (e as SessionStartEvent).runId });
    });

    orchestrator.on("session:complete", (e) => {
      allEvents.push({ type: "session:complete", runId: (e as SessionCompleteEvent).runId });
    });

    await orchestrator.start();

    // Dispatch concurrent runs - dispatch() returns only after session:complete is emitted
    // so we don't need a separate promise to wait for events
    const [result1, result2] = await Promise.all([
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Order task 1",
        branch: "feat/order-1",
      }),
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Order task 2",
        branch: "feat/order-2",
      }),
    ]);

    // Allow microtask queue to flush for any pending event callbacks
    await new Promise((resolve) => setImmediate(resolve));

    // Should have 4 events (2 starts + 2 completes)
    expect(allEvents).toHaveLength(4);

    // For each run, start should come before complete
    const runIds = [...new Set(allEvents.map((e) => e.runId))];
    expect(runIds).toHaveLength(2);
    expect(runIds).toContain(result1.runId);
    expect(runIds).toContain(result2.runId);

    for (const runId of runIds) {
      const runEvents = allEvents.filter((e) => e.runId === runId);
      const startIdx = runEvents.findIndex((e) => e.type === "session:start");
      const completeIdx = runEvents.findIndex((e) => e.type === "session:complete");
      expect(startIdx).toBeLessThan(completeIdx);
    }

    await orchestrator.shutdown();
  });
});

// ─── E2E Tests: Webhook Delivery Verification ─────────────

describe("orchestrator E2E: webhook delivery verification", () => {
  let webhookServer: MockWebhookServer;

  beforeEach(async () => {
    vi.useRealTimers();

    webhookServer = new MockWebhookServer();
    await webhookServer.start();
  });

  afterEach(async () => {
    await webhookServer.stop();
  });

  function makeConfigWithWebhook(
    repoPath: string,
    webhookUrl: string,
    events?: string[],
  ): NeoConfig {
    return {
      repos: [
        {
          path: repoPath,
          defaultBranch: "main",
          branchPrefix: "feat",
          pushRemote: "origin",
          gitStrategy: "branch",
        },
      ],
      concurrency: { maxSessions: 5, maxPerRepo: 2, queueMax: 50 },
      budget: { dailyCapUsd: 100, alertThresholdPct: 80 },
      recovery: { maxRetries: 1, backoffBaseMs: 10 },
      sessions: { initTimeoutMs: 5_000, maxDurationMs: 60_000, dir: SESSIONS_DIR },
      webhooks: [
        {
          url: webhookUrl,
          events,
          timeoutMs: 5000,
        },
      ],
      idempotency: { enabled: false, key: "prompt", ttlMs: 60_000 },
      supervisor: {
        port: 7777,
        heartbeatTimeoutMs: 300_000,
        maxConsecutiveFailures: 3,
        maxEventsPerSec: 10,
        dailyCapUsd: 50,
        consolidationIntervalMs: 300_000,
        compactionIntervalMs: 3_600_000,
        eventTimeoutMs: 300_000,
        idleSkipMax: 20,
        activeWorkSkipMax: 3,
        autoDecide: false,
        model: "claude-sonnet-4-5-20251001",
      },
      memory: { embeddings: true },
      models: { default: "claude-sonnet-4-6" },
    };
  }

  it("delivers webhooks on session:start", { timeout: 15000 }, async () => {
    const webhookUrl = `http://127.0.0.1:${webhookServer.getPort()}`;
    const orchestrator = new Orchestrator(
      makeConfigWithWebhook(TEST_REPO_DIR, webhookUrl, ["session:start"]),
      { skipOrphanRecovery: true },
    );
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test webhook on start",
      branch: "feat/webhook-start",
    });

    // Allow time for webhook delivery
    await new Promise((resolve) => setTimeout(resolve, 100));

    const webhooks = webhookServer.getReceivedWebhooks();
    expect(webhooks.length).toBeGreaterThanOrEqual(1);

    const startWebhook = webhooks.find((w) => w.payload.event === "session:start");
    expect(startWebhook).toBeDefined();
    expect(startWebhook?.payload.source).toBe("neo");
    expect(startWebhook?.payload.version).toBe(1);
    expect(startWebhook?.payload.payload.agent).toBe("e2e-developer");
    expect(startWebhook?.payload.payload.agent).toBe("e2e-developer");

    await orchestrator.shutdown();
  });

  it("delivers webhooks on session:complete with correct payload", { timeout: 15000 }, async () => {
    const webhookUrl = `http://127.0.0.1:${webhookServer.getPort()}`;
    const orchestrator = new Orchestrator(
      makeConfigWithWebhook(TEST_REPO_DIR, webhookUrl, ["session:complete"]),
      { skipOrphanRecovery: true },
    );
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test webhook on complete",
      branch: "feat/webhook-complete",
    });

    // Flush pending webhook deliveries
    await orchestrator.shutdown();

    const webhooks = webhookServer.getReceivedWebhooks();
    expect(webhooks.length).toBeGreaterThanOrEqual(1);

    const completeWebhook = webhooks.find((w) => w.payload.event === "session:complete");
    expect(completeWebhook).toBeDefined();

    const payload = completeWebhook?.payload as WebhookPayload;
    expect(payload.source).toBe("neo");
    expect(payload.version).toBe(1);
    expect(payload.id).toBeDefined();
    expect(payload.deliveredAt).toBeDefined();

    // Verify session:complete payload structure
    const eventPayload = payload.payload as Record<string, unknown>;
    expect(eventPayload.runId).toBe(result.runId);
    expect(eventPayload.status).toBe("success");
    expect(typeof eventPayload.costUsd).toBe("number");
    expect(typeof eventPayload.durationMs).toBe("number");
    expect(eventPayload.timestamp).toBeDefined();
  });

  it("retries webhook on temporary failure (503)", { timeout: 30000 }, async () => {
    // Configure server to fail twice, then succeed
    webhookServer.setBehavior({ statusCode: 503, failCount: 2 });

    const webhookUrl = `http://127.0.0.1:${webhookServer.getPort()}`;
    const orchestrator = new Orchestrator(
      makeConfigWithWebhook(TEST_REPO_DIR, webhookUrl, ["session:complete"]),
      { skipOrphanRecovery: true },
    );
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test webhook retry",
      branch: "feat/webhook-retry",
    });

    // Flush pending webhook deliveries (waits for retries)
    await orchestrator.shutdown();

    // Should have received 3 requests total (2 failures + 1 success)
    expect(webhookServer.getTotalRequestCount()).toBe(3);

    // The successful webhook should be captured
    const webhooks = webhookServer.getReceivedWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.payload.event).toBe("session:complete");
  });

  it("gives up after max retries", { timeout: 30000 }, async () => {
    // Configure server to always fail (fail count > max retries)
    webhookServer.setBehavior({ statusCode: 503, failCount: 10 });

    const webhookUrl = `http://127.0.0.1:${webhookServer.getPort()}`;
    const orchestrator = new Orchestrator(
      makeConfigWithWebhook(TEST_REPO_DIR, webhookUrl, ["session:complete"]),
      { skipOrphanRecovery: true },
    );
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test webhook max retries",
      branch: "feat/webhook-max-retry",
    });

    // Flush pending webhook deliveries
    await orchestrator.shutdown();

    // Should have attempted 3 times (RETRY_MAX_ATTEMPTS from webhook.ts)
    expect(webhookServer.getTotalRequestCount()).toBe(3);

    // No successful webhooks captured
    const webhooks = webhookServer.getReceivedWebhooks();
    expect(webhooks).toHaveLength(0);
  });

  it("webhook payload structure matches expected schema", { timeout: 15000 }, async () => {
    const webhookUrl = `http://127.0.0.1:${webhookServer.getPort()}`;
    // Subscribe to all events to verify different payload types
    const orchestrator = new Orchestrator(makeConfigWithWebhook(TEST_REPO_DIR, webhookUrl), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test webhook schema",
      branch: "feat/webhook-schema",
      metadata: { testId: "schema-test" },
    });

    await orchestrator.shutdown();

    const webhooks = webhookServer.getReceivedWebhooks();
    expect(webhooks.length).toBeGreaterThan(0);

    // Verify all webhooks have the required top-level structure
    for (const webhook of webhooks) {
      const payload = webhook.payload;

      // Top-level structure
      expect(payload.id).toBeDefined();
      expect(typeof payload.id).toBe("string");
      expect(payload.version).toBe(1);
      expect(payload.event).toBeDefined();
      expect(typeof payload.event).toBe("string");
      expect(payload.source).toBe("neo");
      expect(payload.deliveredAt).toBeDefined();
      expect(typeof payload.deliveredAt).toBe("string");
      expect(payload.payload).toBeDefined();
      expect(typeof payload.payload).toBe("object");

      // Event payload should have type matching the event name
      expect(payload.payload.type).toBe(payload.event);
      expect(payload.payload.timestamp).toBeDefined();
    }

    // Find specific events and verify their structure
    const startPayload = webhooks.find((w) => w.payload.event === "session:start")?.payload.payload;
    if (startPayload) {
      expect(startPayload.sessionId).toBeDefined();
      expect(startPayload.runId).toBeDefined();
      expect(startPayload.agent).toBe("e2e-developer");
      expect(startPayload.agent).toBe("e2e-developer");
      expect(startPayload.repo).toBe(TEST_REPO_DIR);
      expect(startPayload.metadata).toEqual({ testId: "schema-test" });
    }

    const completePayload = webhooks.find((w) => w.payload.event === "session:complete")?.payload
      .payload;
    if (completePayload) {
      expect(completePayload.sessionId).toBeDefined();
      expect(completePayload.runId).toBeDefined();
      expect(completePayload.status).toBe("success");
      expect(typeof completePayload.costUsd).toBe("number");
      expect(typeof completePayload.durationMs).toBe("number");
    }

    const costPayload = webhooks.find((w) => w.payload.event === "cost:update")?.payload.payload;
    if (costPayload) {
      expect(costPayload.sessionId).toBeDefined();
      expect(typeof costPayload.sessionCost).toBe("number");
      expect(typeof costPayload.todayTotal).toBe("number");
      expect(typeof costPayload.budgetRemainingPct).toBe("number");
    }
  });

  it("delivers webhooks to MockWebhookServer correctly using full pattern", {
    timeout: 15000,
  }, async () => {
    // This test validates the recommended pattern from T3 context:
    // create test repo → configure webhook URL to MockWebhookServer → run orchestrator → verify

    const webhookUrl = `http://127.0.0.1:${webhookServer.getPort()}`;
    const orchestrator = new Orchestrator(
      makeConfigWithWebhook(TEST_REPO_DIR, webhookUrl, ["session:start", "session:complete"]),
      { skipOrphanRecovery: true },
    );
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Full pattern test",
      branch: "feat/full-pattern",
    });

    await orchestrator.shutdown();

    // Verify webhooks using getReceivedWebhooks()
    const webhooks = webhookServer.getReceivedWebhooks();

    // Should have both session:start and session:complete
    const eventTypes = webhooks.map((w) => w.payload.event);
    expect(eventTypes).toContain("session:start");
    expect(eventTypes).toContain("session:complete");

    // Verify the runId matches across events
    const runIds = webhooks.map((w) => w.payload.payload.runId as string);
    const uniqueRunIds = [...new Set(runIds)];
    expect(uniqueRunIds).toHaveLength(1);
    expect(uniqueRunIds[0]).toBe(result.runId);

    // Verify reset() works
    webhookServer.reset();
    expect(webhookServer.getReceivedWebhooks()).toHaveLength(0);
    expect(webhookServer.getTotalRequestCount()).toBe(0);
  });
});
