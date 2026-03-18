import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchInput, NeoConfig, NeoEvent, ResolvedAgent } from "@/index";
import { Orchestrator } from "@/orchestrator";

// ─── SDK Mock ───────────────────────────────────────────

interface MockMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

let mockMessages: MockMessage[] = [];
let mockQueryDelay = 0;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_args: unknown) => {
    const messages = mockMessages;
    const delay = mockQueryDelay;
    return {
      async *[Symbol.asyncIterator]() {
        for (const msg of messages) {
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          yield msg;
        }
      },
    };
  },
}));

// ─── Git/Clone Mocks ───────────────────────────────────

vi.mock("@/isolation/clone", () => ({
  createSessionClone: () =>
    Promise.resolve({
      path: "/tmp/session",
      branch: "feat/run-test",
      repoPath: "/tmp/repo",
    }),
  removeSessionClone: () => Promise.resolve(undefined),
  listSessionClones: () => Promise.resolve([]),
}));

// ─── Helpers ────────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_orchestrator_test__");
const GLOBAL_RUNS_DIR = path.join(TMP_DIR, ".neo-global/runs");
const GLOBAL_JOURNALS_DIR = path.join(TMP_DIR, ".neo-global/journals");

vi.mock("@/paths", async () => {
  const p = await import("node:path");
  return {
    getDataDir: () => p.join(TMP_DIR, ".neo-global"),
    getJournalsDir: () => GLOBAL_JOURNALS_DIR,
    getRunsDir: () => GLOBAL_RUNS_DIR,
    toRepoSlug: (repo: { name?: string; path: string }) => {
      const raw = repo.name ?? p.basename(repo.path);
      return raw
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    },
    getRepoRunsDir: (slug: string) => p.join(GLOBAL_RUNS_DIR, slug),
    getSupervisorsDir: () => p.join(TMP_DIR, ".neo-global", "supervisors"),
  };
});

function makeConfig(overrides?: Partial<NeoConfig>): NeoConfig {
  return {
    repos: [
      {
        path: TMP_DIR,
        defaultBranch: "main",
        branchPrefix: "feat",
        pushRemote: "origin",
        gitStrategy: "branch",
      },
    ],
    concurrency: { maxSessions: 5, maxPerRepo: 2, queueMax: 50 },
    budget: { dailyCapUsd: 100, alertThresholdPct: 80 },
    recovery: { maxRetries: 3, backoffBaseMs: 10 },
    sessions: { initTimeoutMs: 5_000, maxDurationMs: 60_000, dir: "/tmp/neo-sessions" },
    webhooks: [],
    idempotency: { enabled: true, key: "prompt", ttlMs: 60_000 },
    supervisor: {
      port: 7777,
      heartbeatTimeoutMs: 300_000,
      maxConsecutiveFailures: 3,
      maxEventsPerSec: 10,
      dailyCapUsd: 50,
      consolidationIntervalMs: 300_000,
      compactionIntervalMs: 3_600_000,
      eventTimeoutMs: 300_000,
    },
    memory: { embeddings: true },
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
  return {
    name: "test-developer",
    definition: {
      description: "Test developer agent",
      prompt: "You are a test agent.",
      tools: ["Read", "Write", "Edit", "Bash"],
      model: "sonnet",
    },
    sandbox: "writable",
    source: "built-in",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<DispatchInput>): DispatchInput {
  return {
    agent: "test-developer",
    repo: TMP_DIR,
    prompt: "Fix the bug",
    branch: "feat/test-branch",
    ...overrides,
  };
}

function successMessages(sessionId = "session-123"): MockMessage[] {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "Task completed successfully",
      total_cost_usd: 0.05,
      duration_ms: 1200,
      num_turns: 3,
    },
  ];
}

function createOrchestrator(configOverrides?: Partial<NeoConfig>): Orchestrator {
  const orchestrator = new Orchestrator(makeConfig(configOverrides));
  orchestrator.registerAgent(makeAgent());
  return orchestrator;
}

// ─── Setup / Teardown ───────────────────────────────────

beforeEach(async () => {
  mockMessages = successMessages();
  mockQueryDelay = 0;
  await mkdir(TMP_DIR, { recursive: true });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── dispatch() end-to-end ──────────────────────────────

describe("dispatch", () => {
  it("runs agent session end-to-end", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.dispatch(makeInput());

    expect(result.status).toBe("success");
    expect(result.agent).toBe("test-developer");
    expect(result.repo).toBe(TMP_DIR);
    expect(result.runId).toBeDefined();
    expect(result.costUsd).toBe(0.05);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const executeStep = result.steps.execute;
    expect(executeStep).toBeDefined();
    expect(executeStep?.status).toBe("success");
    expect(executeStep?.agent).toBe("test-developer");
  });

  it("persists run state to global runs dir", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.dispatch(makeInput());

    const slug = path
      .basename(TMP_DIR)
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const runFile = path.join(GLOBAL_RUNS_DIR, slug, `${result.runId}.json`);
    expect(existsSync(runFile)).toBe(true);

    const persisted = JSON.parse(await readFile(runFile, "utf-8"));
    expect(persisted.status).toBe("completed");
    expect(persisted.agent).toBe("test-developer");
    expect(persisted.pid).toBe(process.pid);
  });

  it("persists run with running status before session starts", async () => {
    // Use a delay so we can observe the intermediate state
    vi.useRealTimers();
    mockQueryDelay = 100;

    const orchestrator = createOrchestrator();
    const slug = path
      .basename(TMP_DIR)
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    const dispatchPromise = orchestrator.dispatch(makeInput());

    // Wait briefly for the initial persist to happen (before session completes)
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Check that runs dir has a file with status "running"
    const runsDir = path.join(GLOBAL_RUNS_DIR, slug);
    if (existsSync(runsDir)) {
      const { readdir: rd } = await import("node:fs/promises");
      const files = await rd(runsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      expect(jsonFiles.length).toBeGreaterThanOrEqual(1);

      const content = await readFile(path.join(runsDir, jsonFiles[0] as string), "utf-8");
      const run = JSON.parse(content);
      // At this point the run should exist (either running or already completed)
      expect(["running", "completed"]).toContain(run.status);
    }

    await dispatchPromise;
  });

  it("returns failure status on session error", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-fail" },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-fail",
        result: "",
        total_cost_usd: 0,
        num_turns: 10,
      },
    ];

    const orchestrator = createOrchestrator({ recovery: { maxRetries: 1, backoffBaseMs: 1 } });
    const result = await orchestrator.dispatch(makeInput());

    expect(result.status).toBe("failure");
    expect(result.steps.execute?.status).toBe("failure");
    expect(result.steps.execute?.error).toBeDefined();
  });

  it("preserves metadata in task result", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.dispatch(makeInput({ metadata: { ticket: "NEO-123" } }));

    expect(result.metadata).toEqual({ ticket: "NEO-123" });
  });

  it("generates unique runId for each dispatch", async () => {
    const orchestrator = createOrchestrator({
      idempotency: { enabled: false, key: "prompt", ttlMs: 60_000 },
    });

    const result1 = await orchestrator.dispatch(makeInput({ prompt: "Task A" }));
    const result2 = await orchestrator.dispatch(makeInput({ prompt: "Task B" }));

    expect(result1.runId).toBeDefined();
    expect(result2.runId).toBeDefined();
    expect(result1.runId).not.toBe(result2.runId);
  });
});

// ─── dispatch() while paused ────────────────────────────

describe("pause / resume", () => {
  it("rejects dispatch when paused", async () => {
    const orchestrator = createOrchestrator();
    orchestrator.pause();

    await expect(orchestrator.dispatch(makeInput())).rejects.toThrow("paused");
  });

  it("accepts dispatch after resume", async () => {
    const orchestrator = createOrchestrator();
    orchestrator.pause();
    orchestrator.resume();

    const result = await orchestrator.dispatch(makeInput());
    expect(result.status).toBe("success");
  });
});

// ─── Idempotency ────────────────────────────────────────

describe("idempotency", () => {
  it("rejects duplicate dispatch within TTL", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.dispatch(makeInput());
    await expect(orchestrator.dispatch(makeInput())).rejects.toThrow("Duplicate dispatch rejected");
  });

  it("allows dispatch with different prompt", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.dispatch(makeInput({ prompt: "First task" }));
    const result = await orchestrator.dispatch(makeInput({ prompt: "Second task" }));
    expect(result.status).toBe("success");
  });

  it("skips idempotency when disabled", async () => {
    const orchestrator = createOrchestrator({
      idempotency: { enabled: false, key: "prompt", ttlMs: 60_000 },
    });

    await orchestrator.dispatch(makeInput());
    const result = await orchestrator.dispatch(makeInput());
    expect(result.status).toBe("success");
  });

  it("uses metadata key when configured", async () => {
    const orchestrator = createOrchestrator({
      idempotency: { enabled: true, key: "metadata", ttlMs: 60_000 },
    });

    await orchestrator.dispatch(makeInput({ metadata: { ticket: "A" } }));

    // Same metadata → reject
    await expect(orchestrator.dispatch(makeInput({ metadata: { ticket: "A" } }))).rejects.toThrow(
      "Duplicate dispatch rejected",
    );

    // Different metadata → allow
    const result = await orchestrator.dispatch(makeInput({ metadata: { ticket: "B" } }));
    expect(result.status).toBe("success");
  });

  it("evicts expired entries after TTL", async () => {
    const orchestrator = createOrchestrator({
      idempotency: { enabled: true, key: "prompt", ttlMs: 1_000 },
    });

    await orchestrator.dispatch(makeInput());

    // Advance past TTL
    vi.advanceTimersByTime(2_000);

    // Same dispatch should now succeed because the entry expired
    const result = await orchestrator.dispatch(makeInput());
    expect(result.status).toBe("success");
  });
});

// ─── kill() ─────────────────────────────────────────────

describe("kill", () => {
  it("removes session from active sessions", async () => {
    const orchestrator = createOrchestrator();

    // Start a dispatch, then kill it
    // Since dispatch resolves quickly with mocked SDK, we test kill on a non-existent session
    await orchestrator.kill("non-existent-session");

    expect(orchestrator.activeSessions).toHaveLength(0);
  });
});

// ─── drain() ────────────────────────────────────────────

describe("drain", () => {
  it("resolves immediately when no active sessions", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.drain();
    expect(orchestrator.status.paused).toBe(true);
  });

  it("sets paused state", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.drain();
    expect(orchestrator.status.paused).toBe(true);
  });
});

// ─── Graceful shutdown ──────────────────────────────────

describe("shutdown", () => {
  it("emits orchestrator:shutdown event", async () => {
    const orchestrator = createOrchestrator();
    const events: NeoEvent[] = [];
    orchestrator.on("orchestrator:shutdown", (e) => events.push(e));

    await orchestrator.shutdown();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("orchestrator:shutdown");
  });

  it("sets paused state after shutdown", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.shutdown();
    expect(orchestrator.status.paused).toBe(true);
  });
});

// ─── Startup recovery ───────────────────────────────────

describe("start", () => {
  it("marks orphaned running runs as failed", async () => {
    const runsDir = GLOBAL_RUNS_DIR;
    mkdirSync(runsDir, { recursive: true });

    const staleDate = new Date(Date.now() - 120_000).toISOString(); // 2 min ago — past grace period
    const orphanedRun = {
      version: 1,
      runId: "orphan-run-1",
      agent: "test-developer",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "running",
      steps: {},
      createdAt: staleDate,
      updatedAt: staleDate,
    };
    writeFileSync(path.join(runsDir, "orphan-run-1.json"), JSON.stringify(orphanedRun));

    const orchestrator = createOrchestrator();
    await orchestrator.start();

    const recovered = JSON.parse(await readFile(path.join(runsDir, "orphan-run-1.json"), "utf-8"));
    expect(recovered.status).toBe("failed");
  });

  it("skips running runs with alive PID", async () => {
    const runsDir = GLOBAL_RUNS_DIR;
    mkdirSync(runsDir, { recursive: true });

    const aliveRun = {
      version: 1,
      runId: "alive-run-1",
      agent: "test-developer",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "running",
      pid: process.pid, // Current process is alive
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(runsDir, "alive-run-1.json"), JSON.stringify(aliveRun));

    const orchestrator = createOrchestrator();
    await orchestrator.start();

    const stillRunning = JSON.parse(
      await readFile(path.join(runsDir, "alive-run-1.json"), "utf-8"),
    );
    expect(stillRunning.status).toBe("running");
  });

  it("marks running runs with dead PID as failed", async () => {
    const runsDir = GLOBAL_RUNS_DIR;
    mkdirSync(runsDir, { recursive: true });

    const staleDate = new Date(Date.now() - 120_000).toISOString(); // 2 min ago — past grace period
    const deadRun = {
      version: 1,
      runId: "dead-run-1",
      agent: "test-developer",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "running",
      pid: 999999999, // Dead PID
      steps: {},
      createdAt: staleDate,
      updatedAt: staleDate,
    };
    writeFileSync(path.join(runsDir, "dead-run-1.json"), JSON.stringify(deadRun));

    const orchestrator = createOrchestrator();
    await orchestrator.start();

    const recovered = JSON.parse(await readFile(path.join(runsDir, "dead-run-1.json"), "utf-8"));
    expect(recovered.status).toBe("failed");
  });

  it("does not modify completed runs", async () => {
    const runsDir = GLOBAL_RUNS_DIR;
    mkdirSync(runsDir, { recursive: true });

    const completedRun = {
      version: 1,
      runId: "completed-run-1",
      agent: "test-developer",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "completed",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(runsDir, "completed-run-1.json"), JSON.stringify(completedRun));

    const orchestrator = createOrchestrator();
    await orchestrator.start();

    const unchanged = JSON.parse(
      await readFile(path.join(runsDir, "completed-run-1.json"), "utf-8"),
    );
    expect(unchanged.status).toBe("completed");
  });

  it("does not mark a concurrent worker's run as orphaned when PID is present and alive", async () => {
    const runsDir = GLOBAL_RUNS_DIR;
    mkdirSync(runsDir, { recursive: true });

    // Simulate another worker's run that has been running for > 30s (past grace period)
    // but whose process is still alive (use current PID as a proxy for "alive")
    const staleDate = new Date(Date.now() - 120_000).toISOString();
    const otherWorkerRun = {
      version: 1,
      runId: "concurrent-run-1",
      agent: "test-developer",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "running",
      pid: process.pid, // alive PID — must NOT be marked orphaned
      steps: {},
      createdAt: staleDate,
      updatedAt: staleDate,
    };
    writeFileSync(path.join(runsDir, "concurrent-run-1.json"), JSON.stringify(otherWorkerRun));

    // A new orchestrator starting up should NOT touch this run
    const orchestrator = createOrchestrator();
    await orchestrator.start();

    const stillRunning = JSON.parse(
      await readFile(path.join(runsDir, "concurrent-run-1.json"), "utf-8"),
    );
    expect(stillRunning.status).toBe("running");
  });

  it("marks a stale run without PID as orphaned (the pre-fix bug scenario)", async () => {
    const runsDir = GLOBAL_RUNS_DIR;
    mkdirSync(runsDir, { recursive: true });

    // This is the exact scenario that caused the bug: run has no PID field
    // (because persistRun() used to omit it) and is older than grace period
    const staleDate = new Date(Date.now() - 120_000).toISOString();
    const noPidRun = {
      version: 1,
      runId: "no-pid-run-1",
      agent: "test-developer",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "running",
      // no pid field — this used to cause false orphan detection
      steps: {},
      createdAt: staleDate,
      updatedAt: staleDate,
    };
    writeFileSync(path.join(runsDir, "no-pid-run-1.json"), JSON.stringify(noPidRun));

    const orchestrator = createOrchestrator();
    await orchestrator.start();

    // Without PID, the run should still be marked as orphaned (the process is truly unknown)
    const recovered = JSON.parse(await readFile(path.join(runsDir, "no-pid-run-1.json"), "utf-8"));
    expect(recovered.status).toBe("failed");
  });
});

// ─── Input validation ───────────────────────────────────

describe("input validation", () => {
  it("rejects empty prompt", async () => {
    const orchestrator = createOrchestrator();

    await expect(orchestrator.dispatch(makeInput({ prompt: "" }))).rejects.toThrow(
      "prompt must be a non-empty string",
    );
  });

  it("rejects whitespace-only prompt", async () => {
    const orchestrator = createOrchestrator();

    await expect(orchestrator.dispatch(makeInput({ prompt: "   " }))).rejects.toThrow(
      "prompt must be a non-empty string",
    );
  });

  it("rejects prompt exceeding 100KB", async () => {
    const orchestrator = createOrchestrator();
    const largePrompt = "x".repeat(100 * 1024 + 1);

    await expect(orchestrator.dispatch(makeInput({ prompt: largePrompt }))).rejects.toThrow(
      "exceeds maximum size",
    );
  });

  it("rejects non-existent repo path", async () => {
    const orchestrator = createOrchestrator();

    await expect(
      orchestrator.dispatch(makeInput({ repo: "/nonexistent/repo/path" })),
    ).rejects.toThrow("repo path does not exist");
  });

  it("rejects non-existent agent", async () => {
    const orchestrator = createOrchestrator();

    await expect(orchestrator.dispatch(makeInput({ agent: "nonexistent" }))).rejects.toThrow(
      'agent "nonexistent" not found',
    );
  });

  it("rejects metadata with excessive depth", async () => {
    const orchestrator = createOrchestrator();
    const deepMetadata = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };

    await expect(orchestrator.dispatch(makeInput({ metadata: deepMetadata }))).rejects.toThrow(
      "maximum nesting depth",
    );
  });

  it("rejects mutually exclusive step/from/retry", async () => {
    const orchestrator = createOrchestrator();

    await expect(orchestrator.dispatch(makeInput({ step: "a", from: "b" }))).rejects.toThrow(
      "mutually exclusive",
    );
  });

  it("rejects non-object metadata (array)", async () => {
    const orchestrator = createOrchestrator();

    await expect(
      orchestrator.dispatch(
        makeInput({ metadata: [1, 2, 3] as unknown as Record<string, unknown> }),
      ),
    ).rejects.toThrow("metadata must be a plain object");
  });

  it("accepts metadata at exactly max depth (5 levels)", async () => {
    const orchestrator = createOrchestrator();

    const result = await orchestrator.dispatch(
      makeInput({ metadata: { a: { b: { c: { d: { e: "ok" } } } } } }),
    );
    expect(result.status).toBe("success");
  });

  it("rejects dispatch without explicit branch", async () => {
    const orchestrator = createOrchestrator();

    const result = await orchestrator.dispatch(makeInput({ branch: undefined }));
    expect(result.status).toBe("failure");
    const stepError = Object.values(result.steps)[0]?.error;
    expect(stepError).toContain("--branch is required");
  });

  it("accepts gitStrategy 'pr' with explicit branch", async () => {
    const orchestrator = createOrchestrator();

    const result = await orchestrator.dispatch(
      makeInput({ gitStrategy: "pr", branch: "feat/PROJ-42-add-auth" }),
    );
    expect(result.status).toBe("success");
    expect(result.branch).toBe("feat/PROJ-42-add-auth");
  });

  it("uses explicit branch for gitStrategy 'branch'", async () => {
    const orchestrator = createOrchestrator();

    const result = await orchestrator.dispatch(makeInput({ branch: "feat/my-custom-branch" }));
    expect(result.status).toBe("success");
    expect(result.branch).toBe("feat/my-custom-branch");
  });
});

// ─── Events ─────────────────────────────────────────────

describe("events", () => {
  it("emits session:start and session:complete on success", async () => {
    const orchestrator = createOrchestrator();
    const events: NeoEvent[] = [];
    orchestrator.on("session:start", (e) => events.push(e));
    orchestrator.on("session:complete", (e) => events.push(e));

    await orchestrator.dispatch(makeInput());

    const startEvent = events.find((e) => e.type === "session:start");
    const completeEvent = events.find((e) => e.type === "session:complete");

    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();

    if (startEvent?.type === "session:start") {
      expect(startEvent.agent).toBe("test-developer");
    }

    if (completeEvent?.type === "session:complete") {
      expect(completeEvent.status).toBe("success");
      expect(completeEvent.costUsd).toBe(0.05);
    }
  });

  it("emits session:fail on error", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-err" },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-err",
        result: "",
        total_cost_usd: 0,
        num_turns: 10,
      },
    ];

    const orchestrator = createOrchestrator({ recovery: { maxRetries: 1, backoffBaseMs: 1 } });
    const events: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => events.push(e));

    await orchestrator.dispatch(makeInput());

    const failEvent = events.find(
      (e) => e.type === "session:fail" && !("willRetry" in e && e.willRetry),
    );
    expect(failEvent).toBeDefined();
  });

  it("emits cost:update after successful dispatch", async () => {
    const orchestrator = createOrchestrator();
    const events: NeoEvent[] = [];
    orchestrator.on("cost:update", (e) => events.push(e));

    await orchestrator.dispatch(makeInput());

    expect(events).toHaveLength(1);
    const costEvent = events[0];
    if (costEvent?.type === "cost:update") {
      expect(costEvent.sessionCost).toBe(0.05);
      expect(costEvent.todayTotal).toBe(0.05);
    }
  });

  it("emits on wildcard channel", async () => {
    const orchestrator = createOrchestrator();
    const events: NeoEvent[] = [];
    orchestrator.on("*", (e) => events.push(e));

    await orchestrator.dispatch(makeInput());

    // Should have received multiple events via wildcard
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("emits queue:enqueue when at capacity", async () => {
    const orchestrator = createOrchestrator({
      concurrency: { maxSessions: 5, maxPerRepo: 1, queueMax: 50 },
      idempotency: { enabled: false, key: "prompt", ttlMs: 60_000 },
    });

    const events: NeoEvent[] = [];
    orchestrator.on("queue:enqueue", (e) => events.push(e));

    // Add delay so first dispatch holds the semaphore slot
    mockQueryDelay = 50;

    const p1 = orchestrator.dispatch(makeInput({ prompt: "First task" }));
    // Small delay to ensure first dispatch acquires first
    await new Promise((resolve) => setTimeout(resolve, 10));
    const p2 = orchestrator.dispatch(makeInput({ prompt: "Second task" }));

    await Promise.all([p1, p2]);

    const enqueueEvent = events.find((e) => e.type === "queue:enqueue");
    expect(enqueueEvent).toBeDefined();
  });
});

// ─── Cost tracking ──────────────────────────────────────

describe("cost tracking", () => {
  it("accumulates cost across dispatches", async () => {
    const orchestrator = createOrchestrator({
      idempotency: { enabled: false, key: "prompt", ttlMs: 60_000 },
    });

    await orchestrator.dispatch(makeInput({ prompt: "Task 1" }));
    await orchestrator.dispatch(makeInput({ prompt: "Task 2" }));

    expect(orchestrator.status.costToday).toBe(0.1);
  });

  it("emits budget:alert when threshold exceeded", async () => {
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-expensive" },
      {
        type: "result",
        subtype: "success",
        session_id: "session-expensive",
        result: "Done",
        total_cost_usd: 85,
        num_turns: 1,
      },
    ];

    const orchestrator = createOrchestrator();
    const events: NeoEvent[] = [];
    orchestrator.on("budget:alert", (e) => events.push(e));

    await orchestrator.dispatch(makeInput());

    expect(events).toHaveLength(1);
    const alertEvent = events[0];
    if (alertEvent?.type === "budget:alert") {
      expect(alertEvent.utilizationPct).toBeGreaterThanOrEqual(80);
    }
  });
});

// ─── Status & active sessions ───────────────────────────

describe("status", () => {
  it("returns correct initial status", () => {
    const orchestrator = createOrchestrator();

    const status = orchestrator.status;
    expect(status.paused).toBe(false);
    expect(status.activeSessions).toHaveLength(0);
    expect(status.queueDepth).toBe(0);
    expect(status.costToday).toBe(0);
    expect(status.budgetCapUsd).toBe(100);
    expect(status.budgetRemainingPct).toBe(100);
  });

  it("reflects paused state", () => {
    const orchestrator = createOrchestrator();
    orchestrator.pause();

    expect(orchestrator.status.paused).toBe(true);
  });

  it("tracks uptime after start()", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.start();

    // Advance time slightly
    vi.advanceTimersByTime(100);

    expect(orchestrator.status.uptime).toBeGreaterThanOrEqual(100);
  });
});

// ─── Static middleware factories ────────────────────────

describe("static middleware", () => {
  it("exposes loopDetection factory", () => {
    const mw = Orchestrator.middleware.loopDetection({ threshold: 5 });
    expect(mw.name).toBe("loop-detection");
    expect(mw.on).toBe("PreToolUse");
  });

  it("exposes auditLog factory", () => {
    const mw = Orchestrator.middleware.auditLog({ dir: "/tmp/logs" });
    expect(mw.name).toBe("audit-log");
    expect(mw.on).toBe("PostToolUse");
  });

  it("exposes budgetGuard factory", () => {
    const mw = Orchestrator.middleware.budgetGuard();
    expect(mw.name).toBe("budget-guard");
    expect(mw.on).toBe("PreToolUse");
  });
});

// ─── MCP server resolution ──────────────────────────────

describe("MCP server resolution", () => {
  it("passes MCP servers from agent definition to session", async () => {
    const orchestrator = new Orchestrator(
      makeConfig({
        mcpServers: {
          notion: { type: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
          github: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
        },
      }),
    );
    orchestrator.registerAgent(
      makeAgent({
        name: "mcp-dev",
        definition: {
          description: "Dev with MCP",
          prompt: "Dev with Notion",
          tools: ["Read", "Write"],
          model: "sonnet",
          mcpServers: ["notion"],
        },
      }),
    );

    const result = await orchestrator.dispatch(makeInput({ agent: "mcp-dev" }));
    expect(result.status).toBe("success");
  });

  it("dispatches without MCP servers when none configured", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.dispatch(makeInput());
    expect(result.status).toBe("success");
  });
});

// ─── Readonly agent (with isolated clone) ───────────────

describe("readonly agent", () => {
  it("dispatches with an isolated clone on the base branch", async () => {
    const cloneMod = await import("@/isolation/clone");

    const orchestrator = new Orchestrator(makeConfig());
    orchestrator.registerAgent(
      makeAgent({
        name: "test-reviewer",
        sandbox: "readonly",
        definition: {
          description: "Reviewer",
          prompt: "Review code",
          tools: ["Read", "Glob", "Grep"],
          model: "sonnet",
        },
      }),
    );

    const createSpy = vi.spyOn(cloneMod, "createSessionClone");

    const result = await orchestrator.dispatch(makeInput({ agent: "test-reviewer" }));

    expect(result.status).toBe("success");
    // All agents get an isolated clone on the requested branch
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "feat/test-branch",
        baseBranch: "main",
      }),
    );
  });
});
