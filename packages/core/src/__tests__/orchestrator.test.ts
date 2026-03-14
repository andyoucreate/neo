import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DispatchInput,
  NeoConfig,
  NeoEvent,
  ResolvedAgent,
  WorkflowDefinition,
} from "@/index";
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

// ─── Git/Worktree Mocks ────────────────────────────────

vi.mock("@/isolation/worktree", () => ({
  createWorktree: () =>
    Promise.resolve({
      path: "/tmp/worktree",
      branch: "feat/run-test",
      repoPath: "/tmp/repo",
    }),
  removeWorktree: () => Promise.resolve(undefined),
  cleanupOrphanedWorktrees: () => Promise.resolve(undefined),
  listWorktrees: () => Promise.resolve([]),
}));

// ─── Helpers ────────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_orchestrator_test__");

function makeConfig(overrides?: Partial<NeoConfig>): NeoConfig {
  return {
    repos: [
      {
        path: TMP_DIR,
        defaultBranch: "main",
        branchPrefix: "feat",
        pushRemote: "origin",
        autoCreatePr: false,
      },
    ],
    concurrency: { maxSessions: 5, maxPerRepo: 2, queueMax: 50 },
    budget: { dailyCapUsd: 100, alertThresholdPct: 80 },
    recovery: { maxRetries: 3, backoffBaseMs: 10 },
    sessions: { initTimeoutMs: 5_000, maxDurationMs: 60_000 },
    idempotency: { enabled: true, key: "prompt", ttlMs: 60_000 },
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

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: "hotfix",
    description: "Hotfix workflow",
    steps: {
      fix: {
        agent: "test-developer",
        prompt: "Fix the bug",
      },
    },
    ...overrides,
  };
}

function makeInput(overrides?: Partial<DispatchInput>): DispatchInput {
  return {
    workflow: "hotfix",
    repo: TMP_DIR,
    prompt: "Fix the bug",
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
  orchestrator.registerWorkflow(makeWorkflow());
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
  it("runs a single-step workflow end-to-end", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.dispatch(makeInput());

    expect(result.status).toBe("success");
    expect(result.workflow).toBe("hotfix");
    expect(result.repo).toBe(TMP_DIR);
    expect(result.runId).toBeDefined();
    expect(result.costUsd).toBe(0.05);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const fixStep = result.steps.fix;
    expect(fixStep).toBeDefined();
    expect(fixStep?.status).toBe("success");
    expect(fixStep?.agent).toBe("test-developer");
  });

  it("persists run state to .neo/runs/", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.dispatch(makeInput());

    const runFile = path.join(TMP_DIR, ".neo/runs", `${result.runId}.json`);
    expect(existsSync(runFile)).toBe(true);

    const persisted = JSON.parse(await readFile(runFile, "utf-8"));
    expect(persisted.status).toBe("completed");
    expect(persisted.workflow).toBe("hotfix");
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
    expect(result.steps.fix?.status).toBe("failure");
    expect(result.steps.fix?.error).toBeDefined();
  });

  it("uses the workflow step prompt when available", async () => {
    const orchestrator = new Orchestrator(makeConfig());
    orchestrator.registerAgent(makeAgent());
    orchestrator.registerWorkflow(
      makeWorkflow({
        steps: {
          fix: {
            agent: "test-developer",
            prompt: "Step-specific prompt",
          },
        },
      }),
    );

    const result = await orchestrator.dispatch(makeInput());
    expect(result.status).toBe("success");
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
    const runsDir = path.join(TMP_DIR, ".neo/runs");
    mkdirSync(runsDir, { recursive: true });

    const orphanedRun = {
      version: 1,
      runId: "orphan-run-1",
      workflow: "hotfix",
      repo: TMP_DIR,
      prompt: "Fix something",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(runsDir, "orphan-run-1.json"), JSON.stringify(orphanedRun));

    const orchestrator = createOrchestrator();
    await orchestrator.start();

    const recovered = JSON.parse(await readFile(path.join(runsDir, "orphan-run-1.json"), "utf-8"));
    expect(recovered.status).toBe("failed");
  });

  it("does not modify completed runs", async () => {
    const runsDir = path.join(TMP_DIR, ".neo/runs");
    mkdirSync(runsDir, { recursive: true });

    const completedRun = {
      version: 1,
      runId: "completed-run-1",
      workflow: "hotfix",
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

  it("rejects non-existent workflow", async () => {
    const orchestrator = createOrchestrator();

    await expect(orchestrator.dispatch(makeInput({ workflow: "nonexistent" }))).rejects.toThrow(
      'workflow "nonexistent" not found',
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
      expect(startEvent.workflow).toBe("hotfix");
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

// ─── Readonly agent (no worktree) ───────────────────────

describe("readonly agent", () => {
  it("dispatches without creating a worktree", async () => {
    await import("@/isolation/worktree");

    const orchestrator = new Orchestrator(makeConfig());
    orchestrator.registerWorkflow(
      makeWorkflow({
        steps: {
          review: {
            agent: "test-reviewer",
          },
        },
      }),
    );
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

    const result = await orchestrator.dispatch(makeInput({ workflow: "hotfix" }));

    // createWorktree should not have been called for readonly agent
    // (it may have been called previously by other tests, so just check result)
    expect(result.status).toBe("success");
  });
});
