import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Parse a JSONL file line-by-line using streaming to avoid loading entire file into memory.
 * Safe for unbounded append-only files that could grow arbitrarily large.
 *
 * @param filePath - Path to the JSONL file to parse
 * @param parseLine - Callback to parse and transform each line
 * @returns Array of successfully parsed entries
 *
 * @example
 * ```ts
 * const entries = await parseJsonlStream(
 *   "/path/to/file.jsonl",
 *   (line) => JSON.parse(line) as MyType
 * );
 * ```
 */
export async function parseJsonlStream<T>(
  filePath: string,
  parseLine: (line: string) => T,
): Promise<T[]> {
  const results: T[] = [];

  const fileStream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      results.push(parseLine(trimmed));
    } catch (error) {
      // Skip malformed lines silently (consistent with existing behavior)
      // biome-ignore lint/suspicious/noConsole: Intentional warning for parse failures
      console.warn(
        `[parseJsonlStream] Skipping malformed line: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  return results;
}
