import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Fixed test paths - vi.mock is hoisted so we use a predictable path
const TEST_DIR = "/tmp/vitest-event-journal-test";
const JOURNAL_PATH = `${TEST_DIR}/events/journal.jsonl`;

// Mock config before importing module
vi.mock("../config.js", () => ({
  EVENT_JOURNAL_PATH: "/tmp/vitest-event-journal-test/events/journal.jsonl",
}));

import {
  appendEvent,
  readJournal,
  replayJournal,
  resetDirEnsured,
} from "../event-journal.js";

describe("Event Journal", () => {
  beforeEach(() => {
    resetDirEnsured();
    // Clean up from previous runs
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("appendEvent", () => {
    it("should create journal file and append entry", async () => {
      await appendEvent("dispatch.started", {
        pipeline: "feature",
        sessionId: "session-123",
        ticketId: "PROJ-42",
        repository: "github.com/org/repo",
      });

      const content = readFileSync(JOURNAL_PATH, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.event).toBe("dispatch.started");
      expect(entry.pipeline).toBe("feature");
      expect(entry.sessionId).toBe("session-123");
      expect(entry.ticketId).toBe("PROJ-42");
      expect(entry.ts).toBeDefined();
    });

    it("should append multiple entries", async () => {
      await appendEvent("dispatch.started", { sessionId: "s1" });
      await appendEvent("dispatch.completed", { sessionId: "s1" });
      await appendEvent("dispatch.started", { sessionId: "s2" });

      const content = readFileSync(JOURNAL_PATH, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).event).toBe("dispatch.started");
      expect(JSON.parse(lines[1]).event).toBe("dispatch.completed");
      expect(JSON.parse(lines[2]).event).toBe("dispatch.started");
    });

    it("should handle service events without data", async () => {
      await appendEvent("service.paused");
      await appendEvent("service.resumed");

      const content = readFileSync(JOURNAL_PATH, "utf-8");
      const lines = content.trim().split("\n");

      expect(JSON.parse(lines[0]).event).toBe("service.paused");
      expect(JSON.parse(lines[1]).event).toBe("service.resumed");
    });
  });

  describe("readJournal", () => {
    it("should return empty array when file does not exist", async () => {
      const entries = await readJournal();
      expect(entries).toEqual([]);
    });

    it("should return all entries from file", async () => {
      mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
      writeFileSync(
        JOURNAL_PATH,
        '{"ts":"2026-03-01T10:00:00Z","event":"dispatch.started","sessionId":"s1"}\n' +
        '{"ts":"2026-03-01T10:05:00Z","event":"dispatch.completed","sessionId":"s1"}\n',
      );

      const entries = await readJournal();

      expect(entries).toHaveLength(2);
      expect(entries[0].event).toBe("dispatch.started");
      expect(entries[1].event).toBe("dispatch.completed");
    });
  });

  describe("replayJournal", () => {
    it("should return empty array when no pending sessions", async () => {
      mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
      writeFileSync(
        JOURNAL_PATH,
        '{"ts":"2026-03-01T10:00:00Z","event":"dispatch.started","sessionId":"s1"}\n' +
        '{"ts":"2026-03-01T10:05:00Z","event":"dispatch.completed","sessionId":"s1"}\n',
      );

      const pending = await replayJournal();
      expect(pending).toEqual([]);
    });

    it("should return sessions that started but never completed", async () => {
      mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
      writeFileSync(
        JOURNAL_PATH,
        '{"ts":"2026-03-01T10:00:00Z","event":"dispatch.started","sessionId":"s1","pipeline":"feature"}\n' +
        '{"ts":"2026-03-01T10:01:00Z","event":"dispatch.started","sessionId":"s2","pipeline":"review"}\n' +
        '{"ts":"2026-03-01T10:05:00Z","event":"dispatch.completed","sessionId":"s1"}\n',
      );

      const pending = await replayJournal();

      expect(pending).toHaveLength(1);
      expect(pending[0].sessionId).toBe("s2");
      expect(pending[0].pipeline).toBe("review");
    });

    it("should handle killed sessions as completed", async () => {
      mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
      writeFileSync(
        JOURNAL_PATH,
        '{"ts":"2026-03-01T10:00:00Z","event":"dispatch.started","sessionId":"s1"}\n' +
        '{"ts":"2026-03-01T10:05:00Z","event":"session.killed","sessionId":"s1"}\n',
      );

      const pending = await replayJournal();
      expect(pending).toEqual([]);
    });

    it("should handle failed sessions as completed", async () => {
      mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
      writeFileSync(
        JOURNAL_PATH,
        '{"ts":"2026-03-01T10:00:00Z","event":"dispatch.started","sessionId":"s1"}\n' +
        '{"ts":"2026-03-01T10:05:00Z","event":"dispatch.failed","sessionId":"s1"}\n',
      );

      const pending = await replayJournal();
      expect(pending).toEqual([]);
    });
  });
});
