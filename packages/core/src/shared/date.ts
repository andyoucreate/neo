import path from "node:path";

/**
 * Converts a Date to a YYYY-MM-DD string in UTC.
 *
 * Uses UTC to ensure consistent date keys regardless of local timezone.
 * This is critical for cost tracking and event journaling where entries
 * must be grouped by calendar day consistently across all environments.
 *
 * @param date - The date to convert.
 * @returns A string in YYYY-MM-DD format (e.g., "2026-03-14").
 *
 * @example
 * ```ts
 * import { toDateKey } from "@/shared/date";
 *
 * toDateKey(new Date("2026-03-14T10:00:00Z")); // => "2026-03-14"
 * toDateKey(new Date("2026-03-14T23:59:59Z")); // => "2026-03-14"
 * ```
 */
export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Generates a dated file path with monthly rotation.
 *
 * Creates paths in the format: `{dir}/{prefix}-YYYY-MM.jsonl`
 * Uses UTC year/month to ensure consistent file paths across timezones.
 *
 * @param date - The date used to determine the year and month for the file name.
 * @param prefix - The prefix for the file name (e.g., "cost", "events").
 * @param dir - The directory where the file will be located.
 * @returns The full file path (e.g., "/data/cost-2026-03.jsonl").
 *
 * @example
 * ```ts
 * import { fileForDate } from "@/shared/date";
 *
 * fileForDate(new Date("2026-03-14T10:00:00Z"), "cost", "/data");
 * // => "/data/cost-2026-03.jsonl"
 *
 * fileForDate(new Date("2026-12-31T23:59:59Z"), "events", "/logs");
 * // => "/logs/events-2026-12.jsonl"
 * ```
 */
export function fileForDate(date: Date, prefix: string, dir: string): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return path.join(dir, `${prefix}-${yyyy}-${mm}.jsonl`);
}
