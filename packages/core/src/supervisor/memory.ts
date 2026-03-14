import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_FILE = "memory.md";
const MAX_SIZE_KB = 10;

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
 * Returns null if no memory block is found.
 */
export function extractMemoryFromResponse(response: string): string | null {
  const match = /<memory>([\s\S]*?)<\/memory>/i.exec(response);
  return match?.[1]?.trim() ?? null;
}

/**
 * Check if memory content exceeds the recommended size limit.
 */
export function checkMemorySize(content: string): { ok: boolean; sizeKB: number } {
  const sizeKB = Buffer.byteLength(content, "utf-8") / 1024;
  return { ok: sizeKB <= MAX_SIZE_KB, sizeKB: Math.round(sizeKB * 10) / 10 };
}
