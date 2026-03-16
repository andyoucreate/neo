import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shouldCompact } from "@/supervisor/heartbeat";
import { buildCompactionPrompt } from "@/supervisor/prompt-builder";

// ─── shouldCompact ──────────────────────────────────────

describe("shouldCompact", () => {
  it("returns true when heartbeats since last compaction >= default interval (50)", () => {
    expect(shouldCompact(50, 0)).toBe(true);
    expect(shouldCompact(100, 50)).toBe(true);
  });

  it("returns false when heartbeats since last compaction < interval", () => {
    expect(shouldCompact(30, 0)).toBe(false);
    expect(shouldCompact(60, 50)).toBe(false);
  });

  it("respects custom compaction interval", () => {
    expect(shouldCompact(10, 0, 10)).toBe(true);
    expect(shouldCompact(9, 0, 10)).toBe(false);
  });

  it("handles lastCompactionHeartbeat of 0 (first run)", () => {
    expect(shouldCompact(49, 0)).toBe(false);
    expect(shouldCompact(50, 0)).toBe(true);
  });
});

// ─── buildCompactionPrompt ──────────────────────────────

describe("buildCompactionPrompt", () => {
  it("includes COMPACTION label in the prompt", async () => {
    const prompt = await buildCompactionPrompt({
      repos: [],
      grouped: { messages: [], webhooks: [], runCompletions: [] },
      budgetStatus: { todayUsd: 1, capUsd: 50, remainingPct: 98 },
      activeRuns: [],
      heartbeatCount: 50,
      mcpServerNames: [],
      supervisorDir: "/tmp/test-supervisor",
      focusMd: "",
      knowledgeMd: "## Global\n- test\n",
      allUnconsolidatedEntries: [],
    });

    expect(prompt).toContain("COMPACTION");
    expect(prompt).toContain("Remove stale facts");
    expect(prompt).toContain("Merge duplicate");
    expect(prompt).toContain("20 facts per repo");
  });
});

// ─── Agent prompt neo log instructions ──────────────────

const AGENTS_DIR = path.resolve(import.meta.dirname, "../../..", "agents");

describe("agent prompts contain neo log instructions", () => {
  const promptFiles = ["developer.md", "reviewer.md", "fixer.md", "architect.md", "refiner.md"];

  for (const file of promptFiles) {
    it(`${file} contains neo log section`, async () => {
      const content = await readFile(path.join(AGENTS_DIR, "prompts", file), "utf-8");
      expect(content).toContain("## Reporting with neo log");
      expect(content).toContain("neo log");
      expect(content).toContain("progress");
      expect(content).toContain("milestone");
      expect(content).toContain("discovery");
      expect(content).toContain("blocker");
    });
  }

  it("SUPERVISOR.md contains domain knowledge", async () => {
    const content = await readFile(path.join(AGENTS_DIR, "SUPERVISOR.md"), "utf-8");
    expect(content).toContain("Available Agents");
    expect(content).toContain("Agent Output Contracts");
    expect(content).toContain("Safety Guards");
  });
});
