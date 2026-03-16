import { describe, expect, it } from "vitest";
import type { GroupedEvents } from "@/supervisor/event-queue";
import {
  buildConsolidationPrompt,
  buildStandardPrompt,
} from "@/supervisor/prompt-builder";
import type { LogBufferEntry } from "@/supervisor/schemas";

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
    focusMd: "",
  };
}

// ─── buildStandardPrompt ────────────────────────────────

describe("buildStandardPrompt", () => {
  it("includes role and heartbeat number", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("neo autonomous supervisor");
    expect(result).toContain("Heartbeat #10");
  });

  it("uses XML tag structure", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("<role>");
    expect(result).toContain("</role>");
    expect(result).toContain("<commands>");
    expect(result).toContain("</commands>");
    expect(result).toContain("<context>");
    expect(result).toContain("</context>");
    expect(result).toContain("<instructions>");
    expect(result).toContain("</instructions>");
  });

  it("includes commands section", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("neo run <agent>");
    expect(result).toContain("neo runs --short");
  });

  it("includes reporting rules with neo log discovery", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("neo log discovery --knowledge");
    expect(result).toContain('neo log discovery "..."');
  });

  it("includes budget status", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("$5.00 / $50.00");
    expect(result).toContain("90% remaining");
  });

  it("includes focus section with empty state", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("<focus>");
    expect(result).toContain("</focus>");
    expect(result).toContain("update your focus");
  });

  it("includes focus content when provided", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      focusMd: "Working on auth deploy. Waiting for run abc123.",
      recentEntries: [],
    });
    expect(result).toContain("Working on auth deploy");
    expect(result).toContain("Waiting for run abc123");
  });

  it("includes memory verticals guidance", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("Memory verticals");
    expect(result).toContain("Focus");
    expect(result).toContain("Notes");
    expect(result).toContain("Knowledge");
  });

  it("includes agent digest when entries exist", async () => {
    const entries = [
      makeEntry({ runId: "run-1", agent: "developer", type: "milestone", message: "PR created" }),
    ];
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: entries,
    });
    expect(result).toContain("Agent digest");
    expect(result).toContain("PR created");
  });

  it("includes standard heartbeat footer", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("standard heartbeat");
  });

  it("does NOT include knowledge sections", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).not.toContain("Reference knowledge:");
  });

  it("includes custom instructions when provided", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
      customInstructions: "Always prioritize security tasks.",
    });
    expect(result).toContain("Custom instructions");
    expect(result).toContain("Always prioritize security tasks.");
  });

  it("includes MCP integrations when configured", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
      mcpServerNames: ["linear", "github"],
    });
    expect(result).toContain("Integrations (MCP)");
    expect(result).toContain("- linear");
    expect(result).toContain("- github");
  });

  it("includes repos list", async () => {
    const result = await buildStandardPrompt({
      ...baseOpts(),
      recentEntries: [],
    });
    expect(result).toContain("Repositories:");
    expect(result).toContain("/repos/myapp (branch: main)");
  });
});

// ─── buildConsolidationPrompt ───────────────────────────

describe("buildConsolidationPrompt", () => {
  it("includes CONSOLIDATION label in header", async () => {
    const result = await buildConsolidationPrompt({
      ...baseOpts(),
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("(CONSOLIDATION)");
  });

  it("includes full knowledge markdown", async () => {
    const knowledgeMd = "## Global\n- API key is in vault\n";
    const result = await buildConsolidationPrompt({
      ...baseOpts(),
      knowledgeMd,
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("Current knowledge.md:");
    expect(result).toContain("API key is in vault");
  });

  it("includes knowledge rewrite instructions via Bash", async () => {
    const result = await buildConsolidationPrompt({
      ...baseOpts(),
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("knowledge.md");
    expect(result).toContain("cat >");
  });

  it("includes accumulated agent digest", async () => {
    const entries = [
      makeEntry({ runId: "run-1", agent: "dev", type: "decision", message: "chose approach A" }),
      makeEntry({ runId: "run-1", agent: "dev", type: "milestone", message: "feature complete" }),
    ];
    const result = await buildConsolidationPrompt({
      ...baseOpts(),
      knowledgeMd: "",
      allUnconsolidatedEntries: entries,
    });
    expect(result).toContain("Agent digest (accumulated)");
    expect(result).toContain("chose approach A");
    expect(result).toContain("feature complete");
  });

  it("does NOT include the standard no-ops footer", async () => {
    const result = await buildConsolidationPrompt({
      ...baseOpts(),
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).not.toContain("This is a standard heartbeat");
  });

  it("includes focus section", async () => {
    const result = await buildConsolidationPrompt({
      ...baseOpts(),
      knowledgeMd: "",
      allUnconsolidatedEntries: [],
    });
    expect(result).toContain("<focus>");
    expect(result).toContain("</focus>");
  });
});
