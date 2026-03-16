import { readFile } from "node:fs/promises";
import path from "node:path";

const KNOWLEDGE_MD = "knowledge.md";

/**
 * Load knowledge from disk. Empty string if missing.
 */
export async function loadKnowledge(dir: string): Promise<string> {
  try {
    return await readFile(path.join(dir, KNOWLEDGE_MD), "utf-8");
  } catch {
    return "";
  }
}
