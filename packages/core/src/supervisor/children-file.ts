import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildHandle } from "./schemas.js";

/**
 * Write the current list of child handles to children.json.
 * Called by ChildRegistry after every state mutation so the TUI can poll it.
 */
export async function writeChildrenFile(filePath: string, handles: ChildHandle[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(handles, null, 2), "utf-8");
}

/**
 * Read child handles from children.json.
 * Returns empty array if file does not exist or is malformed.
 */
export async function readChildrenFile(filePath: string): Promise<ChildHandle[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ChildHandle[];
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: Log file read failures for debugging
    console.debug("[neo] Failed to read children file:", err);
    return [];
  }
}
