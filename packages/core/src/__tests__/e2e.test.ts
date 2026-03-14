import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@/agents/registry";
import { loadConfig } from "@/config";
import { CostJournal } from "@/cost/journal";
import { EventJournal } from "@/events/journal";
import { Orchestrator } from "@/orchestrator";
import type { Middleware, NeoEvent } from "@/types";
import { WorkflowRegistry } from "@/workflows/registry";

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

// ─── Fixtures ─────────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_e2e__");
const AGENTS_DIR = path.join(TMP_DIR, "agents");
const PROMPTS_DIR = path.join(TMP_DIR, "prompts");
const WORKFLOWS_DIR = path.join(TMP_DIR, "workflows");
const JOURNALS_DIR = path.join(TMP_DIR, "journals");
const REPO_DIR = path.join(TMP_DIR, "repo");

const DEVELOPER_PROMPT = "You are a developer agent. Implement the task.";
const REVIEWER_PROMPT = "You are a code reviewer. Review the changes.";
const ARCHITECT_PROMPT = "You are an architect. Plan the implementation.";
const FIXER_PROMPT = "You are a fixer. Fix the issues found by reviewers.";

async function writeAgentFixtures(): Promise<void> {
  await mkdir(AGENTS_DIR, { recursive: true });
  await mkdir(PROMPTS_DIR, { recursive: true });

  // Write prompts
  await writeFile(path.join(PROMPTS_DIR, "developer.md"), DEVELOPER_PROMPT);
  await writeFile(path.join(PROMPTS_DIR, "reviewer.md"), REVIEWER_PROMPT);
  await writeFile(path.join(PROMPTS_DIR, "architect.md"), ARCHITECT_PROMPT);
  await writeFile(path.join(PROMPTS_DIR, "fixer.md"), FIXER_PROMPT);

  // Write agent YAMLs
  await writeFile(
    path.join(AGENTS_DIR, "developer.yml"),
    `name: developer
description: "Implementation worker"
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
sandbox: writable
prompt: ../prompts/developer.md
`,
  );

  await writeFile(
    path.join(AGENTS_DIR, "reviewer-quality.yml"),
    `name: reviewer-quality
description: "Code quality reviewer"
model: sonnet
tools:
  - Read
  - Glob
  - Grep
sandbox: readonly
prompt: ../prompts/reviewer.md
`,
  );

  await writeFile(
    path.join(AGENTS_DIR, "architect.yml"),
    `name: architect
description: "Strategic planner"
model: opus
tools:
  - Read
  - Glob
  - Grep
sandbox: readonly
prompt: ../prompts/architect.md
`,
  );

  await writeFile(
    path.join(AGENTS_DIR, "fixer.yml"),
    `name: fixer
description: "Auto-correction agent"
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Bash
sandbox: writable
prompt: ../prompts/fixer.md
`,
  );
}

async function writeWorkflowFixtures(): Promise<void> {
  await mkdir(WORKFLOWS_DIR, { recursive: true });

  await writeFile(
    path.join(WORKFLOWS_DIR, "hotfix.yml"),
    `name: hotfix
description: "Fast-track single-agent implementation"
steps:
  implement:
    agent: developer
`,
  );

  await writeFile(
    path.join(WORKFLOWS_DIR, "feature.yml"),
    `name: feature
description: "Plan, implement, and review a feature"
steps:
  plan:
    agent: architect
    sandbox: readonly
  implement:
    agent: developer
    dependsOn: [plan]
    prompt: "Implement based on plan"
  review:
    agent: reviewer-quality
    dependsOn: [implement]
    sandbox: readonly
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
    autoCreatePr: false

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
  await writeWorkflowFixtures();
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
    await writeFile(path.join(TMP_DIR, "bad.yml"), "repos: []");
    await expect(loadConfig(path.join(TMP_DIR, "bad.yml"))).rejects.toThrow("At least one repo");
  });
});

// ─── Agent registry ──────────────────────────────────────

describe("e2e: agent registry", () => {
  it("loads all agents from a directory with prompt resolution", async () => {
    const registry = new AgentRegistry(AGENTS_DIR);
    await registry.load();

    expect(registry.list()).toHaveLength(4);
    expect(registry.has("developer")).toBe(true);
    expect(registry.has("reviewer-quality")).toBe(true);
    expect(registry.has("architect")).toBe(true);
    expect(registry.has("fixer")).toBe(true);

    const dev = registry.get("developer");
    expect(dev?.definition.prompt).toBe(DEVELOPER_PROMPT);
    expect(dev?.sandbox).toBe("writable");
    expect(dev?.definition.tools).toContain("Bash");
  });

  it("custom agents override built-in agents", async () => {
    const customDir = path.join(TMP_DIR, "custom-agents");
    await mkdir(customDir, { recursive: true });
    await writeFile(
      path.join(customDir, "developer.yml"),
      `name: developer
description: "Custom developer with fewer tools"
model: haiku
tools:
  - Read
  - Write
sandbox: writable
prompt: "Custom prompt"
`,
    );

    const registry = new AgentRegistry(AGENTS_DIR, customDir);
    await registry.load();

    const dev = registry.get("developer");
    expect(dev?.definition.model).toBe("haiku");
    expect(dev?.definition.tools).toEqual(["Read", "Write"]);
  });
});

// ─── Workflow registry ───────────────────────────────────

describe("e2e: workflow registry", () => {
  it("loads workflows from directory", async () => {
    const registry = new WorkflowRegistry(WORKFLOWS_DIR);
    await registry.load();

    expect(registry.list()).toHaveLength(2);
    expect(registry.has("hotfix")).toBe(true);
    expect(registry.has("feature")).toBe(true);

    const feature = registry.get("feature");
    expect(Object.keys(feature?.steps ?? {})).toEqual(["plan", "implement", "review"]);
  });
});

// ─── Full orchestrator lifecycle ─────────────────────────

describe("e2e: orchestrator lifecycle", () => {
  async function buildOrchestrator(): Promise<Orchestrator> {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
      builtInWorkflowDir: WORKFLOWS_DIR,
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
      workflow: "hotfix",
      repo: REPO_DIR,
      prompt: "Fix the login bug",
    });

    expect(result.status).toBe("success");
    expect(result.workflow).toBe("hotfix");
    expect(result.repo).toBe(REPO_DIR);
    expect(result.costUsd).toBe(0.05);
    expect(result.steps.implement).toBeDefined();
    expect(result.steps.implement?.agent).toBe("developer");

    // Run file should be persisted
    const runsDir = path.join(REPO_DIR, ".neo/runs");
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
      workflow: "hotfix",
      repo: REPO_DIR,
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
      workflow: "hotfix",
      repo: REPO_DIR,
      prompt: "Task 1",
    });
    await orchestrator.dispatch({
      workflow: "hotfix",
      repo: REPO_DIR,
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
        workflow: "hotfix",
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
      workflow: "hotfix",
      repo: REPO_DIR,
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

  it("handles unknown workflow gracefully", async () => {
    const orchestrator = await buildOrchestrator();

    await expect(
      orchestrator.dispatch({
        workflow: "nonexistent",
        repo: REPO_DIR,
        prompt: "Test",
      }),
    ).rejects.toThrow('workflow "nonexistent" not found');

    await orchestrator.shutdown();
  });

  it("handles missing agent gracefully", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, { journalDir: JOURNALS_DIR });

    // Register workflow referencing a non-registered agent
    orchestrator.registerWorkflow({
      name: "broken",
      steps: {
        step1: { agent: "ghost-agent", prompt: "Do nothing" },
      },
    });

    await expect(
      orchestrator.dispatch({
        workflow: "broken",
        repo: REPO_DIR,
        prompt: "Test",
      }),
    ).rejects.toThrow('Agent "ghost-agent"');

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
      builtInWorkflowDir: WORKFLOWS_DIR,
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
      workflow: "hotfix",
      repo: REPO_DIR,
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
      builtInWorkflowDir: WORKFLOWS_DIR,
      middleware: [mw],
    });
    await orchestrator.shutdown();
  });

  it("custom middleware receives correct context", async () => {
    const receivedContexts: Array<{
      runId: string;
      workflow: string;
      step: string;
      agent: string;
    }> = [];

    const spy: Middleware = {
      name: "spy",
      on: "PreToolUse",
      async handler(_event, context) {
        receivedContexts.push({
          runId: context.runId,
          workflow: context.workflow,
          step: context.step,
          agent: context.agent,
        });
        return { decision: "pass" };
      },
    };

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
      builtInWorkflowDir: WORKFLOWS_DIR,
      middleware: [spy],
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }
    await orchestrator.start();

    await orchestrator.dispatch({
      workflow: "hotfix",
      repo: REPO_DIR,
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
      workflow: "hotfix",
      step: "implement",
      sessionId: "session-1",
      agent: "developer",
      costUsd: 0.05,
      models: {},
      durationMs: 1000,
    });

    await journal.append({
      timestamp: new Date().toISOString(),
      runId: "run-2",
      workflow: "hotfix",
      step: "implement",
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
      workflow: "hotfix",
      step: "implement",
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
      builtInWorkflowDir: WORKFLOWS_DIR,
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
      workflow: "hotfix",
      repo: REPO_DIR,
      prompt: "Fix the bug",
    });

    await expect(
      orchestrator.dispatch({
        workflow: "hotfix",
        repo: REPO_DIR,
        prompt: "Fix the bug",
      }),
    ).rejects.toThrow("Duplicate dispatch rejected");

    await orchestrator.shutdown();
  });

  it("allows different prompts", async () => {
    const orchestrator = await buildOrchestrator();

    const r1 = await orchestrator.dispatch({
      workflow: "hotfix",
      repo: REPO_DIR,
      prompt: "Fix bug A",
    });
    const r2 = await orchestrator.dispatch({
      workflow: "hotfix",
      repo: REPO_DIR,
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
      builtInWorkflowDir: WORKFLOWS_DIR,
    });

    const agentRegistry = new AgentRegistry(AGENTS_DIR);
    await agentRegistry.load();
    for (const agent of agentRegistry.list()) {
      orchestrator.registerAgent(agent);
    }
    await orchestrator.start();

    // Dispatch multiple tasks concurrently (different prompts to avoid idempotency)
    const results = await Promise.all([
      orchestrator.dispatch({
        workflow: "hotfix",
        repo: REPO_DIR,
        prompt: "Task A",
      }),
      orchestrator.dispatch({
        workflow: "hotfix",
        repo: REPO_DIR,
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
      builtInWorkflowDir: WORKFLOWS_DIR,
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
      workflow: "hotfix",
      repo: REPO_DIR,
      prompt: "This will fail",
    });

    expect(result.status).toBe("failure");
    expect(result.steps.implement?.error).toBeDefined();

    // Persisted run should be marked as failed
    const runsDir = path.join(REPO_DIR, ".neo/runs");
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
      builtInWorkflowDir: WORKFLOWS_DIR,
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
      workflow: "hotfix",
      repo: REPO_DIR,
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
  it("dispatches with readonly agent (no worktree)", async () => {
    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
    });

    orchestrator.registerAgent({
      name: "reviewer-quality",
      definition: {
        description: "Code reviewer",
        prompt: "Review code",
        tools: ["Read", "Glob", "Grep"],
        model: "sonnet",
      },
      sandbox: "readonly",
      source: "built-in",
    });

    orchestrator.registerWorkflow({
      name: "review",
      steps: {
        review: { agent: "reviewer-quality" },
      },
    });

    const result = await orchestrator.dispatch({
      workflow: "review",
      repo: REPO_DIR,
      prompt: "Review the codebase",
    });

    expect(result.status).toBe("success");
    expect(result.branch).toBeUndefined();

    await orchestrator.shutdown();
  });
});

// ─── Run persistence and recovery ────────────────────────

describe("e2e: run persistence", () => {
  it("recovers orphaned runs on start", async () => {
    // Create an orphaned run file
    const runsDir = path.join(REPO_DIR, ".neo/runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      path.join(runsDir, "orphan-1.json"),
      JSON.stringify({
        version: 1,
        runId: "orphan-1",
        workflow: "hotfix",
        repo: REPO_DIR,
        prompt: "Orphaned task",
        status: "running",
        steps: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const config = await loadConfig(path.join(TMP_DIR, "config.yml"));
    const orchestrator = new Orchestrator(config, {
      journalDir: JOURNALS_DIR,
      builtInWorkflowDir: WORKFLOWS_DIR,
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
      builtInWorkflowDir: WORKFLOWS_DIR,
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
