import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Ensures a directory exists, creating it recursively if necessary.
 *
 * Uses an optional cache to avoid redundant filesystem calls when the same
 * directory is ensured multiple times. This is useful in hot paths where
 * directory existence is checked frequently.
 *
 * @param dirPath - The absolute or relative path to the directory to ensure.
 * @param cache - Optional Set to track directories that have already been created.
 *                When provided, subsequent calls with the same path skip the mkdir call.
 * @returns A promise that resolves when the directory exists.
 *
 * @example
 * ```ts
 * import { ensureDir } from "@/shared/fs";
 *
 * // Basic usage - creates directory if it doesn't exist
 * await ensureDir("/tmp/my-app/logs");
 *
 * // With caching - second call skips filesystem
 * const cache = new Set<string>();
 * await ensureDir("/tmp/my-app/logs", cache); // calls mkdir
 * await ensureDir("/tmp/my-app/logs", cache); // returns immediately
 * ```
 */
export async function ensureDir(dirPath: string, cache?: Set<string>): Promise<void> {
  if (cache?.has(dirPath)) {
    return;
  }

  await mkdir(dirPath, { recursive: true });

  cache?.add(dirPath);
}

/**
 * Atomically writes content to a file using temp-file-then-rename pattern.
 *
 * This prevents file corruption on process crash mid-write. The rename operation
 * is atomic on POSIX systems, ensuring the target file is either fully updated
 * or left untouched.
 *
 * @param filePath - The absolute or relative path to the target file.
 * @param content - The content to write (string or Buffer).
 * @param encoding - Optional encoding (default: "utf-8").
 * @returns A promise that resolves when the write completes.
 *
 * @example
 * ```ts
 * import { writeFileAtomic } from "@/shared/fs";
 *
 * // Write JSON atomically
 * await writeFileAtomic("/tmp/data.json", JSON.stringify(data));
 *
 * // If process crashes during write, original file is unchanged
 * ```
 */
export async function writeFileAtomic(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const dir = path.dirname(filePath);
  const uniqueSuffix = `${Date.now()}.${randomBytes(8).toString("hex")}`;
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${uniqueSuffix}`);

  // Write to temp file first
  await writeFile(tmpPath, content, encoding);

  // Atomic rename (POSIX guarantees atomicity)
  await rename(tmpPath, filePath);
}
