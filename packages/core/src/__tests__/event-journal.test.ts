import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventJournal } from "@/events/journal";
import type { NeoEvent } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_event_journal_test__");

function makeEvent(overrides?: Partial<NeoEvent>): NeoEvent {
  return {
    type: "session:start",
    sessionId: "session-1",
    runId: "run-1",
    workflow: "hotfix",
    step: "fix",
    agent: "developer",
    repo: "/tmp/repo",
    timestamp: "2026-03-14T10:00:00.000Z",
    ...overrides,
  } as NeoEvent;
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("EventJournal", () => {
  it("appends valid JSONL line", async () => {
    const journal = new EventJournal({ dir: TMP_DIR });

    await journal.append(makeEvent());

    const file = path.join(TMP_DIR, "events-2026-03.jsonl");
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.type).toBe("session:start");
    expect(parsed.sessionId).toBe("session-1");
  });

  it("multiple appends produce multiple lines", async () => {
    const journal = new EventJournal({ dir: TMP_DIR });

    await journal.append(makeEvent({ timestamp: "2026-03-14T10:00:00.000Z" } as Partial<NeoEvent>));
    await journal.append(makeEvent({ timestamp: "2026-03-14T11:00:00.000Z" } as Partial<NeoEvent>));
    await journal.append(makeEvent({ timestamp: "2026-03-14T12:00:00.000Z" } as Partial<NeoEvent>));

    const file = path.join(TMP_DIR, "events-2026-03.jsonl");
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(3);
  });

  it("separates entries by month into different files", async () => {
    const journal = new EventJournal({ dir: TMP_DIR });

    await journal.append(makeEvent({ timestamp: "2026-03-14T10:00:00.000Z" } as Partial<NeoEvent>));
    await journal.append(makeEvent({ timestamp: "2026-04-01T10:00:00.000Z" } as Partial<NeoEvent>));

    const marchFile = path.join(TMP_DIR, "events-2026-03.jsonl");
    const aprilFile = path.join(TMP_DIR, "events-2026-04.jsonl");

    const marchContent = await readFile(marchFile, "utf-8");
    const aprilContent = await readFile(aprilFile, "utf-8");

    expect(marchContent.trim().split("\n")).toHaveLength(1);
    expect(aprilContent.trim().split("\n")).toHaveLength(1);
  });

  it("handles concurrent appends", async () => {
    const journal = new EventJournal({ dir: TMP_DIR });
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ sessionId: `session-${i}` } as Partial<NeoEvent>),
    );

    await Promise.all(events.map((e) => journal.append(e)));

    const file = path.join(TMP_DIR, "events-2026-03.jsonl");
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
  });

  it("serializes different event types correctly", async () => {
    const journal = new EventJournal({ dir: TMP_DIR });

    await journal.append(makeEvent({ type: "session:start" } as Partial<NeoEvent>));
    await journal.append(
      makeEvent({
        type: "cost:update",
        sessionCost: 0.05,
        todayTotal: 0.1,
        budgetRemainingPct: 90,
      } as Partial<NeoEvent>),
    );
    await journal.append(makeEvent({ type: "orchestrator:shutdown" } as Partial<NeoEvent>));

    const file = path.join(TMP_DIR, "events-2026-03.jsonl");
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.type).toBeDefined();
    }

    expect(JSON.parse(lines[0] as string).type).toBe("session:start");
    expect(JSON.parse(lines[1] as string).type).toBe("cost:update");
    expect(JSON.parse(lines[2] as string).type).toBe("orchestrator:shutdown");
  });

  it("creates directory if it doesn't exist", async () => {
    const deepDir = path.join(TMP_DIR, "nested", "events");
    const journal = new EventJournal({ dir: deepDir });

    await journal.append(makeEvent());

    const file = path.join(deepDir, "events-2026-03.jsonl");
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
