import { describe, expect, it } from "vitest";
import type { GroupedEvents } from "@/supervisor/event-queue";
import type { SupervisorMemory } from "@/supervisor/memory";
import {
  buildConsolidationPrompt,
  buildStandardPrompt,
  renderHotState,
} from "@/supervisor/prompt-builder";
import type { LogBufferEntry } from "@/supervisor/schemas";

function emptyMemory(): SupervisorMemory {
  return {
    agenda: "",
    activeWork: [],
    blockers: [],
    decisions: [],
    trackerSync: {},
  };
}

function makeEntry(overrides?: Partial<LogBufferEntry>): LogBufferEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "progress",
    message: "doing work",
    target: "digest",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function emptyGrouped(): GroupedEvents {
  return { messages: [], webhooks: [], runCompletions: [] };
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
  };
}

// ─── renderHotState ─────────────────────────────────────

describe("renderHotState", () => {
  const now = new Date("2026-03-15T14:00:00Z");

  it("returns empty message when no active work or blockers", () => {
    const result = renderHotState(emptyMemory(), [], now);
    expect(result).toBe("No active work or blockers.");
  });

  it("renders active work items with duration and status", () => {
    const memory = emptyMemory();
    memory.activeWork = [
      {
        description: "PROJ-42 developer",
        runId: "abc12345-6789",
        status: "running",
        since: "2026-03-15T11:29:00Z",
        priority: "high",
      },
    ];

    const result = renderHotState(memory, [], now);
    expect(result).toContain("activeWork:");
    expect(result).toContain("[RUNNING 2h31m]");
    expect(result).toContain("PROJ-42 developer");
    expect(result).toContain("(run abc12345)");
  });

  it("shows deadline warning when within 2 hours", () => {
    const memory = emptyMemory();
    memory.activeWork = [
      {
        description: "urgent task",
        status: "running",
        since: "2026-03-15T13:00:00Z",
        deadline: "2026-03-15T15:30:00Z",
      },
    ];

    const result = renderHotState(memory, [], now);
    expect(result).toContain("⚠ deadline:");
  });

  it("does NOT show deadline warning when more than 2 hours away", () => {
    const memory = emptyMemory();
    memory.activeWork = [
      {
        description: "task with far deadline",
        status: "running",
        since: "2026-03-15T13:00:00Z",
        deadline: "2026-03-15T20:00:00Z",
      },
    ];

    const result = renderHotState(memory, [], now);
    expect(result).not.toContain("⚠ deadline:");
  });

  it("renders blockers with duration and source", () => {
    const memory = emptyMemory();
    memory.blockers = [
      {
        description: "merge conflict on feat/auth",
        source: "fixer",
        runId: "def23456-7890",
        since: "2026-03-15T13:15:00Z",
      },
    ];

    const result = renderHotState(memory, [], now);
    expect(result).toContain("blockers:");
    expect(result).toContain("[45m]");
    expect(result).toContain("merge conflict on feat/auth");
    expect(result).toContain("(reported by fixer/def23456)");
  });

  it("adds pending entries as [NEW] items", () => {
    const entries = [
      makeEntry({ type: "blocker", message: "CI timeout on tests" }),
      makeEntry({ type: "progress", message: "Building feature X", agent: "dev1" }),
    ];

    const result = renderHotState(emptyMemory(), entries, now);
    expect(result).toContain("[NEW] CI timeout on tests");
    expect(result).toContain("[NEW]");
  });

  it("does not duplicate entries already in memory", () => {
    const memory = emptyMemory();
    memory.activeWork = [
      { description: "task A", status: "running", since: "2026-03-15T13:00:00Z" },
    ];

    // computeHotState will include "task A" — renderHotState should not duplicate it
    const result = renderHotState(memory, [], now);
    const matches = result.match(/task A/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("formats short durations correctly", () => {
    const memory = emptyMemory();
    memory.activeWork = [
      { description: "just started", status: "waiting", since: "2026-03-15T13:55:00Z" },
    ];

    const result = renderHotState(memory, [], now);
    expect(result).toContain("[WAITING 5m]");
  });
});

// ─── buildStandardPrompt ────────────────────────────────

describe("buildStandardPrompt", () => {
  it("includes role and heartbeat number", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).toContain("neo autonomous supervisor");
    expect(result).toContain("Heartbeat #10");
  });

  it("includes commands section", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).toContain("neo run <agent>");
    expect(result).toContain("neo runs --short");
  });

  it("includes reporting section with neo log discovery", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).toContain("neo log discovery --knowledge");
    expect(result).toContain("neo log discovery --memory");
  });

  it("includes budget status", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).toContain("$5.00 / $50.00");
    expect(result).toContain("90% remaining");
  });

  it("includes hot state section", () => {
    const memory = emptyMemory();
    memory.activeWork = [
      { description: "working on X", status: "running", since: new Date().toISOString() },
    ];
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory,
      recentEntries: [],
    });
    expect(result).toContain("## Current state");
    expect(result).toContain("working on X");
  });

  it("includes agent digest when entries exist", () => {
    const entries = [
      makeEntry({ runId: "run-1", agent: "developer", type: "milestone", message: "PR created" }),
    ];
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: entries,
    });
    expect(result).toContain("## Agent digest");
    expect(result).toContain("★ PR created");
  });

  it("includes no-memory-ops footer", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).toContain("Memory consolidation at next cycle");
    expect(result).toContain("no <memory-ops> needed now");
  });

  it("does NOT include full memory JSON or knowledge sections", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).not.toContain("## Your current memory");
    expect(result).not.toContain("## Reference knowledge");
    // Should not contain memory-ops instructions (the consolidation block)
    expect(result).not.toContain("Use <memory-ops> for memory updates");
  });

  it("includes custom instructions when provided", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
      customInstructions: "Always prioritize security tasks.",
    });
    expect(result).toContain("## Custom instructions");
    expect(result).toContain("Always prioritize security tasks.");
  });

  it("includes MCP integrations when configured", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
      mcpServerNames: ["linear", "github"],
    });
    expect(result).toContain("## Available integrations (MCP)");
    expect(result).toContain("- linear");
    expect(result).toContain("- github");
  });

  it("includes repos list", () => {
    const result = buildStandardPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      recentEntries: [],
    });
    expect(result).toContain("## Registered repositories");
    expect(result).toContain("/repos/myapp (branch: main)");
  });
});

// ─── buildConsolidationPrompt ───────────────────────────

describe("buildConsolidationPrompt", () => {
  it("includes CONSOLIDATION label in header", () => {
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson: '{"agenda":"","activeWork":[]}',
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("(CONSOLIDATION)");
  });

  it("includes full memory JSON", () => {
    const memoryJson = '{"agenda":"review PRs","activeWork":[]}';
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson,
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("## Your current memory");
    expect(result).toContain(memoryJson);
  });

  it("includes full knowledge markdown", () => {
    const knowledgeMd = "## Global\n- API key is in vault\n";
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson: "{}",
      knowledgeMd,
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("## Reference knowledge");
    expect(result).toContain("API key is in vault");
  });

  it("includes memory-ops instructions", () => {
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson: "{}",
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("<memory-ops>");
    expect(result).toContain('"op":"set"');
    expect(result).toContain('"op":"append"');
    expect(result).toContain('"op":"remove"');
  });

  it("includes knowledge-ops instructions", () => {
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson: "{}",
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("<knowledge-ops>");
    expect(result).toContain("CONTRADICTIONS");
  });

  it("includes accumulated agent digest", () => {
    const entries = [
      makeEntry({ runId: "run-1", agent: "dev", type: "decision", message: "chose approach A" }),
      makeEntry({ runId: "run-1", agent: "dev", type: "milestone", message: "feature complete" }),
    ];
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson: "{}",
      knowledgeMd: "",
      allUnconsolidatedEntries: entries,
    });
    expect(result).toContain("## Agent digest (accumulated)");
    expect(result).toContain("◆ chose approach A");
    expect(result).toContain("★ feature complete");
  });

  it("does NOT include the standard no-ops footer", () => {
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory: emptyMemory(),
      memoryJson: "{}",
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).not.toContain("no <memory-ops> needed now");
  });

  it("includes hot state section", () => {
    const memory = emptyMemory();
    memory.blockers = [{ description: "CI broken", since: new Date().toISOString() }];
    const result = buildConsolidationPrompt({
      ...baseOpts(),
      memory,
      memoryJson: "{}",
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("## Current state");
    expect(result).toContain("CI broken");
  });
});
