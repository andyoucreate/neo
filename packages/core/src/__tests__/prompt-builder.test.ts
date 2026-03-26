import { describe, expect, it } from "vitest";
import type { GroupedEvents } from "@/supervisor/event-queue";
import type { MemoryEntry } from "@/supervisor/memory/entry";
import {
  buildCompactionPrompt,
  buildConsolidationPrompt,
  buildIdlePrompt,
  buildStandardPrompt,
  buildWorkQueueSection,
  isIdleHeartbeat,
} from "@/supervisor/prompt-builder";
import type { TaskEntry } from "@/supervisor/task-store";

function emptyGrouped(): GroupedEvents {
  return { messages: [], webhooks: [], runCompletions: [] };
}

function makeMemory(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    type: "knowledge",
    scope: "global",
    content: "test memory",
    source: "user",
    tags: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    subtype: "fact",
    ...overrides,
  };
}

function makeTask(overrides?: Partial<TaskEntry>): TaskEntry {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 12)}`,
    title: "Test task",
    scope: "global",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    tasks: [],
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
    expect(result).toContain("<reference>");
    expect(result).toContain("</reference>");
    expect(result).toContain("<context>");
    expect(result).toContain("</context>");
    expect(result).toContain("<instructions>");
    expect(result).toContain("</instructions>");
  });

  it("includes commands section", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("neo run <agent>");
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
    expect(result).toContain("/tmp/test-supervisor/notes/");
    expect(result).toContain("neo memory write");
  });

  it("includes contextual footer", () => {
    const result = buildStandardPrompt(baseOpts());
    expect(result).toContain("yield immediately");
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
        makeMemory({ type: "knowledge", subtype: "fact", content: "Uses Prisma", accessCount: 5 }),
        makeMemory({ type: "knowledge", subtype: "fact", content: "New fact", accessCount: 1 }),
      ],
    });
    expect(result).toContain("Uses Prisma");
    expect(result).not.toContain("Uses Prisma (unconfirmed)");
    expect(result).toContain("New fact (unconfirmed)");
  });

  it("shows procedures and warnings", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memories: [
        makeMemory({ type: "knowledge", subtype: "procedure", content: "Run pnpm test:e2e" }),
        makeMemory({
          type: "warning",
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

  it("renders mix of pending/active/blocked tasks with correct markers", () => {
    const tasks = [
      makeTask({
        title: "T1: Setup auth",
        status: "pending",
      }),
      makeTask({
        title: "T2: Implement login",
        status: "in_progress",
      }),
      makeTask({
        title: "T3: Add tests",
        status: "blocked",
      }),
    ];

    const result = buildWorkQueueSection(tasks);

    // Check header
    expect(result).toContain("Work queue (3 remaining, 0 done) — dispatch the next eligible task:");

    // Check markers
    expect(result).toContain("○ T1: Setup auth"); // pending uses ○
    expect(result).toContain("[ACTIVE] T2: Implement login"); // in_progress uses [ACTIVE]
    expect(result).toContain("[BLOCKED] T3: Add tests"); // blocked uses [BLOCKED]
  });

  it("groups tasks by initiative", () => {
    const tasks = [
      makeTask({
        title: "T1: Auth middleware",
        status: "pending",
        initiative: "auth-v2",
      }),
      makeTask({
        title: "T2: JWT validation",
        status: "pending",
        initiative: "auth-v2",
      }),
      makeTask({
        title: "T3: Unrelated task",
        status: "pending",
      }),
    ];

    const result = buildWorkQueueSection(tasks);

    // Should have initiative header
    expect(result).toContain("[auth-v2]");
    expect(result).toContain("T1: Auth middleware");
    expect(result).toContain("T2: JWT validation");
    expect(result).toContain("T3: Unrelated task");
  });

  it("caps at 15 tasks and shows overflow indicator", () => {
    const tasks: TaskEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      tasks.push(
        makeTask({
          title: `Task ${i}`,
          status: "pending",
        }),
      );
    }

    const result = buildWorkQueueSection(tasks);

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
    const tasks = [
      makeTask({
        title: "T1: Done task",
        status: "done",
      }),
      makeTask({
        title: "T2: Abandoned task",
        status: "abandoned",
      }),
      makeTask({
        title: "T3: Pending task",
        status: "pending",
      }),
    ];

    const result = buildWorkQueueSection(tasks);

    // Header should show 1 remaining (pending), 2 done
    expect(result).toContain("Work queue (1 remaining, 2 done) — dispatch the next eligible task:");

    // Should only render the pending task
    expect(result).toContain("T3: Pending task");
    expect(result).not.toContain("T1: Done task");
    expect(result).not.toContain("T2: Abandoned task");
  });

  it("shows scope basename for non-global tasks", () => {
    const tasks = [
      makeTask({
        title: "Repo-specific task",
        status: "pending",
        scope: "/repos/myapp",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("(myapp)");
  });

  it("shows run reference when runId is present", () => {
    const tasks = [
      makeTask({
        title: "Task with run",
        status: "in_progress",
        runId: "run_abc123456789",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("[run run_abc1]"); // first 8 chars
  });

  it("shows priority when present", () => {
    const tasks = [
      makeTask({
        title: "High priority task",
        status: "pending",
        priority: "high",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
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
      memories: [
        makeMemory({
          type: "knowledge",
          subtype: "fact",
          content: "API key is in vault",
          accessCount: 5,
        }),
      ],
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

// ─── isIdleHeartbeat ────────────────────────────────────

describe("isIdleHeartbeat", () => {
  it("returns true when no events, no active runs, and no tasks", () => {
    const result = isIdleHeartbeat(baseOpts());
    expect(result).toBe(true);
  });

  it("returns false when there are messages", () => {
    const opts = {
      ...baseOpts(),
      grouped: {
        messages: [{ from: "user", text: "hello", count: 1 }],
        webhooks: [],
        runCompletions: [],
      },
    };
    const result = isIdleHeartbeat(opts);
    expect(result).toBe(false);
  });

  it("returns false when there are webhooks", () => {
    const opts = {
      ...baseOpts(),
      grouped: {
        messages: [],
        webhooks: [
          {
            kind: "webhook" as const,
            timestamp: new Date().toISOString(),
            data: {
              receivedAt: new Date().toISOString(),
              source: "github",
              event: "push",
              payload: {},
            },
          },
        ],
        runCompletions: [],
      },
    };
    const result = isIdleHeartbeat(opts);
    expect(result).toBe(false);
  });

  it("returns false when there are run completions", () => {
    const opts = {
      ...baseOpts(),
      grouped: {
        messages: [],
        webhooks: [],
        runCompletions: [
          {
            kind: "run_complete" as const,
            timestamp: new Date().toISOString(),
            runId: "run-123",
          },
        ],
      },
    };
    const result = isIdleHeartbeat(opts);
    expect(result).toBe(false);
  });

  it("returns false when there are active runs", () => {
    const opts = {
      ...baseOpts(),
      activeRuns: ["run-abc"],
    };
    const result = isIdleHeartbeat(opts);
    expect(result).toBe(false);
  });

  it("returns false when there are pending tasks", () => {
    const opts = {
      ...baseOpts(),
      tasks: [
        makeTask({
          title: "Pending work",
          status: "pending",
        }),
      ],
    };
    const result = isIdleHeartbeat(opts);
    expect(result).toBe(false);
  });

  it("returns false when done/abandoned tasks exist (completion message shown)", () => {
    // When done tasks exist, buildWorkQueueSection returns a non-empty string
    // ("all tasks complete") which isIdleHeartbeat interprets as having work
    const opts = {
      ...baseOpts(),
      tasks: [
        makeTask({
          title: "Done task",
          status: "done",
        }),
        makeTask({
          title: "Abandoned task",
          status: "abandoned",
        }),
      ],
    };
    const result = isIdleHeartbeat(opts);
    expect(result).toBe(false);
  });
});

// ─── buildIdlePrompt ────────────────────────────────────

describe("buildIdlePrompt", () => {
  it("includes role and heartbeat number", () => {
    const result = buildIdlePrompt(baseOpts());
    expect(result).toContain("neo autonomous supervisor");
    expect(result).toContain("Heartbeat #10");
  });

  it("uses XML tag structure with role, context, and directive", () => {
    const result = buildIdlePrompt(baseOpts());
    expect(result).toContain("<role>");
    expect(result).toContain("</role>");
    expect(result).toContain("<context>");
    expect(result).toContain("</context>");
    expect(result).toContain("<directive>");
    expect(result).toContain("</directive>");
  });

  it("includes idle state message", () => {
    const result = buildIdlePrompt(baseOpts());
    expect(result).toContain("No events. No active runs. No pending tasks.");
  });

  it("includes budget status", () => {
    const result = buildIdlePrompt(baseOpts());
    expect(result).toContain("$5.00 / $50.00");
    expect(result).toContain("90% remaining");
  });

  it("yields when repos and budget available", () => {
    const result = buildIdlePrompt(baseOpts());
    expect(result).toContain("Nothing to do");
    expect(result).not.toContain("scout");
  });

  it("yields without scout when no repos configured", () => {
    const opts = { ...baseOpts(), repos: [] };
    const result = buildIdlePrompt(opts);
    expect(result).toContain("Nothing to do");
    expect(result).not.toContain("scout");
  });

  it("yields without scout when budget is low", () => {
    const opts = {
      ...baseOpts(),
      budgetStatus: { todayUsd: 48, capUsd: 50, remainingPct: 4 },
    };
    const result = buildIdlePrompt(opts);
    expect(result).toContain("Nothing to do");
    expect(result).not.toContain("scout");
  });

  it("waits for pending decisions instead of scouting", () => {
    const opts = {
      ...baseOpts(),
      pendingDecisions: [
        {
          id: "dec_123",
          question: "Fix SQL injection?",
          type: "approval",
          options: [{ key: "yes", label: "Fix" }],
          source: "agent:reviewer",
          createdAt: "2024-01-15T10:00:00.000Z",
        },
      ],
    };
    const result = buildIdlePrompt(opts);
    expect(result).toContain("pending decision");
    expect(result).toContain("dec_123");
    expect(result).not.toContain("neo run scout");
  });

  it("is smaller than standard prompt", () => {
    const idlePrompt = buildIdlePrompt(baseOpts());
    const standardPrompt = buildStandardPrompt(baseOpts());
    expect(idlePrompt.length).toBeLessThan(standardPrompt.length);
  });

  it("respects custom budget values", () => {
    const opts = {
      ...baseOpts(),
      budgetStatus: { todayUsd: 42.5, capUsd: 100, remainingPct: 57.5 },
    };
    const result = buildIdlePrompt(opts);
    expect(result).toContain("$42.50 / $100.00");
    expect(result).toContain("58% remaining"); // Rounded
  });
});

// ─── buildCompactionPrompt ──────────────────────────────

describe("buildCompactionPrompt", () => {
  it("includes COMPACTION label in header", () => {
    const result = buildCompactionPrompt(baseOpts());
    expect(result).toContain("(COMPACTION)");
  });

  it("includes heartbeat number", () => {
    const opts = { ...baseOpts(), heartbeatCount: 50 };
    const result = buildCompactionPrompt(opts);
    expect(result).toContain("Heartbeat #50");
  });

  it("uses XML tag structure", () => {
    const result = buildCompactionPrompt(baseOpts());
    expect(result).toContain("<role>");
    expect(result).toContain("</role>");
    expect(result).toContain("<context>");
    expect(result).toContain("</context>");
    expect(result).toContain("<reference>");
    expect(result).toContain("</reference>");
    expect(result).toContain("<instructions>");
    expect(result).toContain("</instructions>");
  });

  it("includes memory cleanup instructions", () => {
    const result = buildCompactionPrompt(baseOpts());
    expect(result).toContain("Remove stale facts");
    expect(result).toContain("Merge duplicates");
    expect(result).toContain("neo memory forget");
  });

  it("includes memory entries in context", () => {
    const result = buildCompactionPrompt({
      ...baseOpts(),
      memories: [
        makeMemory({
          type: "knowledge",
          subtype: "fact",
          content: "Old fact to review",
          accessCount: 5,
        }),
      ],
    });
    expect(result).toContain("Known facts:");
    expect(result).toContain("Old fact to review");
  });

  it("includes work queue section", () => {
    const result = buildCompactionPrompt({
      ...baseOpts(),
      tasks: [
        makeTask({
          title: "Task to prune",
          status: "pending",
        }),
      ],
    });
    expect(result).toContain("Work queue");
    expect(result).toContain("Task to prune");
  });

  it("includes guidance for fact limit per scope", () => {
    const result = buildCompactionPrompt(baseOpts());
    expect(result).toContain("15 facts per scope");
  });

  it("includes custom instructions when provided", () => {
    const result = buildCompactionPrompt({
      ...baseOpts(),
      customInstructions: "Keep security-related facts.",
    });
    expect(result).toContain("Custom instructions");
    expect(result).toContain("Keep security-related facts.");
  });
});

// ─── buildWorkQueueSection edge cases ───────────────────

describe("buildWorkQueueSection edge cases", () => {
  it("shows context command when present", () => {
    const tasks = [
      makeTask({
        title: "Task with context",
        status: "pending",
        context: "neo runs abc123",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("→ neo runs abc123");
  });

  it("handles task with all metadata fields", () => {
    const tasks = [
      makeTask({
        title: "Full metadata task",
        status: "in_progress",
        priority: "critical",
        scope: "/repos/my-app",
        runId: "run_xyz789",
        context: "cat notes/plan.md",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("[ACTIVE]");
    expect(result).toContain("[critical]");
    expect(result).toContain("(my-app)");
    expect(result).toContain("[run run_xyz7]");
    expect(result).toContain("→ cat notes/plan.md");
  });

  it("handles multiple initiatives with correct grouping", () => {
    const tasks = [
      makeTask({
        title: "Auth task 1",
        status: "pending",
        initiative: "auth-v2",
      }),
      makeTask({
        title: "Billing task 1",
        status: "pending",
        initiative: "billing",
      }),
      makeTask({
        title: "Auth task 2",
        status: "pending",
        initiative: "auth-v2",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("[auth-v2]");
    expect(result).toContain("[billing]");
  });

  it("shows completion message when all tasks are done", () => {
    const tasks = [
      makeTask({
        title: "Completed task",
        status: "done",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("0 remaining");
    expect(result).toContain("1 done");
    expect(result).toContain("all tasks complete");
  });

  it("handles all priority levels", () => {
    const priorities = ["critical", "high", "medium", "low"] as const;
    const tasks = priorities.map((priority) =>
      makeTask({
        title: `${priority} priority task`,
        status: "pending",
        priority,
      }),
    );

    const result = buildWorkQueueSection(tasks);
    for (const prio of priorities) {
      expect(result).toContain(`[${prio}]`);
    }
  });

  it("handles pending status correctly", () => {
    const tasks = [
      makeTask({
        title: "Pending task",
        status: "pending",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("○ Pending task");
  });

  it("does not show initiative header when only one group exists", () => {
    const tasks = [
      makeTask({
        title: "Single initiative task 1",
        status: "pending",
        initiative: "only-one",
      }),
      makeTask({
        title: "Single initiative task 2",
        status: "pending",
        initiative: "only-one",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    // When there's only one group, the initiative header is not shown
    expect(result).not.toContain("[only-one]");
  });

  it("handles empty scope path gracefully", () => {
    const tasks = [
      makeTask({
        title: "Empty scope task",
        status: "pending",
        scope: "",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    // Should not crash and should show the task
    expect(result).toContain("Empty scope task");
  });

  it("handles mixed pending and blocked tasks correctly", () => {
    const tasks = [
      makeTask({
        title: "Blocked task",
        status: "blocked",
      }),
      makeTask({
        title: "Pending task",
        status: "pending",
      }),
    ];

    const result = buildWorkQueueSection(tasks);
    expect(result).toContain("[BLOCKED] Blocked task");
    expect(result).toContain("○ Pending task");
    expect(result).toContain("2 remaining");
  });

  it("uses compact mode for initiatives with 3+ tasks and shows initiative summary", () => {
    const tasks = [
      makeTask({
        title: "T1: Setup database",
        status: "pending",
        priority: "high",
        initiative: "data-pipeline",
      }),
      makeTask({
        title: "T2: Create migrations",
        status: "pending",
        priority: "medium",
        initiative: "data-pipeline",
      }),
      makeTask({
        title: "T3: Add seed data",
        status: "pending",
        priority: "low",
        initiative: "data-pipeline",
      }),
    ];

    const result = buildWorkQueueSection(tasks);

    // Compact mode should show initiative summary line
    expect(result).toContain("[data-pipeline] 0 active, 3 pending");
    // Should show next eligible task in summary (highest priority first = T1)
    expect(result).toContain("(next: T1: Setup database [high])");
  });

  it("sorts pending tasks by priority in (next: ...) summary", () => {
    const tasks = [
      makeTask({
        title: "Low priority task",
        status: "pending",
        priority: "low",
        initiative: "sort-test",
      }),
      makeTask({
        title: "Critical priority task",
        status: "pending",
        priority: "critical",
        initiative: "sort-test",
      }),
      makeTask({
        title: "Medium priority task",
        status: "pending",
        priority: "medium",
        initiative: "sort-test",
      }),
    ];

    const result = buildWorkQueueSection(tasks);

    // Critical task should appear in (next: ...) because it has highest priority
    expect(result).toContain("(next: Critical priority task [critical])");
    // Low and medium should NOT appear in (next: ...)
    expect(result).not.toContain("(next: Low priority task");
    expect(result).not.toContain("(next: Medium priority task");
  });
});
