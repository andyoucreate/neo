import { mkdir } from "node:fs/promises";

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
