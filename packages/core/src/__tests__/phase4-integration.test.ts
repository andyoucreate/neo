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
      tasks: [],
      recentActions: [],
    });

    expect(prompt).toContain("COMPACTION");
    expect(prompt).toContain("Remove stale facts");
    expect(prompt).toContain("Merge duplicate");
    expect(prompt).toContain("15 facts per scope");
  });
});

// ─── Agent prompt structure ─────────────────────────────

const AGENTS_DIR = path.resolve(import.meta.dirname, "../../..", "agents");

describe("agent prompts and supervisor domain knowledge", () => {
  it("SUPERVISOR.md contains domain knowledge", async () => {
    const content = await readFile(path.join(AGENTS_DIR, "SUPERVISOR.md"), "utf-8");
    expect(content).toContain("Available Agents");
    expect(content).toContain("Agent Output Contracts");
    expect(content).toContain("Safety Guards");
  });
});
