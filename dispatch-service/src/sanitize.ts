import {
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_CRITERIA_LENGTH,
  QUARANTINE_LENGTH_MULTIPLIER,
} from "./config.js";
import type { SanitizedTicket, TicketType, Priority, Size } from "./types.js";
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
const VALID_SIZES: ReadonlySet<string> = new Set([
  "xs",
  "s",
  "m",
  "l",
  "xl",
]);

// Patterns that suggest prompt injection
const SUSPICIOUS_PATTERNS = [
  /ignore\s+(previous|above|all)/i,
  /you\s+are\s+(now|a|an)/i,
  /system\s*:/i,
  /\bact\s+as\b/i,
  /\bpretend\s+(to\s+be|you're)\b/i,
  /\brole\s*:\s*/i,
  /\binstruction\s*:\s*/i,
  /```[\s\S]{100,}```/, // large code blocks
];

// Base64 pattern — requires mixed case/digits and optional padding
// Must contain both letters and digits/special to avoid false positives on plain text
const BASE64_PATTERN = /(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{30,}={0,2}/;

// URL pattern
const URL_PATTERN = /https?:\/\/[^\s]+/g;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/gi;
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Allowlist-based input sanitizer.
 * Extracts structured fields from raw ticket data, strips dangerous content,
 * and quarantines suspicious input.
 */
export function sanitize(
  raw: Record<string, unknown>,
): SanitizedTicket | "quarantined" {
  // 1. Check for suspicious content before processing
  const rawString = JSON.stringify(raw);
  if (isSuspicious(rawString)) {
    logger.warn("Quarantined suspicious ticket input", {
      ticketId: raw.ticketId,
      reason: "suspicious_patterns",
    });
    return "quarantined";
  }

  // 2. Check for excessive raw length (3x expected max)
  const maxExpectedLength =
    (MAX_TITLE_LENGTH + MAX_DESCRIPTION_LENGTH + MAX_CRITERIA_LENGTH) *
    QUARANTINE_LENGTH_MULTIPLIER;
  if (rawString.length > maxExpectedLength) {
    logger.warn("Quarantined oversized ticket input", {
      ticketId: raw.ticketId,
      rawLength: rawString.length,
      maxExpected: maxExpectedLength,
    });
    return "quarantined";
  }

  // 3. Extract and validate structured fields
  const ticketId = extractString(raw.ticketId);
  const title = stripDangerousContent(extractString(raw.title), MAX_TITLE_LENGTH);
  const type = extractEnum(raw.type, VALID_TYPES) as TicketType | undefined;
  const priority = extractEnum(raw.priority, VALID_PRIORITIES) as Priority | undefined;
  const size = extractEnum(raw.size, VALID_SIZES) as Size | undefined;
  const criteria = stripDangerousContent(
    extractString(raw.criteria),
    MAX_CRITERIA_LENGTH,
  );
  const description = stripDangerousContent(
    extractString(raw.description),
    MAX_DESCRIPTION_LENGTH,
  );
  const repository = extractRepository(raw.repository);

  // 4. Validate required fields
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
    size: size ?? "m",
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

function extractRepository(value: unknown): string | undefined {
  const str = extractString(value);
  if (!str) return undefined;
  // Accept "github.com/org/repo" format
  if (/^github\.com\/[\w.-]+\/[\w.-]+$/.test(str)) return str;
  // Accept full URL
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(str)) {
    return str.replace("https://", "");
  }
  return undefined;
}

function stripDangerousContent(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;

  let cleaned = value;
  // Strip code blocks
  cleaned = cleaned.replace(CODE_BLOCK_PATTERN, "");
  // Strip HTML tags
  cleaned = cleaned.replace(HTML_TAG_PATTERN, "");
  // Strip URLs (before markdown stripping to preserve brackets)
  cleaned = cleaned.replace(URL_PATTERN, "[URL removed]");
  // Strip markdown formatting (but preserve brackets from our replacements)
  cleaned = cleaned.replace(/[*_~`#()!|]/g, "");
  // Collapse excessive whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  // Truncate to max length
  cleaned = cleaned.slice(0, maxLength);

  return cleaned || undefined;
}

function isSuspicious(content: string): boolean {
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  if (BASE64_PATTERN.test(content)) return true;
  return false;
}
