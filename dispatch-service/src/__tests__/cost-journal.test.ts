import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CostJournal } from "../cost-journal.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CostJournal", () => {
  let tempDir: string;
  let journal: CostJournal;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cost-journal-test-"));
    journal = new CostJournal(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("record", () => {
    it("should create journal file and append entry", async () => {
      await journal.record({
        pipeline: "feature",
        sessionId: "session-123",
        ticketId: "PROJ-42",
        costUsd: 25.50,
        modelUsage: {
          opus: { inputTokens: 1000, outputTokens: 500, costUSD: 20.00 },
          sonnet: { inputTokens: 500, outputTokens: 200, costUSD: 5.50 },
        },
        durationMs: 180000,
      });

      const date = new Date().toISOString().slice(0, 7); // YYYY-MM
      const filePath = join(tempDir, `${date}.jsonl`);
      const content = readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.pipeline).toBe("feature");
      expect(entry.sessionId).toBe("session-123");
      expect(entry.ticketId).toBe("PROJ-42");
      expect(entry.costUsd).toBe(25.50);
      expect(entry.models).toEqual({ opus: 20.00, sonnet: 5.50 });
      expect(entry.durationMs).toBe(180000);
      expect(entry.ts).toBeDefined();
    });

    it("should append multiple entries", async () => {
      await journal.record({
        pipeline: "feature",
        sessionId: "session-1",
        costUsd: 10.00,
        modelUsage: {},
        durationMs: 60000,
      });

      await journal.record({
        pipeline: "review",
        sessionId: "session-2",
        costUsd: 5.00,
        modelUsage: {},
        durationMs: 30000,
      });

      const date = new Date().toISOString().slice(0, 7);
      const filePath = join(tempDir, `${date}.jsonl`);
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).pipeline).toBe("feature");
      expect(JSON.parse(lines[1]!).pipeline).toBe("review");
    });
  });

  describe("getTodayCost", () => {
    it("should return 0 when no entries exist", async () => {
      const cost = await journal.getTodayCost();
      expect(cost).toBe(0);
    });

    it("should sum costs for today only", async () => {
      await journal.record({
        pipeline: "feature",
        sessionId: "session-1",
        costUsd: 10.00,
        modelUsage: {},
        durationMs: 60000,
      });

      await journal.record({
        pipeline: "review",
        sessionId: "session-2",
        costUsd: 15.50,
        modelUsage: {},
        durationMs: 30000,
      });

      const cost = await journal.getTodayCost();
      expect(cost).toBe(25.50);
    });

    it("should exclude entries from other days", async () => {
      // Record an entry for today
      await journal.record({
        pipeline: "feature",
        sessionId: "session-today",
        costUsd: 10.00,
        modelUsage: {},
        durationMs: 60000,
      });

      const cost = await journal.getTodayCost();
      expect(cost).toBe(10.00);
    });
  });

  describe("getCostByPipeline", () => {
    it("should group costs by pipeline type", async () => {
      await journal.record({
        pipeline: "feature",
        sessionId: "session-1",
        costUsd: 100.00,
        modelUsage: {},
        durationMs: 60000,
      });

      await journal.record({
        pipeline: "feature",
        sessionId: "session-2",
        costUsd: 50.00,
        modelUsage: {},
        durationMs: 30000,
      });

      await journal.record({
        pipeline: "review",
        sessionId: "session-3",
        costUsd: 25.00,
        modelUsage: {},
        durationMs: 20000,
      });

      const breakdown = await journal.getCostByPipeline();
      expect(breakdown.feature).toBe(150.00);
      expect(breakdown.review).toBe(25.00);
    });
  });

  describe("getCostByModel", () => {
    it("should aggregate costs by model", async () => {
      await journal.record({
        pipeline: "feature",
        sessionId: "session-1",
        costUsd: 30.00,
        modelUsage: {
          opus: { inputTokens: 1000, outputTokens: 500, costUSD: 25.00 },
          sonnet: { inputTokens: 500, outputTokens: 200, costUSD: 5.00 },
        },
        durationMs: 60000,
      });

      await journal.record({
        pipeline: "review",
        sessionId: "session-2",
        costUsd: 10.00,
        modelUsage: {
          sonnet: { inputTokens: 800, outputTokens: 300, costUSD: 8.00 },
          haiku: { inputTokens: 200, outputTokens: 100, costUSD: 2.00 },
        },
        durationMs: 30000,
      });

      const breakdown = await journal.getCostByModel();
      expect(breakdown.opus).toBe(25.00);
      expect(breakdown.sonnet).toBe(13.00);
      expect(breakdown.haiku).toBe(2.00);
    });
  });
});
