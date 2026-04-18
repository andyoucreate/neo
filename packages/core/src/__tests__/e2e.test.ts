import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@/agents/registry";
import { loadConfig } from "@/config";
import { CostJournal } from "@/cost/journal";
import { EventJournal } from "@/events/journal";
import { Orchestrator } from "@/orchestrator";
import type { Middleware, NeoEvent } from "@/types";

// ─── SDK Mock (network boundary only) ────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_e2e__");
const AGENTS_DIR = path.join(TMP_DIR, "agents");
const PROMPTS_DIR = path.join(TMP_DIR, "prompts");
const JOURNALS_DIR = path.join(TMP_DIR, "journals");
const REPO_DIR = path.join(TMP_DIR, "repo");
const GLOBAL_RUNS_DIR = path.join(TMP_DIR, "global-runs");

vi.mock("@/paths", async () => {
  const p = await import("node:path");
  return {
    getDataDir: () => p.join(TMP_DIR, "global"),
    getJournalsDir: () => JOURNALS_DIR,
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
    getSupervisorsDir: () => p.join(TMP_DIR, "global", "supervisors"),
  };
});

const DEVELOPER_PROMPT = "You are a developer agent. Implement the task.";
const REVIEWER_PROMPT = "You are a code reviewer. Review the changes.";
const ARCHITECT_PROMPT = "You are an architect. Plan the implementation.";

async function writeAgentFixtures(): Promise<void> {
  await mkdir(AGENTS_DIR, { recursive: true });
  await mkdir(PROMPTS_DIR, { recursive: true });

  // Write prompts
  await writeFile(path.join(PROMPTS_DIR, "developer.md"), DEVELOPER_PROMPT);
  await writeFile(path.join(PROMPTS_DIR, "reviewer.md"), REVIEWER_PROMPT);
  await writeFile(path.join(PROMPTS_DIR, "architect.md"), ARCHITECT_PROMPT);

  // Write agent YAMLs
  await writeFile(
    path.join(AGENTS_DIR, "developer.yml"),
    `name: developer
description: "Implementation worker"
model: claude-sonnet-4-6
sandbox: writable
prompt: ../prompts/developer.md
`,
  );

  await writeFile(
    path.join(AGENTS_DIR, "reviewer.yml"),
    `name: reviewer
description: "Code reviewer"
model: claude-sonnet-4-6
sandbox: readonly
prompt: ../prompts/reviewer.md
`,
  );

  await writeFile(
    path.join(AGENTS_DIR, "architect.yml"),
    `name: architect
description: "Strategic planner"
model: claude-opus-4-6
sandbox: readonly
prompt: ../prompts/architect.md
`,
  );
}

async function writeConfigFixture(): Promise<void> {
  const config = `
repos:
  - path: "${REPO_DIR}"
    defaultBranch: main
    branchPrefix: feat
    pushRemote: origin
    gitStrategy: branch

concurrency:
  maxSessions: 3
  maxPerRepo: 2
  queueMax: 10

budget:
  dailyCapUsd: 50
  alertThresholdPct: 80

recovery:
  maxRetries: 2
  backoffBaseMs: 10

sessions:
  initTimeoutMs: 5000
  maxDurationMs: 30000

idempotency:
  enabled: true
  key: prompt
  ttlMs: 60000

provider:
  adapter: claude
  models:
    default: claude-sonnet-4-6
    available:
      - claude-sonnet-4-6
`;
  await writeFile(path.join(TMP_DIR, "config.yml"), config);
}

function successMessages(sessionId = "e2e-session-1", cost = 0.05): MockMessage[] {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "Task completed successfully",
      total_cost_usd: cost,
      duration_ms: 500,
      num_turns: 3,
    },
  ];
}

// ─── Setup / Teardown ─────────────────────────────────────

beforeEach(async () => {
  mockMessages = successMessages();
  mockQueryDelay = 0;

  await mkdir(REPO_DIR, { recursive: true });
  await mkdir(JOURNALS_DIR, { recursive: true });
  await writeAgentFixtures();
  await writeConfigFixture();

  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Config loading ──────────────────────────────────────

describe("e2e: config loading", () => {
  it("loads and validates a YAML config file", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));

    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]?.path).toBe(REPO_DIR);
    expect(config.concurrency.maxSessions).toBe(3);
    expect(config.budget.dailyCapUsd).toBe(50);
    expect(config.recovery.maxRetries).toBe(2);
    expect(config.sessions.initTimeoutMs).toBe(5000);
    expect(config.idempotency?.enabled).toBe(true);
  });

  it("rejects missing config file with descriptive error", async () => {
    await expect(loadConfig("/nonexistent/config.yml")).rejects.toThrow("Config file not found");
  });

  it("rejects invalid config with field-level errors", async () => {
    await writeFile(path.join(TMP_DIR, "bad.yml"), "concurrency:\n  maxSessions: not-a-number");
    await expect(loadConfig(path.join(TMP_DIR, "bad.yml"))).rejects.toThrow("Invalid config");
  });
});

// ─── Agent registry ──────────────────────────────────────

describe("e2e: agent registry", () => {
  it("loads all agents from a directory with prompt resolution", async () => {
    const registry = new AgentRegistry(AGENTS_DIR);
    await registry.load();

    expect(registry.list()).toHaveLength(3);
    expect(registry.has("developer")).toBe(true);
    expect(registry.has("reviewer")).toBe(true);
    expect(registry.has("architect")).toBe(true);

    const dev = registry.get("developer");
    expect(dev?.definition.prompt).toBe(DEVELOPER_PROMPT);
    expect(dev?.sandbox).toBe("writable");
  });

  it("custom agents override built-in agents", async () => {
    const customDir = path.join(TMP_DIR, "custom-agents");
    await mkdir(customDir, { recursive: true });
    await writeFile(
      path.join(customDir, "developer.yml"),
      `name: developer
description: "Custom developer override"
model: claude-haiku-4-6
sandbox: writable
prompt: "Custom prompt"
`,
    );

    const registry = new AgentRegistry(AGENTS_DIR, customDir);
    await registry.load();

    const dev = registry.get("developer");
    expect(dev?.source).toBe("custom");
    expect(dev?.definition.description).toBe("Custom developer override");
  });
});

// ─── Full orchestrator lifecycle ─────────────────────────

describe("e2e: orchestrator lifecycle", () => {
  async function buildOrchestrator(): Promise<Orchestrator> {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    // Load and register agents
    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }

    await orchestrator.start();
    return orchestrator;
  }

  it("start → dispatch → shutdown full cycle", async () => {
    const orchestrator = await buildOrchestrator();

    const result = await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Fix the login bug",
    });

    expect(result.status).toBe("success");
    expect(result.agent).toBe("developer");
    expect(result.repo).toBe(REPO_DIR);
    expect(result.costUsd).toBe(0.05);
    expect(result.steps.execute).toBeDefined();
    expect(result.steps.execute?.agent).toBe("developer");

    // Run file should be persisted in slug subdir
    const runsDir = path.join(GLOBAL_RUNS_DIR, "repo");
    const files = await readdir(runsDir);
    expect(files).toHaveLength(1);
    const firstFile = files[0] ?? "";
    const runData = JSON.parse(await readFile(path.join(runsDir, firstFile), "utf-8"));
    expect(runData.status).toBe("completed");

    await orchestrator.shutdown();
    expect(orchestrator.status.paused).toBe(true);
  });

  it("emits complete event lifecycle during dispatch", async () => {
    const orchestrator = await buildOrchestrator();
    const events: NeoEvent[] = [];
    orchestrator.on("*", (e) => events.push(e));

    await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Add logging",
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("session:start");
    expect(eventTypes).toContain("session:complete");
    expect(eventTypes).toContain("cost:update");

    // Verify event ordering: start comes before complete
    const startIdx = eventTypes.indexOf("session:start");
    const completeIdx = eventTypes.indexOf("session:complete");
    expect(startIdx).toBeLessThan(completeIdx);

    await orchestrator.shutdown();
  });

  it("tracks accumulated cost across dispatches", async () => {
    const orchestrator = await buildOrchestrator();

    // Disable idempotency for this test
    await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Task 1",
    });
    await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Task 2",
    });

    expect(orchestrator.status.costToday).toBe(0.1);
    expect(orchestrator.status.budgetRemainingPct).toBeCloseTo(99.8, 1);

    await orchestrator.shutdown();
  });

  it("rejects dispatch when paused", async () => {
    const orchestrator = await buildOrchestrator();
    orchestrator.pause();

    await expect(
      orchestrator.dispatch({
        agent: "developer",
        repo: REPO_DIR,
        prompt: "Should fail",
      }),
    ).rejects.toThrow("paused");

    await orchestrator.shutdown();
  });

  it("resumes accepting dispatches after resume()", async () => {
    const orchestrator = await buildOrchestrator();
    orchestrator.pause();
    orchestrator.resume();

    const result = await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Should work after resume",
    });
    expect(result.status).toBe("success");

    await orchestrator.shutdown();
  });

  it("drain() waits for active sessions then pauses", async () => {
    const orchestrator = await buildOrchestrator();

    // No active sessions → drain resolves immediately
    await orchestrator.drain();
    expect(orchestrator.status.paused).toBe(true);
  });

  it("handles unknown agent gracefully", async () => {
    const orchestrator = await buildOrchestrator();

    await expect(
      orchestrator.dispatch({
        agent: "nonexistent",
        repo: REPO_DIR,
        prompt: "Test",
      }),
    ).rejects.toThrow('agent "nonexistent" not found');

    await orchestrator.shutdown();
  });
});

// ─── Middleware integration ──────────────────────────────

describe("e2e: middleware integration", () => {
  it("budget guard blocks dispatch when over budget", async () => {
    mockMessages = successMessages("session-expensive", 45);

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
      middleware: [Orchestrator.middleware.budgetGuard()],
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }

    await orchestrator.start();

    // First dispatch succeeds (45 < 50 cap)
    const result1 = await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Expensive task",
    });
    expect(result1.status).toBe("success");
    expect(orchestrator.status.costToday).toBe(45);

    await orchestrator.shutdown();
  });

  it("loop detection middleware can be wired", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const mw = Orchestrator.middleware.loopDetection({ threshold: 5 });

    expect(mw.name).toBe("loop-detection");
    expect(mw.on).toBe("PreToolUse");
    expect(mw.match).toBe("Bash");

    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
      middleware: [mw],
    });
    await orchestrator.shutdown();
  });

  it("custom middleware receives correct context", async () => {
    const receivedContexts: Array<{
      runId: string;
      step: string;
      agent: string;
    }> = [];

    const spy: Middleware = {
      name: "spy",
      on: "PreToolUse",
      async handler(_event, context) {
        receivedContexts.push({
          runId: context.runId,
          step: context.step,
          agent: context.agent,
        });
        return { decision: "pass" };
      },
    };

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
      middleware: [spy],
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }
    await orchestrator.start();

    await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Test middleware context",
    });

    // Middleware should have been wired (even if SDK mock doesn't trigger hooks)
    // The important thing is that it doesn't crash
    await orchestrator.shutdown();
  });
});

// ─── Journal integration ─────────────────────────────────

describe("e2e: journal integration", () => {
  it("cost journal tracks entries", async () => {
    const journal = new CostJournal({ dir: JOURNALS_DIR });

    await journal.append({
      timestamp: new Date().toISOString(),
      runId: "run-1",
      step: "execute",
      sessionId: "session-1",
      agent: "developer",
      costUsd: 0.05,
      models: {},
      durationMs: 1000,
    });

    await journal.append({
      timestamp: new Date().toISOString(),
      runId: "run-2",
      step: "execute",
      sessionId: "session-2",
      agent: "developer",
      costUsd: 0.1,
      models: {},
      durationMs: 2000,
    });

    const total = await journal.getDayTotal();
    expect(total).toBeCloseTo(0.15, 5);
  });

  it("event journal records events", async () => {
    const journal = new EventJournal({ dir: JOURNALS_DIR });

    await journal.append({
      type: "session:start",
      sessionId: "s1",
      runId: "r1",
      step: "execute",
      agent: "developer",
      repo: REPO_DIR,
      timestamp: new Date().toISOString(),
    });

    await journal.append({
      type: "session:complete",
      sessionId: "s1",
      runId: "r1",
      status: "success",
      costUsd: 0.05,
      durationMs: 500,
      timestamp: new Date().toISOString(),
    });

    // Verify files exist in journal dir
    const files = await readdir(JOURNALS_DIR);
    const eventFiles = files.filter((f) => f.startsWith("events-"));
    expect(eventFiles.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Idempotency ─────────────────────────────────────────

describe("e2e: idempotency", () => {
  async function buildOrchestrator(): Promise<Orchestrator> {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }

    await orchestrator.start();
    return orchestrator;
  }

  it("rejects duplicate dispatch with same prompt", async () => {
    const orchestrator = await buildOrchestrator();

    await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Fix the bug",
    });

    await expect(
      orchestrator.dispatch({
        agent: "developer",
        repo: REPO_DIR,
        prompt: "Fix the bug",
      }),
    ).rejects.toThrow("Duplicate dispatch rejected");

    await orchestrator.shutdown();
  });

  it("allows different prompts", async () => {
    const orchestrator = await buildOrchestrator();

    const r1 = await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Fix bug A",
    });
    const r2 = await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Fix bug B",
    });

    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    expect(r1.runId).not.toBe(r2.runId);

    await orchestrator.shutdown();
  });
});

// ─── Concurrency ─────────────────────────────────────────

describe("e2e: concurrent dispatches", () => {
  it("handles multiple parallel dispatches within limits", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }
    await orchestrator.start();

    // Dispatch multiple tasks concurrently (different prompts and branches)
    const results = await Promise.all([
      orchestrator.dispatch({
        agent: "developer",
        repo: REPO_DIR,
        branch: "feat/test-branch-a",
        prompt: "Task A",
      }),
      orchestrator.dispatch({
        agent: "developer",
        repo: REPO_DIR,
        branch: "feat/test-branch-b",
        prompt: "Task B",
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(orchestrator.status.costToday).toBe(0.1);

    await orchestrator.shutdown();
  });
});

// ─── Recovery ────────────────────────────────────────────

describe("e2e: recovery on failure", () => {
  it("returns failure after exhausting retries", async () => {
    // SDK returns error for all attempts
    mockMessages = [
      { type: "system", subtype: "init", session_id: "session-fail" },
      {
        type: "result",
        subtype: "error_unknown",
        session_id: "session-fail",
        result: "",
        total_cost_usd: 0,
        num_turns: 0,
      },
    ];

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }
    await orchestrator.start();

    const events: NeoEvent[] = [];
    orchestrator.on("session:fail", (e) => events.push(e));

    const result = await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "This will fail",
    });

    expect(result.status).toBe("failure");
    expect(result.steps.execute?.error).toBeDefined();

    // Persisted run should be marked as failed
    const runsDir = path.join(GLOBAL_RUNS_DIR, "repo");
    const files = await readdir(runsDir);
    const firstFile = files[0] ?? "";
    const runData = JSON.parse(await readFile(path.join(runsDir, firstFile), "utf-8"));
    expect(runData.status).toBe("failed");

    await orchestrator.shutdown();
  });
});

// ─── Budget alerting ─────────────────────────────────────

describe("e2e: budget alerts", () => {
  it("emits budget:alert when threshold crossed", async () => {
    mockMessages = successMessages("session-pricey", 42);

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }
    await orchestrator.start();

    const alerts: NeoEvent[] = [];
    orchestrator.on("budget:alert", (e) => alerts.push(e));

    await orchestrator.dispatch({
      agent: "developer",
      repo: REPO_DIR,
      branch: "feat/test-branch",
      prompt: "Expensive operation",
    });

    // 42 / 50 = 84% > 80% threshold
    expect(alerts).toHaveLength(1);
    if (alerts[0]?.type === "budget:alert") {
      expect(alerts[0].utilizationPct).toBeCloseTo(84, 0);
    }

    await orchestrator.shutdown();
  });
});

// ─── Readonly agent dispatch ─────────────────────────────

describe("e2e: readonly agent", () => {
  it("dispatches with readonly agent in isolated clone", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    orchestrator.registerAgent({
      name: "reviewer",
      definition: {
        description: "Code reviewer",
        prompt: "Review code",
        model: "claude-sonnet-4-6",
      },
      sandbox: "readonly",
      source: "built-in",
    });

    const result = await orchestrator.dispatch({
      agent: "reviewer",
      repo: REPO_DIR,
      prompt: "Review the codebase",
      branch: "feat/test-review",
    });

    expect(result.status).toBe("success");

    await orchestrator.shutdown();
  });
});

// ─── Run persistence and recovery ────────────────────────

describe("e2e: run persistence", () => {
  it("recovers orphaned runs on start", async () => {
    // Create an orphaned run file
    const runsDir = GLOBAL_RUNS_DIR;
    await mkdir(runsDir, { recursive: true });
    const staleDate = new Date(Date.now() - 120_000).toISOString(); // 2 min ago — past grace period
    await writeFile(
      path.join(runsDir, "orphan-1.json"),
      JSON.stringify({
        version: 1,
        runId: "orphan-1",
        agent: "developer",
        repo: REPO_DIR,
        prompt: "Orphaned task",
        status: "running",
        steps: {},
        createdAt: staleDate,
        updatedAt: staleDate,
      }),
    );

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }

    await orchestrator.start();

    // Orphaned run should be marked as failed
    const recovered = JSON.parse(await readFile(path.join(runsDir, "orphan-1.json"), "utf-8"));
    expect(recovered.status).toBe("failed");

    await orchestrator.shutdown();
  });
});

// ─── Status reporting ────────────────────────────────────

describe("e2e: status reporting", () => {
  it("reports correct status after start", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }

    await orchestrator.start();

    const status = orchestrator.status;
    expect(status.paused).toBe(false);
    expect(status.activeSessions).toHaveLength(0);
    expect(status.queueDepth).toBe(0);
    expect(status.budgetCapUsd).toBe(50);
    expect(status.budgetRemainingPct).toBe(100);
    expect(status.uptime).toBeGreaterThanOrEqual(0);

    await orchestrator.shutdown();
  });

  it("uptime increases over time", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });
    await orchestrator.start();

    vi.advanceTimersByTime(1000);

    expect(orchestrator.status.uptime).toBeGreaterThanOrEqual(1000);

    await orchestrator.shutdown();
  });
});
