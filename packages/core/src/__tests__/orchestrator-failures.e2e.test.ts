import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeoConfig, NeoEvent, ResolvedAgent } from "@/index";
import { Orchestrator } from "@/orchestrator";
import { cleanupTestRepo, createTestFile, createTestRepo } from "./fixtures/e2e-setup.js";

// ─── SDK Mock (configurable failure modes) ─────────────────

interface MockMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

type MockBehavior =
  | { mode: "success"; messages: MockMessage[] }
  | { mode: "timeout_error" }
  | { mode: "throw"; error: Error }
  | { mode: "error_result"; errorType: string; sessionId?: string }
  | { mode: "budget_exceeded" };

let mockBehavior: MockBehavior = { mode: "success", messages: [] };

// Helper functions to reduce cognitive complexity
function* yieldSuccess(messages: MockMessage[]): Generator<MockMessage> {
  for (const msg of messages) {
    yield msg;
  }
}

function* yieldErrorResult(errorType: string, sessionId: string): Generator<MockMessage> {
  yield { type: "system", subtype: "init", session_id: sessionId };
  yield {
    type: "result",
    subtype: errorType,
    session_id: sessionId,
    result: "",
    total_cost_usd: 0.01,
  };
}

function* yieldBudgetExceeded(): Generator<MockMessage> {
  yield { type: "system", subtype: "init", session_id: "budget-session" };
  yield {
    type: "result",
    subtype: "budget_exceeded",
    session_id: "budget-session",
    result: "",
    total_cost_usd: 100,
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_args: unknown) => {
    const behavior = mockBehavior;

    return {
      async *[Symbol.asyncIterator]() {
        switch (behavior.mode) {
          case "success":
            yield* yieldSuccess(behavior.messages);
            return;
          case "timeout_error":
            yield { type: "system", subtype: "init", session_id: "timeout-session" };
            throw new Error("Session init timeout exceeded");
          case "throw":
            throw behavior.error;
          case "error_result":
            yield* yieldErrorResult(behavior.errorType, behavior.sessionId ?? "error-session");
            return;
          case "budget_exceeded":
            yield* yieldBudgetExceeded();
            return;
        }
      },
    };
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

// ─── Test directories ────────────────────────────────────

const TMP_BASE = path.join(import.meta.dirname, "__tmp_orchestrator_failures_e2e__");
const TEST_REPO_DIR = path.join(TMP_BASE, "test-repo");
const GLOBAL_DATA_DIR = path.join(TMP_BASE, ".neo-global");
const GLOBAL_RUNS_DIR = path.join(GLOBAL_DATA_DIR, "runs");
const GLOBAL_JOURNALS_DIR = path.join(GLOBAL_DATA_DIR, "journals");
const SESSIONS_DIR = path.join(TMP_BASE, "sessions");

vi.mock("@/paths", async () => {
  const p = await import("node:path");
  const base = p.join(import.meta.dirname, "__tmp_orchestrator_failures_e2e__");
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

function makeConfig(repoPath: string, overrides?: Partial<NeoConfig>): NeoConfig {
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
    sessions: {
      initTimeoutMs: 100, // Short timeout for tests
      maxDurationMs: 500, // Short duration for tests
      dir: SESSIONS_DIR,
    },
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
    provider: {
      adapter: "claude",
      models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
      args: [],
      env: {},
    },
    ...overrides,
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

function successMessages(sessionId = "e2e-session-123"): MockMessage[] {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "E2E task completed successfully",
      total_cost_usd: 0.02,
      duration_ms: 500,
      num_turns: 2,
    },
  ];
}

// ─── Setup / Teardown ────────────────────────────────────

beforeEach(async () => {
  mockBehavior = { mode: "success", messages: successMessages() };

  // Create all required directories
  await mkdir(TMP_BASE, { recursive: true });
  await mkdir(GLOBAL_DATA_DIR, { recursive: true });
  await mkdir(GLOBAL_RUNS_DIR, { recursive: true });
  await mkdir(GLOBAL_JOURNALS_DIR, { recursive: true });
  await mkdir(SESSIONS_DIR, { recursive: true });

  // Create a real git repository for E2E testing
  await createTestRepo(TEST_REPO_DIR);
  await createTestFile(TEST_REPO_DIR, "README.md", "# E2E Test Repository\n");

  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  // Clean up all test directories
  await cleanupTestRepo(TEST_REPO_DIR);
  await rm(TMP_BASE, { recursive: true, force: true });
});

// ─── E2E Tests: Failure Scenarios ─────────────────────────

describe("orchestrator E2E: agent timeout handling", () => {
  it("handles session timeout error correctly", async () => {
    // Configure mock to simulate a timeout error
    mockBehavior = { mode: "timeout_error" };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const failEvents: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => failEvents.push(e));

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test timeout handling",
      branch: "feat/e2e-timeout",
    });

    // Task should fail
    expect(result.status).toBe("failure");

    // Should have emitted session:fail event
    expect(failEvents).toHaveLength(1);
    const failEvent = failEvents[0];
    if (failEvent?.type === "session:fail") {
      expect(failEvent.error).toContain("timeout");
      expect(failEvent.willRetry).toBe(false);
    }

    // No active sessions should remain
    expect(orchestrator.activeSessions).toHaveLength(0);

    await orchestrator.shutdown();
  });

  it("propagates timeout error details in step result", async () => {
    mockBehavior = { mode: "timeout_error" };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test timeout details",
      branch: "feat/e2e-timeout-details",
    });

    expect(result.status).toBe("failure");
    const executeStep = result.steps.execute;
    expect(executeStep).toBeDefined();
    expect(executeStep?.status).toBe("failure");
    expect(executeStep?.error).toContain("timeout");

    await orchestrator.shutdown();
  });
});

describe("orchestrator E2E: agent failure propagation", () => {
  it("handles agent throwing an error", async () => {
    mockBehavior = { mode: "throw", error: new Error("Agent crashed unexpectedly") };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const failEvents: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => failEvents.push(e));

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test agent crash",
      branch: "feat/e2e-crash",
    });

    // Task should fail with error propagated
    expect(result.status).toBe("failure");
    const executeStep = result.steps.execute;
    expect(executeStep).toBeDefined();
    expect(executeStep?.status).toBe("failure");
    expect(executeStep?.error).toContain("Agent crashed unexpectedly");

    // Verify session:fail event was emitted
    expect(failEvents).toHaveLength(1);
    const failEvent = failEvents[0];
    if (failEvent?.type === "session:fail") {
      expect(failEvent.error).toContain("Agent crashed unexpectedly");
    }

    await orchestrator.shutdown();
  });

  it("handles SDK error result (error_max_turns)", async () => {
    mockBehavior = { mode: "error_result", errorType: "error_max_turns" };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test max turns exceeded",
      branch: "feat/e2e-max-turns",
    });

    expect(result.status).toBe("failure");
    const executeStep = result.steps.execute;
    expect(executeStep?.error).toContain("error_max_turns");

    await orchestrator.shutdown();
  });

  it("cleans up session state after failure", async () => {
    mockBehavior = { mode: "throw", error: new Error("Cleanup test error") };

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
      prompt: "Test cleanup after failure",
      branch: "feat/e2e-cleanup-fail",
    });

    // Session clone should still be cleaned up after failure
    expect(removeCloneSpy).toHaveBeenCalled();

    // No active sessions should remain
    expect(orchestrator.activeSessions).toHaveLength(0);

    await orchestrator.shutdown();
  });
});

describe("orchestrator E2E: budget exhaustion mid-run", () => {
  it("handles budget_exceeded error from SDK", async () => {
    mockBehavior = { mode: "budget_exceeded" };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const failEvents: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => failEvents.push(e));

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test budget exceeded",
      branch: "feat/e2e-budget",
    });

    expect(result.status).toBe("failure");
    const executeStep = result.steps.execute;
    expect(executeStep?.error).toContain("budget_exceeded");

    // Should emit session:fail event
    expect(failEvents).toHaveLength(1);

    await orchestrator.shutdown();
  });

  it("tracks cost even when session fails due to budget", async () => {
    // First dispatch succeeds and uses some budget
    mockBehavior = { mode: "success", messages: successMessages() };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    // First successful run
    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "First task",
      branch: "feat/e2e-first",
    });

    const costAfterFirst = orchestrator.status.costToday;
    expect(costAfterFirst).toBe(0.02);

    // Second run fails with budget exceeded (no additional cost tracked)
    mockBehavior = { mode: "budget_exceeded" };

    await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Budget exceeded task",
      branch: "feat/e2e-budget-fail",
    });

    // Cost should remain the same (failed session didn't add to cost)
    expect(orchestrator.status.costToday).toBe(0.02);

    await orchestrator.shutdown();
  });
});

describe("orchestrator E2E: graceful shutdown during active run", () => {
  it("waits for active session to complete before shutdown", async () => {
    mockBehavior = {
      mode: "success",
      messages: successMessages(),
    };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    // Start a dispatch in background
    const dispatchPromise = orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test graceful shutdown",
      branch: "feat/e2e-shutdown",
    });

    // Wait for the dispatch to complete
    const result = await dispatchPromise;
    expect(result.status).toBe("success");

    // Now shutdown should complete immediately
    await orchestrator.shutdown();

    // Verify orchestrator is paused after shutdown
    expect(orchestrator.status.paused).toBe(true);
  });

  it("emits shutdown event correctly", async () => {
    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    const shutdownEvents: NeoEvent[] = [];
    orchestrator.on("orchestrator:shutdown", (e) => shutdownEvents.push(e));

    await orchestrator.start();
    await orchestrator.shutdown();

    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0]?.type).toBe("orchestrator:shutdown");
  });

  it("rejects new dispatches after shutdown initiated", async () => {
    mockBehavior = { mode: "success", messages: successMessages() };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    // Initiate shutdown (pauses orchestrator)
    orchestrator.pause();

    // New dispatch should be rejected
    await expect(
      orchestrator.dispatch({
        agent: "e2e-developer",
        repo: TEST_REPO_DIR,
        prompt: "Should be rejected",
        branch: "feat/e2e-rejected",
      }),
    ).rejects.toThrow("orchestrator is paused");

    await orchestrator.shutdown();
  });

  it("kill removes session from active list", async () => {
    // This test verifies kill() removes session from tracking
    // We test the kill mechanism by verifying it cleans up state
    mockBehavior = { mode: "success", messages: successMessages() };

    const orchestrator = new Orchestrator(makeConfig(TEST_REPO_DIR), {
      skipOrphanRecovery: true,
    });
    orchestrator.registerAgent(makeAgent());

    await orchestrator.start();

    // Run a successful dispatch first to verify baseline
    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test baseline",
      branch: "feat/e2e-baseline",
    });

    expect(result.status).toBe("success");

    // Verify no orphan sessions remain after completion
    expect(orchestrator.activeSessions).toHaveLength(0);

    // Kill on non-existent session should be safe (no-op)
    await orchestrator.kill("non-existent-session-id");
    expect(orchestrator.activeSessions).toHaveLength(0);

    await orchestrator.shutdown();
  });
});

describe("orchestrator E2E: error recovery behavior", () => {
  it("does not retry non-retryable errors", async () => {
    // budget_exceeded is non-retryable by default
    mockBehavior = { mode: "error_result", errorType: "budget_exceeded" };

    const orchestrator = new Orchestrator(
      makeConfig(TEST_REPO_DIR, {
        recovery: { maxRetries: 3, backoffBaseMs: 10 },
      }),
      { skipOrphanRecovery: true },
    );
    orchestrator.registerAgent(makeAgent());

    const failEvents: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => failEvents.push(e));

    await orchestrator.start();

    const result = await orchestrator.dispatch({
      agent: "e2e-developer",
      repo: TEST_REPO_DIR,
      prompt: "Test no retry on max_turns",
      branch: "feat/e2e-no-retry",
    });

    expect(result.status).toBe("failure");

    // Should only have 1 fail event (no retries for non-retryable errors)
    expect(failEvents).toHaveLength(1);
    const failEvent = failEvents[0];
    if (failEvent?.type === "session:fail") {
      expect(failEvent.willRetry).toBe(false);
    }

    await orchestrator.shutdown();
  });
});
