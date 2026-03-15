import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shouldCompact } from "@/supervisor/heartbeat";
import { compactKnowledge, markStaleFacts, selectKnowledgeForRepos } from "@/supervisor/knowledge";
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

// ─── compactKnowledge ───────────────────────────────────

describe("compactKnowledge", () => {
  it("trims oldest facts when section exceeds max", () => {
    const facts = Array.from({ length: 25 }, (_, i) => `- Fact ${i}`);
    const md = `## /repos/myapp\n${facts.join("\n")}\n`;
    const result = compactKnowledge(md, 20);
    // Parse result to count
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(20);
    // Should keep the last 20 (most recent)
    expect(lines[0]).toBe("- Fact 5");
    expect(lines[19]).toBe("- Fact 24");
  });

  it("does nothing when section is under max", () => {
    const md = `## Global\n- Fact 1\n- Fact 2\n`;
    const result = compactKnowledge(md, 20);
    expect(result).toContain("- Fact 1");
    expect(result).toContain("- Fact 2");
  });

  it("returns empty string for empty input", () => {
    expect(compactKnowledge("")).toBe("");
    expect(compactKnowledge("  ")).toBe("");
  });

  it("compacts multiple sections independently", () => {
    const section1 = Array.from({ length: 5 }, (_, i) => `- A${i}`).join("\n");
    const section2 = Array.from({ length: 5 }, (_, i) => `- B${i}`).join("\n");
    const md = `## Section1\n${section1}\n\n## Section2\n${section2}\n`;
    const result = compactKnowledge(md, 3);
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    // 3 from each section
    expect(lines).toHaveLength(6);
  });
});

// ─── markStaleFacts ─────────────────────────────────────

describe("markStaleFacts", () => {
  it("marks facts older than threshold as stale", () => {
    // Use a date far in the past
    const md = `## Global\n- Old fact [supervisor, 2020-01-01]\n`;
    const result = markStaleFacts(md, 30);
    expect(result).toContain("(stale?)");
  });

  it("does not mark recent facts as stale", () => {
    const today = new Date().toISOString().slice(0, 10);
    const md = `## Global\n- Recent fact [supervisor, ${today}]\n`;
    const result = markStaleFacts(md, 30);
    expect(result).not.toContain("(stale?)");
  });

  it("does not double-mark already stale facts", () => {
    const md = `## Global\n- Already stale (stale?) [supervisor, 2020-01-01]\n`;
    const result = markStaleFacts(md, 30);
    // Should only have one (stale?) marker
    const matches = result.match(/\(stale\?\)/g);
    expect(matches).toHaveLength(1);
  });

  it("ignores facts without date attribution", () => {
    const md = `## Global\n- No date fact\n`;
    const result = markStaleFacts(md, 30);
    expect(result).not.toContain("(stale?)");
  });

  it("returns empty input unchanged", () => {
    expect(markStaleFacts("")).toBe("");
  });
});

// ─── Knowledge injection (selectKnowledgeForRepos) ──────

describe("knowledge injection for agents", () => {
  const knowledgeMd = `## Global
- All repos use pnpm [supervisor, 2026-03-15]

## /repos/myapp
- Uses Prisma with PostgreSQL [developer, 2026-03-15]
- CI takes ~8 min [supervisor, 2026-03-14]

## /repos/api
- NestJS backend [developer, 2026-03-15]
`;

  it("selects relevant knowledge for a specific repo", () => {
    const result = selectKnowledgeForRepos(knowledgeMd, ["/repos/myapp"]);
    expect(result).toContain("Uses Prisma");
    expect(result).toContain("All repos use pnpm");
    expect(result).not.toContain("NestJS");
  });

  it("returns Global section even when repo has no specific knowledge", () => {
    const result = selectKnowledgeForRepos(knowledgeMd, ["/repos/unknown"]);
    expect(result).toContain("All repos use pnpm");
    expect(result).not.toContain("Prisma");
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
      memory: {
        agenda: "",
        activeWork: [],
        blockers: [],
        decisions: [],
        trackerSync: {},
      },
      memoryJson: "{}",
      knowledgeMd: "## Global\n- test\n",
      allUnconsolidatedEntries: [],
    });

    expect(prompt).toContain("COMPACTION");
    expect(prompt).toContain("Remove stale facts");
    expect(prompt).toContain("Merge duplicate");
    expect(prompt).toContain("6KB memory");
    expect(prompt).toContain("20 facts per repo");
  });
});

// ─── Agent prompt neo log instructions ──────────────────

// Resolve monorepo root: from packages/core/src/__tests__ go up to repo root
// From packages/core/src/__tests__/ → ../../.. = packages/ → agents/
const AGENTS_DIR = path.resolve(import.meta.dirname, "../../..", "agents");

describe("agent prompts contain neo log instructions", () => {
  const promptFiles = [
    "developer.md",
    "reviewer.md",
    "fixer.md",
    "architect.md",
    "refiner.md",
  ];

  for (const file of promptFiles) {
    it(`${file} contains neo log section`, async () => {
      const content = await readFile(
        path.join(AGENTS_DIR, "prompts", file),
        "utf-8",
      );
      expect(content).toContain("## Reporting with neo log");
      expect(content).toContain("neo log");
      expect(content).toContain("progress");
      expect(content).toContain("milestone");
      expect(content).toContain("discovery");
      expect(content).toContain("blocker");
    });
  }

  it("SUPERVISOR.md contains discovery logging instructions", async () => {
    const content = await readFile(
      path.join(AGENTS_DIR, "SUPERVISOR.md"),
      "utf-8",
    );
    expect(content).toContain("Using neo log for your discoveries");
    expect(content).toContain("neo log discovery --knowledge");
  });
});
