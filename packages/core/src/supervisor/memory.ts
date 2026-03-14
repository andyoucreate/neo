import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_FILE = "memory.json";
const KNOWLEDGE_FILE = "knowledge.json";
const ARCHIVE_FILE = "memory-archive.jsonl";
const LEGACY_FILE = "memory.md";
const MAX_SIZE_KB = 6;
const MAX_DECISIONS = 10;

// ─── Structured memory type ─────────────────────────────

export interface SupervisorMemory {
  activeWork: string[];
  blockers: string[];
  repoNotes: Record<string, string>;
  recentDecisions: Array<{
    date: string;
    decision: string;
    outcome?: string;
  }>;
  trackerSync: Record<string, string>;
  notes: string;
}

/**
 * Parse raw memory content into structured format.
 * Tries JSON first, falls back to wrapping raw markdown in { notes }.
 */
export function parseStructuredMemory(raw: string): SupervisorMemory {
  if (!raw.trim()) {
    return emptyMemory();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SupervisorMemory>;
    return {
      activeWork: parsed.activeWork ?? [],
      blockers: parsed.blockers ?? [],
      repoNotes: parsed.repoNotes ?? {},
      recentDecisions: parsed.recentDecisions ?? [],
      trackerSync: parsed.trackerSync ?? {},
      notes: parsed.notes ?? "",
    };
  } catch {
    // Legacy markdown format — wrap in notes
    return { ...emptyMemory(), notes: raw };
  }
}

function emptyMemory(): SupervisorMemory {
  return {
    activeWork: [],
    blockers: [],
    repoNotes: {},
    recentDecisions: [],
    trackerSync: {},
    notes: "",
  };
}

// ─── Knowledge (cold/static data) ───────────────────────

export async function loadKnowledge(dir: string): Promise<string> {
  try {
    return await readFile(path.join(dir, KNOWLEDGE_FILE), "utf-8");
  } catch {
    return "";
  }
}

export async function saveKnowledge(dir: string, content: string): Promise<void> {
  await writeFile(path.join(dir, KNOWLEDGE_FILE), content, "utf-8");
}

// ─── Memory (working/volatile data) ─────────────────────

/**
 * Load the supervisor memory from disk.
 * Migrates from legacy memory.md if needed.
 */
export async function loadMemory(dir: string): Promise<string> {
  // Try new format first
  try {
    return await readFile(path.join(dir, MEMORY_FILE), "utf-8");
  } catch {
    // Not found — try legacy migration
  }

  // Migrate from legacy memory.md
  try {
    const legacy = await readFile(path.join(dir, LEGACY_FILE), "utf-8");
    if (legacy.trim()) {
      await writeFile(path.join(dir, MEMORY_FILE), legacy, "utf-8");
      await rename(path.join(dir, LEGACY_FILE), path.join(dir, `${LEGACY_FILE}.bak`));
      return legacy;
    }
  } catch {
    // No legacy file either
  }

  return "";
}

/**
 * Save the supervisor memory to disk (full overwrite).
 * Automatically compacts if needed.
 */
export async function saveMemory(dir: string, content: string): Promise<void> {
  const compacted = await compactMemory(dir, content);
  await writeFile(path.join(dir, MEMORY_FILE), compacted, "utf-8");
}

/**
 * Extract memory content from Claude's response using <memory>...</memory> tags.
 */
export function extractMemoryFromResponse(response: string): string | null {
  const match = /<memory>([\s\S]*?)<\/memory>/i.exec(response);
  if (!match?.[1]) return null;
  const content = match[1].trim();

  if (content.startsWith("{")) {
    try {
      JSON.parse(content);
      return content;
    } catch {
      // Malformed JSON — still save as raw text
    }
  }
  return content;
}

/**
 * Extract knowledge updates from Claude's response using <knowledge>...</knowledge> tags.
 */
export function extractKnowledgeFromResponse(response: string): string | null {
  const match = /<knowledge>([\s\S]*?)<\/knowledge>/i.exec(response);
  if (!match?.[1]) return null;
  return match[1].trim();
}

/**
 * Check if memory content exceeds the recommended size limit.
 */
export function checkMemorySize(content: string): { ok: boolean; sizeKB: number } {
  const sizeKB = Buffer.byteLength(content, "utf-8") / 1024;
  return { ok: sizeKB <= MAX_SIZE_KB, sizeKB: Math.round(sizeKB * 10) / 10 };
}

// ─── Compaction ─────────────────────────────────────────

/**
 * Compact memory: archive old decisions, trim notes if over size limit.
 * Archived data goes to memory-archive.jsonl (append-only, never lost).
 */
async function compactMemory(dir: string, content: string): Promise<string> {
  if (!content.startsWith("{")) return content;

  let parsed: SupervisorMemory;
  try {
    parsed = parseStructuredMemory(content);
  } catch {
    return content;
  }

  let changed = false;

  // Archive old decisions (keep last MAX_DECISIONS)
  if (parsed.recentDecisions.length > MAX_DECISIONS) {
    const toArchive = parsed.recentDecisions.slice(0, -MAX_DECISIONS);
    parsed.recentDecisions = parsed.recentDecisions.slice(-MAX_DECISIONS);
    changed = true;

    const archivePath = path.join(dir, ARCHIVE_FILE);
    const entry = {
      type: "decisions_archived",
      timestamp: new Date().toISOString(),
      decisions: toArchive,
    };
    await appendFile(archivePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  // If still over size, trim notes
  const result = changed ? JSON.stringify(parsed, null, 2) : content;
  const sizeKB = Buffer.byteLength(result, "utf-8") / 1024;

  if (sizeKB > MAX_SIZE_KB && parsed.notes.length > 200) {
    const archivePath = path.join(dir, ARCHIVE_FILE);
    const entry = {
      type: "notes_archived",
      timestamp: new Date().toISOString(),
      notes: parsed.notes,
    };
    await appendFile(archivePath, `${JSON.stringify(entry)}\n`, "utf-8");

    parsed.notes = "(archived — see memory-archive.jsonl)";
    return JSON.stringify(parsed, null, 2);
  }

  return result;
}
