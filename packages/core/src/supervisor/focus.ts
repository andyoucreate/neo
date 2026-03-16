import { readFile } from "node:fs/promises";
import path from "node:path";

const FOCUS_FILE = "focus.md";

/** Load the supervisor's focus file (working memory). Empty string if missing. */
export async function loadFocus(dir: string): Promise<string> {
  try {
    return await readFile(path.join(dir, FOCUS_FILE), "utf-8");
  } catch {
    return "";
  }
}
