import { existsSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRunsDir, getRunsDir } from "@/paths";
import type { PersistedRun } from "@/types";
import type { RunNote } from "./schemas.js";
import { runNoteSchema } from "./schemas.js";

// ─── File naming ─────────────────────────────────────────

function notesPath(repoSlug: string, runId: string): string {
  return path.join(getRepoRunsDir(repoSlug), `${runId}.notes.jsonl`);
}

// ─── Core read/write ─────────────────────────────────────

function parseLines(content: string): RunNote[] {
  const notes: RunNote[] = [];
  const lines = content.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      notes.push(runNoteSchema.parse(JSON.parse(line)));
    } catch {
      // Skip malformed lines
    }
  }
  return notes;
}

/**
 * Append a note to a run's notes file.
 * Creates the file if it doesn't exist.
 */
export async function appendRunNote(repoSlug: string, runId: string, note: RunNote): Promise<void> {
  const filePath = notesPath(repoSlug, runId);
  await appendFile(filePath, `${JSON.stringify(note)}\n`, "utf-8");
}

/**
 * Read all notes for a run.
 */
export async function readRunNotes(repoSlug: string, runId: string): Promise<RunNote[]> {
  try {
    const content = await readFile(notesPath(repoSlug, runId), "utf-8");
    return parseLines(content);
  } catch {
    return [];
  }
}

/**
 * Read the last N notes for a run.
 */
export async function readRecentNotes(
  repoSlug: string,
  runId: string,
  limit = 3,
): Promise<RunNote[]> {
  const notes = await readRunNotes(repoSlug, runId);
  return notes.slice(-limit);
}

/**
 * Find the repoSlug for a given runId by scanning the runs directory.
 * Returns undefined if the run is not found.
 */
export async function findRepoSlugForRun(runId: string): Promise<string | undefined> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return undefined;

  try {
    const repoEntries = await readdir(runsDir, { withFileTypes: true });

    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory()) continue;

      const repoDir = path.join(runsDir, repoEntry.name);
      const files = await readdir(repoDir);

      for (const file of files) {
        // Check if file matches runId pattern (runId.json)
        if (file === `${runId}.json`) {
          return repoEntry.name;
        }
        // Also check partial match for truncated runIds (first 8 chars)
        if (file.startsWith(runId) && file.endsWith(".json")) {
          return repoEntry.name;
        }
      }
    }
  } catch {
    // Directory access error
  }

  return undefined;
}

// ─── Hot state builder ───────────────────────────────────

const TYPE_MARKERS: Record<string, string> = {
  decision: "◆",
  observation: "·",
  blocker: "⚠",
  outcome: "✓",
};

function isActiveRunFile(file: string): boolean {
  return file.endsWith(".json") && !file.includes(".dispatch") && !file.includes(".notes");
}

function isActiveStatus(status: string): boolean {
  return status === "running" || status === "paused";
}

function formatDuration(since: Date, now: Date): string {
  const ms = now.getTime() - since.getTime();
  if (ms < 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

function formatRunLine(run: PersistedRun, now: Date = new Date()): string {
  const duration = formatDuration(new Date(run.createdAt), now);
  return `${run.runId.slice(0, 8)} [${run.status.toUpperCase()} ${duration}] ${run.workflow} — ${path.basename(run.repo)}`;
}

function formatNoteLine(note: RunNote): string {
  const marker = TYPE_MARKERS[note.type] ?? "·";
  return `  ${marker} ${note.text}`;
}

async function processRunFile(
  repoDir: string,
  repoSlug: string,
  file: string,
  maxNotesPerRun: number,
  now: Date,
): Promise<string[]> {
  const raw = await readFile(path.join(repoDir, file), "utf-8");
  const run = JSON.parse(raw) as PersistedRun;

  if (!isActiveStatus(run.status)) return [];

  const notes = await readRecentNotes(repoSlug, run.runId, maxNotesPerRun);
  const lines = [formatRunLine(run, now)];

  for (const note of notes) {
    lines.push(formatNoteLine(note));
  }

  return lines;
}

async function processRepoDir(
  runsDir: string,
  repoSlug: string,
  maxNotesPerRun: number,
  now: Date,
): Promise<string[]> {
  const repoDir = path.join(runsDir, repoSlug);
  const files = await readdir(repoDir);
  const lines: string[] = [];

  for (const file of files) {
    if (!isActiveRunFile(file)) continue;

    try {
      const runLines = await processRunFile(repoDir, repoSlug, file, maxNotesPerRun, now);
      lines.push(...runLines);
    } catch {
      // Corrupted or partial file — skip
    }
  }

  return lines;
}

function isCompletedStatus(status: string): boolean {
  return status === "completed" || status === "failed";
}

async function collectRunsMatching(
  filter: (run: PersistedRun, updatedAt: number) => boolean,
  maxNotesPerRun = Number.POSITIVE_INFINITY,
): Promise<{ line: string; notes: string[]; updatedAt: number }[]> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return [];

  const now = new Date();
  const results: { line: string; notes: string[]; updatedAt: number }[] = [];

  const repoEntries = await readdir(runsDir, { withFileTypes: true });
  for (const repoEntry of repoEntries) {
    if (!repoEntry.isDirectory()) continue;
    const repoDir = path.join(runsDir, repoEntry.name);
    const files = await readdir(repoDir);

    for (const file of files) {
      if (!isActiveRunFile(file)) continue;
      try {
        const raw = await readFile(path.join(repoDir, file), "utf-8");
        const run = JSON.parse(raw) as PersistedRun;
        const updatedAt = new Date(run.updatedAt).getTime();

        if (!filter(run, updatedAt)) continue;

        const notes = await readRecentNotes(repoEntry.name, run.runId, maxNotesPerRun);
        results.push({
          line: formatRunLine(run, now),
          notes: notes.map((n) => formatNoteLine(n)),
          updatedAt,
        });
      } catch {
        // Skip corrupted files
      }
    }
  }

  return results;
}

function formatCollectedRuns(runs: { line: string; notes: string[] }[]): string {
  if (runs.length === 0) return "";
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(run.line);
    lines.push(...run.notes);
  }
  return lines.join("\n");
}

/**
 * Get recently completed/failed runs with their last notes.
 * Used in standard heartbeats so the supervisor sees what just finished.
 * @param maxAge Only include runs completed within this many milliseconds (default: 2h)
 * @param maxRuns Cap number of runs returned
 * @param maxNotesPerRun Cap notes per run
 */
export async function getRecentCompletedRunsWithNotes(
  maxAge = 2 * 60 * 60 * 1000,
  maxRuns = 5,
  maxNotesPerRun = 3,
): Promise<string> {
  const cutoff = Date.now() - maxAge;

  try {
    const runs = await collectRunsMatching(
      (run, updatedAt) => isCompletedStatus(run.status) && updatedAt >= cutoff,
      maxNotesPerRun,
    );
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    return formatCollectedRuns(runs.slice(0, maxRuns));
  } catch {
    return "";
  }
}

/**
 * Build a full history of runs updated since a given timestamp,
 * with ALL their notes. Used during consolidation so the supervisor
 * can integrate learnings from completed runs into knowledge.
 * @param since Only include runs updated after this ISO timestamp
 * @param maxRuns Cap to avoid overloading the prompt
 */
export async function getRecentRunHistory(since?: string, maxRuns = 10): Promise<string> {
  const sinceMs = since ? new Date(since).getTime() : 0;

  try {
    const runs = await collectRunsMatching((_run, updatedAt) => updatedAt >= sinceMs);
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    return formatCollectedRuns(runs.slice(0, maxRuns));
  } catch {
    return "";
  }
}

/**
 * Build a hot state string for active runs with their recent notes.
 * Used in supervisor prompts to show current run context.
 * Format: runId [STATUS duration] agent — notes
 */
export async function getActiveRunsWithNotes(maxNotesPerRun = 3): Promise<string> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return "";

  const now = new Date();

  try {
    const repoEntries = await readdir(runsDir, { withFileTypes: true });
    const lines: string[] = [];

    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory()) continue;
      const repoLines = await processRepoDir(runsDir, repoEntry.name, maxNotesPerRun, now);
      lines.push(...repoLines);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}
