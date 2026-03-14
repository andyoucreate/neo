import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostJournal } from "@/cost/journal";
import type { CostEntry } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_cost_journal_test__");

function makeEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    timestamp: "2026-03-14T10:00:00.000Z",
    runId: "run-1",
    workflow: "hotfix",
    step: "fix",
    sessionId: "session-1",
    agent: "developer",
    costUsd: 0.05,
    models: { sonnet: 0.05 },
    durationMs: 1200,
    ...overrides,
  };
}

beforeEach(async () => {
  // Clean slate
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("CostJournal", () => {
  it("appends and reads back day total", async () => {
    const journal = new CostJournal({ dir: TMP_DIR });

    await journal.append(makeEntry({ costUsd: 0.05 }));
    await journal.append(makeEntry({ costUsd: 0.1 }));

    const total = await journal.getDayTotal(new Date("2026-03-14T12:00:00Z"));
    expect(total).toBeCloseTo(0.15);
  });

  it("returns 0 for empty journal", async () => {
    const journal = new CostJournal({ dir: TMP_DIR });

    const total = await journal.getDayTotal(new Date("2026-03-14T12:00:00Z"));
    expect(total).toBe(0);
  });

  it("separates entries by month into different files", async () => {
    const journal = new CostJournal({ dir: TMP_DIR });

    await journal.append(makeEntry({ timestamp: "2026-03-14T10:00:00.000Z" }));
    await journal.append(makeEntry({ timestamp: "2026-04-01T10:00:00.000Z" }));

    const marchFile = path.join(TMP_DIR, "cost-2026-03.jsonl");
    const aprilFile = path.join(TMP_DIR, "cost-2026-04.jsonl");

    const marchContent = await readFile(marchFile, "utf-8");
    const aprilContent = await readFile(aprilFile, "utf-8");

    expect(marchContent.trim().split("\n")).toHaveLength(1);
    expect(aprilContent.trim().split("\n")).toHaveLength(1);
  });

  it("invalidates cache on append", async () => {
    const journal = new CostJournal({ dir: TMP_DIR });
    const date = new Date("2026-03-14T12:00:00Z");

    await journal.append(makeEntry({ costUsd: 0.05 }));
    const total1 = await journal.getDayTotal(date);
    expect(total1).toBeCloseTo(0.05);

    await journal.append(makeEntry({ costUsd: 0.1 }));
    const total2 = await journal.getDayTotal(date);
    expect(total2).toBeCloseTo(0.15);
  });

  it("only sums entries for the requested day", async () => {
    const journal = new CostJournal({ dir: TMP_DIR });

    await journal.append(makeEntry({ timestamp: "2026-03-14T10:00:00.000Z", costUsd: 0.05 }));
    await journal.append(makeEntry({ timestamp: "2026-03-15T10:00:00.000Z", costUsd: 0.2 }));

    const total14 = await journal.getDayTotal(new Date("2026-03-14T12:00:00Z"));
    expect(total14).toBeCloseTo(0.05);

    const total15 = await journal.getDayTotal(new Date("2026-03-15T12:00:00Z"));
    expect(total15).toBeCloseTo(0.2);
  });

  it("writes valid JSONL lines", async () => {
    const journal = new CostJournal({ dir: TMP_DIR });
    const entry = makeEntry();

    await journal.append(entry);

    const file = path.join(TMP_DIR, "cost-2026-03.jsonl");
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.costUsd).toBe(0.05);
    expect(parsed.runId).toBe("run-1");
  });
});
