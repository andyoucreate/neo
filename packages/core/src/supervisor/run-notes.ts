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

/**
 * Persist extracted run notes for a given run.
 * Extracts notes from LLM response and appends them to the run's notes file.
 * No-op if no notes are found or repoSlug/runId are missing.
 */
export async function persistRunNotes(
  response: string,
  repoSlug: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (!repoSlug || !runId) return;

  const notes = extractRunNotes(response);
  for (const note of notes) {
    await appendRunNote(repoSlug, runId, note);
  }
}

/**
 * Extended run note with runId for supervisor context.
 */
export interface ExtendedRunNote {
  runId: string;
  type: "observation" | "decision" | "stage" | "blocker" | "resolution";
  text: string;
}

/**
 * Extract JSON-formatted run notes from supervisor LLM response.
 * These notes include runId for multi-run context.
 *
 * Expected format:
 * ```
 * <run-notes>
 * {"runId":"abc123","type":"observation","text":"Tests passing"}
 * {"runId":"abc123","type":"decision","text":"Using JWT auth"}
 * </run-notes>
 * ```
 */
export function extractExtendedRunNotes(response: string): ExtendedRunNote[] {
  const match = /<run-notes>([\s\S]*?)<\/run-notes>/i.exec(response);
  if (!match?.[1]) return [];

  const notes: ExtendedRunNote[] = [];
  const lines = match[1].trim().split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof parsed.runId === "string" &&
        typeof parsed.type === "string" &&
        typeof parsed.text === "string" &&
        ["observation", "decision", "stage", "blocker", "resolution"].includes(parsed.type)
      ) {
        notes.push({
          runId: parsed.runId,
          type: parsed.type as ExtendedRunNote["type"],
          text: parsed.text,
        });
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return notes;
}

/**
 * Persist extended run notes from supervisor output.
 * Groups notes by runId and persists to appropriate run files.
 * Requires a repoSlug resolver function since supervisor doesn't have single repo context.
 */
export async function persistExtendedRunNotes(
  response: string,
  getRepoSlugForRun: (runId: string) => Promise<string | undefined>,
): Promise<void> {
  const extendedNotes = extractExtendedRunNotes(response);
  const now = new Date().toISOString();

  for (const note of extendedNotes) {
    const repoSlug = await getRepoSlugForRun(note.runId);
    if (!repoSlug) continue;

    // Map extended types to core types
    const coreType = mapExtendedType(note.type);
    await appendRunNote(repoSlug, note.runId, {
      type: coreType,
      text: note.text,
      ts: now,
    });
  }
}

function mapExtendedType(
  extType: ExtendedRunNote["type"],
): "observation" | "decision" | "blocker" | "outcome" {
  switch (extType) {
    case "stage":
    case "observation":
      return "observation";
    case "resolution":
      return "outcome";
    case "decision":
      return "decision";
    case "blocker":
      return "blocker";
  }
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
