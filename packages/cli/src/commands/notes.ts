import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedRun, RunNote } from "@neotx/core";
import { appendRunNote, findRepoSlugForRun, getRunsDir, readRunNotes } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess, printTable } from "../output.js";

const VALID_NOTE_TYPES = ["observation", "decision", "stage", "blocker", "resolution"] as const;
type NoteInputType = (typeof VALID_NOTE_TYPES)[number];

// Map user-facing types to core RunNote types
const NOTE_TYPE_MAP: Record<NoteInputType, "observation" | "decision" | "blocker" | "outcome"> = {
  observation: "observation",
  decision: "decision",
  stage: "observation",
  blocker: "blocker",
  resolution: "outcome",
};

const TYPE_MARKERS: Record<string, string> = {
  decision: "◆",
  observation: "·",
  blocker: "⚠",
  outcome: "✓",
};

function formatTime(ts: string): string {
  return ts.slice(11, 19);
}

function formatNoteShort(note: RunNote): string {
  const marker = TYPE_MARKERS[note.type] ?? "·";
  return `${formatTime(note.ts)} ${marker} ${note.text}`;
}

function formatNoteTable(note: RunNote): [string, string, string] {
  const marker = TYPE_MARKERS[note.type] ?? "·";
  return [formatTime(note.ts), `${marker} ${note.type}`, note.text];
}

/**
 * Find all active runs across all repos.
 * Active = status is "running" or "paused".
 */
async function findActiveRuns(): Promise<Array<{ repoSlug: string; run: PersistedRun }>> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return [];

  const activeRuns: Array<{ repoSlug: string; run: PersistedRun }> = [];

  try {
    const repoEntries = await readdir(runsDir, { withFileTypes: true });

    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory()) continue;

      const repoDir = path.join(runsDir, repoEntry.name);
      const files = await readdir(repoDir);

      for (const file of files) {
        if (!file.endsWith(".json") || file.includes(".dispatch") || file.includes(".notes")) {
          continue;
        }

        try {
          const content = await readFile(path.join(repoDir, file), "utf-8");
          const run = JSON.parse(content) as PersistedRun;

          if (run.status === "running" || run.status === "paused") {
            activeRuns.push({ repoSlug: repoEntry.name, run });
          }
        } catch {
          // Skip corrupt files
        }
      }
    }

    // Sort by updatedAt descending
    activeRuns.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
    return activeRuns;
  } catch {
    return [];
  }
}

async function showRunTimeline(
  runId: string,
  repoSlug: string | undefined,
  short: boolean,
  jsonOutput: boolean,
): Promise<void> {
  // Resolve repoSlug if not provided
  const slug = repoSlug ?? (await findRepoSlugForRun(runId));
  if (!slug) {
    printError(`Run "${runId}" not found.`);
    process.exitCode = 1;
    return;
  }

  const notes = await readRunNotes(slug, runId);

  if (notes.length === 0) {
    if (jsonOutput) {
      printJson([]);
    } else {
      console.log(`No notes found for run ${runId.slice(0, 8)}.`);
    }
    return;
  }

  if (jsonOutput) {
    printJson(notes);
    return;
  }

  if (short) {
    console.log(`Run ${runId.slice(0, 8)} timeline (${notes.length} notes):`);
    for (const note of notes) {
      console.log(formatNoteShort(note));
    }
  } else {
    console.log(`\nRun: ${runId}`);
    console.log(`Notes: ${notes.length}\n`);
    printTable(
      ["TIME", "TYPE", "TEXT"],
      notes.map((note) => formatNoteTable(note)),
    );
  }
}

async function showActiveNotes(last: number, short: boolean, jsonOutput: boolean): Promise<void> {
  const activeRuns = await findActiveRuns();

  if (activeRuns.length === 0) {
    if (jsonOutput) {
      printJson([]);
    } else {
      console.log("No active runs found.");
    }
    return;
  }

  // Collect notes from all active runs
  const allNotes: Array<{
    runId: string;
    repoSlug: string;
    note: RunNote;
  }> = [];

  for (const { repoSlug, run } of activeRuns) {
    const notes = await readRunNotes(repoSlug, run.runId);
    for (const note of notes) {
      allNotes.push({ runId: run.runId, repoSlug, note });
    }
  }

  // Sort by timestamp descending and limit
  allNotes.sort((a, b) => b.note.ts.localeCompare(a.note.ts));
  const recentNotes = allNotes.slice(0, last);

  if (recentNotes.length === 0) {
    if (jsonOutput) {
      printJson([]);
    } else {
      console.log("No notes from active runs.");
    }
    return;
  }

  if (jsonOutput) {
    printJson(
      recentNotes.map(({ runId, repoSlug, note }) => ({
        runId,
        repoSlug,
        ...note,
      })),
    );
    return;
  }

  if (short) {
    for (const { runId, note } of recentNotes) {
      const marker = TYPE_MARKERS[note.type] ?? "·";
      console.log(`${formatTime(note.ts)} ${runId.slice(0, 8)} ${marker} ${note.text}`);
    }
  } else {
    printTable(
      ["TIME", "RUN", "TYPE", "TEXT"],
      recentNotes.map(({ runId, note }) => [
        formatTime(note.ts),
        runId.slice(0, 8),
        `${TYPE_MARKERS[note.type] ?? "·"} ${note.type}`,
        note.text,
      ]),
    );
  }
}

export default defineCommand({
  meta: {
    name: "notes",
    description: "Show or add run notes (per-run narrative tracking)",
  },
  args: {
    runId: {
      type: "positional",
      description: "Run ID to show or annotate",
      required: false,
    },
    type: {
      type: "positional",
      description: "Note type: observation, decision, stage, blocker, resolution",
      required: false,
    },
    text: {
      type: "positional",
      description: "Note text",
      required: false,
    },
    active: {
      type: "boolean",
      description: "Show recent notes from all active runs",
      default: false,
    },
    last: {
      type: "string",
      description: "Limit number of notes (default: 20 for --active)",
      default: "20",
    },
    short: {
      type: "boolean",
      description: "Compact output for supervisor agents (saves tokens)",
      default: false,
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const last = Number(args.last);

    if (args.runId && args.type && args.text) {
      // neo notes <runId> <type> "text" — add a note
      const type = args.type;
      if (!VALID_NOTE_TYPES.includes(type as NoteInputType)) {
        printError(`Invalid type "${type}". Must be one of: ${VALID_NOTE_TYPES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const slug = await findRepoSlugForRun(args.runId);
      if (!slug) {
        printError(`Run "${args.runId}" not found.`);
        process.exitCode = 1;
        return;
      }

      const coreType = NOTE_TYPE_MAP[type as NoteInputType];
      await appendRunNote(slug, args.runId, {
        type: coreType,
        text: args.text,
        ts: new Date().toISOString(),
      });

      printSuccess(`Note added to ${args.runId.slice(0, 8)}: [${type}] ${args.text.slice(0, 100)}`);
    } else if (args.runId && !args.type) {
      // neo notes <runId> — show timeline
      await showRunTimeline(args.runId, undefined, args.short, jsonOutput);
    } else if (args.active) {
      // neo notes --active — show all active runs
      await showActiveNotes(last, args.short, jsonOutput);
    } else {
      printError('Usage: neo notes <runId> | neo notes <runId> <type> "text" | neo notes --active');
      process.exitCode = 1;
    }
  },
});
