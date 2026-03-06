import {
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_CRITERIA_LENGTH,
} from "./config.js";
import type { SanitizedTicket, TicketType, Priority, Complexity } from "./types.js";
import { logger } from "./logger.js";

const VALID_TYPES: ReadonlySet<string> = new Set([
  "feature",
  "bug",
  "refactor",
  "chore",
]);
const VALID_PRIORITIES: ReadonlySet<string> = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);
const VALID_COMPLEXITIES: ReadonlySet<number> = new Set([1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]);

/**
 * Allowlist-based input sanitizer.
 * Extracts structured fields from raw ticket data and validates types + lengths.
 */
export function sanitize(
  raw: Record<string, unknown>,
): SanitizedTicket | "quarantined" {
  // Extract and validate structured fields
  const ticketId = extractString(raw.ticketId);
  const title = truncate(extractString(raw.title), MAX_TITLE_LENGTH);
  const type = extractEnum(raw.type, VALID_TYPES) as TicketType | undefined;
  const priority = extractEnum(raw.priority, VALID_PRIORITIES) as Priority | undefined;
  const complexity = extractComplexity(raw.complexity);
  const criteria = truncate(extractString(raw.criteria), MAX_CRITERIA_LENGTH);
  const description = truncate(extractString(raw.description), MAX_DESCRIPTION_LENGTH);
  const repository = extractRepository(raw.repository);

  // Validate required fields
  if (!ticketId || !title || !type || !priority || !repository) {
    logger.warn("Quarantined ticket with missing required fields", {
      ticketId: raw.ticketId,
      hasTitle: Boolean(title),
      hasType: Boolean(type),
      hasPriority: Boolean(priority),
      hasRepository: Boolean(repository),
    });
    return "quarantined";
  }

  return {
    ticketId,
    title,
    type,
    priority,
    complexity: complexity ?? 3,
    criteria: criteria ?? "",
    description: description ?? "",
    repository,
  };
}

function extractString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function extractEnum(
  value: unknown,
  validValues: ReadonlySet<string>,
): string | undefined {
  const str = extractString(value)?.toLowerCase();
  if (!str || !validValues.has(str)) return undefined;
  return str;
}

function extractComplexity(value: unknown): Complexity | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(num) || !VALID_COMPLEXITIES.has(num)) return undefined;
  return num as Complexity;
}

function extractRepository(value: unknown): string | undefined {
  const str = extractString(value);
  if (!str) return undefined;
  // Accept "github.com/org/repo" format
  if (/^github\.com\/[\w.-]+\/[\w.-]+$/.test(str)) return str;
  // Accept full URL
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(str)) {
    return str.replace("https://", "");
  }
  // Accept "org/repo" shorthand — normalize to github.com/org/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(str)) {
    return `github.com/${str}`;
  }
  return undefined;
}

function truncate(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;
  return value.slice(0, maxLength);
}
