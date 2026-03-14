import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_FILE = "memory.md";
const MAX_SIZE_KB = 10;

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

/**
 * Load the supervisor memory from disk.
 * Returns empty string if no memory file exists yet.
 */
export async function loadMemory(dir: string): Promise<string> {
  try {
    return await readFile(path.join(dir, MEMORY_FILE), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Save the supervisor memory to disk (full overwrite).
 */
export async function saveMemory(dir: string, content: string): Promise<void> {
  await writeFile(path.join(dir, MEMORY_FILE), content, "utf-8");
}

/**
 * Extract memory content from Claude's response using <memory>...</memory> tags.
 * Handles both JSON and markdown content inside the tags.
 * Returns null if no memory block is found.
 */
export function extractMemoryFromResponse(response: string): string | null {
  const match = /<memory>([\s\S]*?)<\/memory>/i.exec(response);
  if (!match?.[1]) return null;
  const content = match[1].trim();

  // Validate JSON if it looks like JSON — ensure it round-trips
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
 * Check if memory content exceeds the recommended size limit.
 */
export function checkMemorySize(content: string): { ok: boolean; sizeKB: number } {
  const sizeKB = Buffer.byteLength(content, "utf-8") / 1024;
  return { ok: sizeKB <= MAX_SIZE_KB, sizeKB: Math.round(sizeKB * 10) / 10 };
}
