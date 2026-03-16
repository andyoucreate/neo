import { describe, expect, it } from "vitest";
import type { GroupedEvents } from "@/supervisor/event-queue";
import type { MemoryEntry } from "@/supervisor/memory/entry";
import { buildConsolidationPrompt, buildStandardPrompt } from "@/supervisor/prompt-builder";

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
