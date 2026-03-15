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

// ─── Extraction from LLM response ────────────────────────

/**
 * Extract <run-notes> blocks from an LLM response.
 * Returns parsed notes with auto-generated timestamps.
 *
 * Expected format:
 * ```
 * <run-notes>
 * decision: Chose JWT for auth
 * observation: Tests passing
 * blocker: Need API key
 * outcome: PR merged
 * </run-notes>
 * ```
 */
export function extractRunNotes(response: string): RunNote[] {
  const match = /<run-notes>([\s\S]*?)<\/run-notes>/i.exec(response);
  if (!match?.[1]) return [];

  const notes: RunNote[] = [];
  const now = new Date().toISOString();
  const lines = match[1].trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const typeRaw = line.slice(0, colonIdx).trim().toLowerCase();
    const text = line.slice(colonIdx + 1).trim();

    if (!text) continue;

    if (
      typeRaw === "decision" ||
      typeRaw === "observation" ||
      typeRaw === "blocker" ||
      typeRaw === "outcome"
    ) {
      notes.push({ type: typeRaw, text, ts: now });
    }
  }

  return notes;
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

function formatRunLine(run: PersistedRun): string {
  return `[${run.runId.slice(0, 8)}] ${run.workflow} on ${path.basename(run.repo)} (${run.status})`;
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
): Promise<string[]> {
  const raw = await readFile(path.join(repoDir, file), "utf-8");
  const run = JSON.parse(raw) as PersistedRun;

  if (!isActiveStatus(run.status)) return [];

  const notes = await readRecentNotes(repoSlug, run.runId, maxNotesPerRun);
  const lines = [formatRunLine(run)];

  for (const note of notes) {
    lines.push(formatNoteLine(note));
  }

  return lines;
}

async function processRepoDir(
  runsDir: string,
  repoSlug: string,
  maxNotesPerRun: number,
): Promise<string[]> {
  const repoDir = path.join(runsDir, repoSlug);
  const files = await readdir(repoDir);
  const lines: string[] = [];

  for (const file of files) {
    if (!isActiveRunFile(file)) continue;

    try {
      const runLines = await processRunFile(repoDir, repoSlug, file, maxNotesPerRun);
      lines.push(...runLines);
    } catch {
      // Corrupted or partial file — skip
    }
  }

  return lines;
}

/**
 * Build a hot state string for active runs with their recent notes.
 * Used in supervisor prompts to show current run context.
 */
export async function getActiveRunsWithNotes(maxNotesPerRun = 3): Promise<string> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return "";

  try {
    const repoEntries = await readdir(runsDir, { withFileTypes: true });
    const lines: string[] = [];

    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory()) continue;
      const repoLines = await processRepoDir(runsDir, repoEntry.name, maxNotesPerRun);
      lines.push(...repoLines);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}
