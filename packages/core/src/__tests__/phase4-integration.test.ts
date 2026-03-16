import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldCompact } from "@/supervisor/heartbeat";
import { buildCompactionPrompt } from "@/supervisor/prompt-builder";

// ─── shouldCompact ──────────────────────────────────────
// Note: shouldCompact now uses time-based intervals (lastCompactionTimestamp, compactionIntervalMs)
// See heartbeat-consolidation.test.ts for comprehensive time-based tests

describe("shouldCompact (integration)", () => {
  const ONE_HOUR_MS = 3_600_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when interval has elapsed", () => {
    const lastCompaction = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    expect(shouldCompact(lastCompaction, ONE_HOUR_MS)).toBe(true);
  });

  it("returns false when interval has not elapsed", () => {
    const lastCompaction = new Date(Date.now() - 1_800_000).toISOString(); // 30 min ago
    expect(shouldCompact(lastCompaction, ONE_HOUR_MS)).toBe(false);
  });

  it("returns false on first run (no last compaction timestamp)", () => {
    expect(shouldCompact(undefined, ONE_HOUR_MS)).toBe(false);
  });
});

// ─── buildCompactionPrompt ──────────────────────────────

describe("buildCompactionPrompt", () => {
  it("includes COMPACTION label in the prompt", () => {
    const prompt = buildCompactionPrompt({
      repos: [],
      grouped: { messages: [], webhooks: [], runCompletions: [] },
      budgetStatus: { todayUsd: 1, capUsd: 50, remainingPct: 98 },
      activeRuns: [],
      heartbeatCount: 50,
      mcpServerNames: [],
      supervisorDir: "/tmp/test-supervisor",
      memories: [],
    });

    expect(prompt).toContain("COMPACTION");
    expect(prompt).toContain("Remove stale facts");
    expect(prompt).toContain("Merge duplicate");
    expect(prompt).toContain("20 facts per scope");
  });
});

// ─── Agent prompt structure ─────────────────────────────

const AGENTS_DIR = path.resolve(import.meta.dirname, "../../..", "agents");

describe("agent prompts contain memory and reporting instructions", () => {
  const promptFiles = ["developer.md", "reviewer.md", "fixer.md", "architect.md", "refiner.md"];

  for (const file of promptFiles) {
    it(`${file} contains memory & reporting section`, async () => {
      const content = await readFile(path.join(AGENTS_DIR, "prompts", file), "utf-8");
      expect(content).toContain("## Memory & Reporting");
      expect(content).toContain("neo memory write");
      expect(content).toContain("neo log");
    });
  }

  it("SUPERVISOR.md contains domain knowledge", async () => {
    const content = await readFile(path.join(AGENTS_DIR, "SUPERVISOR.md"), "utf-8");
    expect(content).toContain("Available Agents");
    expect(content).toContain("Agent Output Contracts");
    expect(content).toContain("Safety Guards");
  });
});
