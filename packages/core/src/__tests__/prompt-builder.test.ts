import { describe, expect, it } from "vitest";
import type { GroupedEvents } from "@/supervisor/event-queue";
import type { MemoryEntry } from "@/supervisor/memory/entry";
import {
  buildConsolidationPrompt,
  buildStandardPrompt,
  buildWorkQueueSection,
} from "@/supervisor/prompt-builder";

function emptyGrouped(): GroupedEvents {
  return { messages: [], webhooks: [], runCompletions: [] };
}

function makeMemory(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    type: "fact",
    scope: "global",
    content: "test memory",
    source: "user",
    tags: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    ...overrides,
  };
}

function baseOpts() {
  return {
    repos: [
      {
        path: "/repos/myapp",
        defaultBranch: "main",
        branchPrefix: "feat/",
        pushRemote: "origin",
        gitStrategy: "pr" as const,
      },
    ],
    grouped: emptyGrouped(),
    budgetStatus: { todayUsd: 5, capUsd: 50, remainingPct: 90 },
    activeRuns: [],
    heartbeatCount: 10,
    mcpServerNames: [],
    supervisorDir: "/tmp/test-supervisor",
    memories: [],
    recentActions: [],
  };
}

// ─── buildStandardPrompt ────────────────────────────────

describe("buildStandardPrompt", () => {
  it("includes role and heartbeat number", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("neo autonomous supervisor");
    expect(result).toContain("Heartbeat #10");
  });

  it("uses XML tag structure", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("<role>");
    expect(result).toContain("</role>");
    expect(result).toContain("<commands>");
    expect(result).toContain("</commands>");
    expect(result).toContain("<context>");
    expect(result).toContain("</context>");
    expect(result).toContain("<instructions>");
    expect(result).toContain("</instructions>");
  });

  it("includes commands section", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("neo run <agent>");
    expect(result).toContain("neo runs --short");
  });

  it("includes reporting rules with neo memory write", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("neo memory write");
    expect(result).toContain("neo log");
  });

  it("includes budget status", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("$5.00 / $50.00");
    expect(result).toContain("90% remaining");
  });

  it("includes focus section with empty state", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("<focus>");
    expect(result).toContain("</focus>");
    expect(result).toContain("neo memory write");
  });

  it("includes focus content when provided via memories", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memories: [
        makeMemory({ type: "focus", content: "Working on auth deploy." }),
        makeMemory({ type: "focus", content: "Waiting for run abc123." }),
      ],
    });
    expect(result).toContain("Working on auth deploy");
    expect(result).toContain("Waiting for run abc123");
  });

  it("includes memory guidance", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("Memory");
    expect(result).toContain("Notes");
    expect(result).toContain("neo memory write");
  });

  it("includes standard heartbeat footer", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("standard heartbeat");
  });

  it("includes custom instructions when provided", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      customInstructions: "Always prioritize security tasks.",
    });
    expect(result).toContain("Custom instructions");
    expect(result).toContain("Always prioritize security tasks.");
  });

  it("includes MCP integrations when configured", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      mcpServerNames: ["linear", "github"],
    });
    expect(result).toContain("Integrations (MCP)");
    expect(result).toContain("- linear");
    expect(result).toContain("- github");
  });

  it("includes repos list", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("Repositories:");
    expect(result).toContain("/repos/myapp (branch: main)");
  });

  it("shows facts with confidence indicator", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memories: [
        makeMemory({ type: "fact", content: "Uses Prisma", accessCount: 5 }),
        makeMemory({ type: "fact", content: "New fact", accessCount: 1 }),
      ],
    });
    expect(result).toContain("Uses Prisma");
    expect(result).not.toContain("Uses Prisma (unconfirmed)");
    expect(result).toContain("New fact (unconfirmed)");
  });

  it("shows procedures and feedback", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memories: [
        makeMemory({ type: "procedure", content: "Run pnpm test:e2e" }),
        makeMemory({
          type: "feedback",
          content: "Missing validation",
          category: "input_validation",
        }),
      ],
    });
    expect(result).toContain("Procedures:");
    expect(result).toContain("Run pnpm test:e2e");
    expect(result).toContain("Recurring review issues:");
    expect(result).toContain("[input_validation] Missing validation");
  });
});

// ─── buildConsolidationPrompt ───────────────────────────

// ─── buildWorkQueueSection ──────────────────────────────

describe("buildWorkQueueSection", () => {
  it("returns empty string for empty task list", () => {
    const result = buildWorkQueueSection([]);
    expect(result).toBe("");
  });

  it("returns empty string when no active tasks exist", () => {
    const memories = [
      makeMemory({ type: "fact", content: "Some fact" }),
      makeMemory({ type: "procedure", content: "Some procedure" }),
    ];
    const result = buildWorkQueueSection(memories);
    expect(result).toBe("");
  });

  it("renders mix of pending/active/blocked tasks with correct markers", () => {
    const memories = [
      makeMemory({
        type: "task",
        content: "T1: Setup auth",
        outcome: "pending",
      }),
      makeMemory({
        type: "task",
        content: "T2: Implement login",
        outcome: "in_progress",
      }),
      makeMemory({
        type: "task",
        content: "T3: Add tests",
        outcome: "blocked",
      }),
    ];

    const result = buildWorkQueueSection(memories);

    // Check header
    expect(result).toContain("Work queue (3 remaining, 0 done) — dispatch the next eligible task:");

    // Check markers
    expect(result).toContain("○ T1: Setup auth"); // pending uses ○
    expect(result).toContain("[ACTIVE] T2: Implement login"); // in_progress uses [ACTIVE]
    expect(result).toContain("[BLOCKED] T3: Add tests"); // blocked uses [BLOCKED]
  });

  it("groups tasks by initiative tag", () => {
    const memories = [
      makeMemory({
        type: "task",
        content: "T1: Auth middleware",
        outcome: "pending",
        tags: ["initiative:auth-v2"],
      }),
      makeMemory({
        type: "task",
        content: "T2: JWT validation",
        outcome: "pending",
        tags: ["initiative:auth-v2"],
      }),
      makeMemory({
        type: "task",
        content: "T3: Unrelated task",
        outcome: "pending",
        tags: [],
      }),
    ];

    const result = buildWorkQueueSection(memories);

    // Should have initiative header
    expect(result).toContain("[auth-v2]");
    expect(result).toContain("T1: Auth middleware");
    expect(result).toContain("T2: JWT validation");
    expect(result).toContain("T3: Unrelated task");
  });

  it("caps at 15 tasks and shows overflow indicator", () => {
    const memories: MemoryEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      memories.push(
        makeMemory({
          type: "task",
          content: `Task ${i}`,
          outcome: "pending",
        }),
      );
    }

    const result = buildWorkQueueSection(memories);

    // Should show 15 tasks max
    expect(result).toContain("Task 1");
    expect(result).toContain("Task 15");

    // Should NOT show task 16-20 directly
    expect(result).not.toContain("○ Task 16");
    expect(result).not.toContain("○ Task 20");

    // Should show overflow indicator
    expect(result).toContain("... and 5 more pending");
  });

  it("excludes done and abandoned tasks from active count", () => {
    const memories = [
      makeMemory({
        type: "task",
        content: "T1: Done task",
        outcome: "done",
      }),
      makeMemory({
        type: "task",
        content: "T2: Abandoned task",
        outcome: "abandoned",
      }),
      makeMemory({
        type: "task",
        content: "T3: Pending task",
        outcome: "pending",
      }),
    ];

    const result = buildWorkQueueSection(memories);

    // Header should show 1 remaining (pending), 2 done
    expect(result).toContain("Work queue (1 remaining, 2 done) — dispatch the next eligible task:");

    // Should only render the pending task
    expect(result).toContain("T3: Pending task");
    expect(result).not.toContain("T1: Done task");
    expect(result).not.toContain("T2: Abandoned task");
  });

  it("shows scope basename for non-global tasks", () => {
    const memories = [
      makeMemory({
        type: "task",
        content: "Repo-specific task",
        outcome: "pending",
        scope: "/repos/myapp",
      }),
    ];

    const result = buildWorkQueueSection(memories);
    expect(result).toContain("(myapp)");
  });

  it("shows run reference when runId is present", () => {
    const memories = [
      makeMemory({
        type: "task",
        content: "Task with run",
        outcome: "in_progress",
        runId: "run_abc123456789",
      }),
    ];

    const result = buildWorkQueueSection(memories);
    expect(result).toContain("[run run_abc1]"); // first 8 chars
  });

  it("shows severity when present", () => {
    const memories = [
      makeMemory({
        type: "task",
        content: "High priority task",
        outcome: "pending",
        severity: "high",
      }),
    ];

    const result = buildWorkQueueSection(memories);
    expect(result).toContain("[high]");
  });
});

// ─── buildConsolidationPrompt ───────────────────────────

describe("buildConsolidationPrompt", () => {
  it("includes CONSOLIDATION label in header", () => {
    const result = buildConsolidationPrompt(baseOpts());
    expect(result).toContain("(CONSOLIDATION)");
  });

  it("includes memory entries in context", () => {
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memories: [makeMemory({ type: "fact", content: "API key is in vault", accessCount: 5 })],
    });
    expect(result).toContain("Known facts:");
    expect(result).toContain("API key is in vault");
  });

  it("includes neo memory write instructions", () => {
    const result = buildConsolidationPrompt(baseOpts());
    expect(result).toContain("neo memory write");
    expect(result).toContain("neo memory forget");
  });

  it("does NOT include the standard heartbeat footer", () => {
    const result = buildConsolidationPrompt(baseOpts());
    expect(result).not.toContain("This is a standard heartbeat");
  });

  it("includes focus section", () => {
    const result = buildConsolidationPrompt(baseOpts());
    expect(result).toContain("<focus>");
    expect(result).toContain("</focus>");
  });

  it("includes consolidation instructions", () => {
    const result = buildConsolidationPrompt(baseOpts());
    expect(result).toContain("CONSOLIDATION heartbeat");
    expect(result).toContain("Review memory");
  });
});
