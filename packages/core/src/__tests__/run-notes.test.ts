import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendRunNote,
  extractRunNotes,
  getActiveRunsWithNotes,
  readRecentNotes,
  readRunNotes,
} from "@/supervisor/run-notes";
import type { RunNote } from "@/supervisor/schemas";
import type { PersistedRun } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_run_notes_test__");
const REPO_SLUG = "test-repo";

function makeNote(overrides?: Partial<RunNote>): RunNote {
  return {
    type: "observation",
    text: "doing work",
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides?: Partial<PersistedRun>): PersistedRun {
  return {
    version: 1,
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    workflow: "test-workflow",
    repo: "/home/user/my-repo",
    prompt: "test prompt",
    status: "running",
    steps: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Mock paths module to use our temp directory
vi.mock("@/paths", () => ({
  getRunsDir: () => path.join(TMP_DIR, "runs"),
  getRepoRunsDir: (slug: string) => path.join(TMP_DIR, "runs", slug),
}));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(path.join(TMP_DIR, "runs", REPO_SLUG), { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("appendRunNote + readRunNotes", () => {
  it("appends and reads notes", async () => {
    const runId = "test-run-1";
    const note1 = makeNote({ type: "decision", text: "Chose JWT for auth" });
    const note2 = makeNote({ type: "observation", text: "Tests passing" });

    await appendRunNote(REPO_SLUG, runId, note1);
    await appendRunNote(REPO_SLUG, runId, note2);

    const notes = await readRunNotes(REPO_SLUG, runId);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.type).toBe("decision");
    expect(notes[0]?.text).toBe("Chose JWT for auth");
    expect(notes[1]?.type).toBe("observation");
    expect(notes[1]?.text).toBe("Tests passing");
  });

  it("returns empty array for missing file", async () => {
    const notes = await readRunNotes(REPO_SLUG, "nonexistent-run");
    expect(notes).toEqual([]);
  });

  it("skips malformed lines", async () => {
    const runId = "test-run-2";
    const filePath = path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.notes.jsonl`);

    const validNote = makeNote({ text: "valid" });
    const content = `${JSON.stringify(validNote)}\nnot-json\n${JSON.stringify(makeNote({ text: "also valid" }))}\n`;
    await writeFile(filePath, content, "utf-8");

    const notes = await readRunNotes(REPO_SLUG, runId);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text).toBe("valid");
    expect(notes[1]?.text).toBe("also valid");
  });
});

describe("readRecentNotes", () => {
  it("returns last N notes", async () => {
    const runId = "test-run-3";

    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "first" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "second" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "third" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "fourth" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "fifth" }));

    const recent = await readRecentNotes(REPO_SLUG, runId, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.text).toBe("third");
    expect(recent[1]?.text).toBe("fourth");
    expect(recent[2]?.text).toBe("fifth");
  });

  it("returns all notes if fewer than limit", async () => {
    const runId = "test-run-4";

    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "only" }));

    const recent = await readRecentNotes(REPO_SLUG, runId, 5);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe("only");
  });

  it("returns empty for missing file", async () => {
    const recent = await readRecentNotes(REPO_SLUG, "missing", 3);
    expect(recent).toEqual([]);
  });
});

describe("extractRunNotes", () => {
  it("extracts notes from run-notes block", () => {
    const response = `
Some text before.

<run-notes>
decision: Chose JWT for auth
observation: Tests passing
blocker: Need API key
outcome: PR merged
</run-notes>

Some text after.
`;

    const notes = extractRunNotes(response);
    expect(notes).toHaveLength(4);
    expect(notes[0]).toMatchObject({ type: "decision", text: "Chose JWT for auth" });
    expect(notes[1]).toMatchObject({ type: "observation", text: "Tests passing" });
    expect(notes[2]).toMatchObject({ type: "blocker", text: "Need API key" });
    expect(notes[3]).toMatchObject({ type: "outcome", text: "PR merged" });
  });

  it("returns empty array for missing block", () => {
    const response = "Just some text without run-notes.";
    const notes = extractRunNotes(response);
    expect(notes).toEqual([]);
  });

  it("skips invalid note types", () => {
    const response = `
<run-notes>
decision: Valid
invalid: Should be skipped
observation: Also valid
</run-notes>
`;

    const notes = extractRunNotes(response);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.type).toBe("decision");
    expect(notes[1]?.type).toBe("observation");
  });

  it("skips lines without colon", () => {
    const response = `
<run-notes>
decision: Valid note
no colon here
observation: Another valid
</run-notes>
`;

    const notes = extractRunNotes(response);
    expect(notes).toHaveLength(2);
  });

  it("skips empty text after colon", () => {
    const response = `
<run-notes>
decision:
observation: Has text
blocker:
</run-notes>
`;

    const notes = extractRunNotes(response);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe("observation");
  });

  it("handles case insensitivity", () => {
    const response = `
<RUN-NOTES>
DECISION: Uppercase type
Observation: Mixed case
</RUN-NOTES>
`;

    const notes = extractRunNotes(response);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.type).toBe("decision");
    expect(notes[1]?.type).toBe("observation");
  });

  it("generates timestamps", () => {
    const response = `
<run-notes>
decision: Test note
</run-notes>
`;

    const notes = extractRunNotes(response);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.ts).toBeTruthy();
    expect(new Date(notes[0]?.ts ?? "").getTime()).not.toBeNaN();
  });
});

describe("getActiveRunsWithNotes", () => {
  it("returns formatted hot state for active runs", async () => {
    const runId = "abcd1234efgh5678";
    const run = makeRun({ runId, status: "running" });

    // Write run file
    const runPath = path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.json`);
    await writeFile(runPath, JSON.stringify(run), "utf-8");

    // Add notes
    await appendRunNote(REPO_SLUG, runId, makeNote({ type: "decision", text: "Using JWT" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ type: "blocker", text: "Need key" }));

    const hotState = await getActiveRunsWithNotes(3);

    // New format: runId [STATUS duration] agent — repo
    expect(hotState).toContain("abcd1234");
    expect(hotState).toContain("[RUNNING");
    expect(hotState).toContain("test-workflow");
    expect(hotState).toContain("my-repo");
    expect(hotState).toContain("Using JWT");
    expect(hotState).toContain("Need key");
    expect(hotState).toContain("◆"); // decision marker
    expect(hotState).toContain("⚠"); // blocker marker
  });

  it("excludes completed/failed runs", async () => {
    const completedRun = makeRun({ runId: "completed-run", status: "completed" });
    const failedRun = makeRun({ runId: "failed-run", status: "failed" });

    await writeFile(
      path.join(TMP_DIR, "runs", REPO_SLUG, "completed-run.json"),
      JSON.stringify(completedRun),
      "utf-8",
    );
    await writeFile(
      path.join(TMP_DIR, "runs", REPO_SLUG, "failed-run.json"),
      JSON.stringify(failedRun),
      "utf-8",
    );

    const hotState = await getActiveRunsWithNotes();

    expect(hotState).not.toContain("completed-run");
    expect(hotState).not.toContain("failed-run");
  });

  it("respects maxNotesPerRun limit", async () => {
    const runId = "limited-notes";
    const run = makeRun({ runId, status: "running" });

    await writeFile(
      path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.json`),
      JSON.stringify(run),
      "utf-8",
    );

    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "note 1" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "note 2" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "note 3" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "note 4" }));
    await appendRunNote(REPO_SLUG, runId, makeNote({ text: "note 5" }));

    const hotState = await getActiveRunsWithNotes(2);

    expect(hotState).not.toContain("note 1");
    expect(hotState).not.toContain("note 2");
    expect(hotState).not.toContain("note 3");
    expect(hotState).toContain("note 4");
    expect(hotState).toContain("note 5");
  });

  it("returns empty string for missing runs dir", async () => {
    await rm(path.join(TMP_DIR, "runs"), { recursive: true, force: true });

    const hotState = await getActiveRunsWithNotes();
    expect(hotState).toBe("");
  });

  it("handles run with no notes", async () => {
    const runId = "no-notes-run";
    const run = makeRun({ runId, status: "paused" });

    await writeFile(
      path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.json`),
      JSON.stringify(run),
      "utf-8",
    );

    const hotState = await getActiveRunsWithNotes();

    // New format: runId [STATUS duration] agent — repo
    expect(hotState).toContain("no-notes");
    expect(hotState).toContain("[PAUSED");
  });

  it("skips dispatch and notes files", async () => {
    const runId = "skip-test";
    const run = makeRun({ runId, status: "running" });

    await writeFile(
      path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.json`),
      JSON.stringify(run),
      "utf-8",
    );
    await writeFile(path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.dispatch.json`), "{}", "utf-8");
    await writeFile(path.join(TMP_DIR, "runs", REPO_SLUG, `${runId}.notes.jsonl`), "", "utf-8");

    const hotState = await getActiveRunsWithNotes();

    // Should only show up once (from the main .json file)
    // Format: "skip-tes [RUNNING" (runId truncated to 8 chars)
    const matches = hotState.match(/skip-tes \[RUNNING/g);
    expect(matches?.length).toBe(1);
  });
});
