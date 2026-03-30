import type { ZodType } from "zod";

export interface ParsedOutput {
  rawOutput: string;
  output?: unknown;
  parseError?: string;
  prUrl?: string;
  prNumber?: number;
}

/**
 * Extract JSON from agent output that may be wrapped in markdown code blocks.
 * Tries multiple strategies: raw JSON parse, then markdown code block extraction.
 */
function extractJson(raw: string): unknown | undefined {
  // Strategy 1: Try parsing the entire string as JSON
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Not raw JSON, continue — expected when agent output contains prose before JSON
    console.debug(
      `[output-parser] Raw JSON parse failed, trying code block: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Strategy 2: Extract from markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/;
  const match = raw.match(codeBlockRegex);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch (err) {
      // Invalid JSON inside code block — expected when code block contains non-JSON
      console.debug(
        `[output-parser] Code block JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return undefined;
}

// ─── PR URL extraction ──────────────────────────────────

const PR_URL_REGEX = /^PR_URL:\s*(https?:\/\/\S+)/m;

export function extractPrUrl(raw: string): { prUrl: string; prNumber?: number } | undefined {
  const match = raw.match(PR_URL_REGEX);
  if (!match?.[1]) return undefined;

  const prUrl = match[1];
  const numberMatch = prUrl.match(/\/pull\/(\d+)/);

  if (numberMatch?.[1]) {
    return { prUrl, prNumber: Number.parseInt(numberMatch[1], 10) };
  }
  return { prUrl };
}

/**
 * Parse agent output, optionally validating against a Zod schema.
 * Also extracts structured markers like PR_URL from the output.
 *
 * - If no schema: returns rawOutput only
 * - If schema provided: extracts JSON from output, validates with schema
 * - On failure: returns rawOutput + parseError (caller decides whether to retry)
 */
export function parseOutput(raw: string, schema?: ZodType): ParsedOutput {
  const prInfo = extractPrUrl(raw);
  const base: ParsedOutput = { rawOutput: raw };
  if (prInfo) {
    base.prUrl = prInfo.prUrl;
    if (prInfo.prNumber !== undefined) {
      base.prNumber = prInfo.prNumber;
    }
  }

  if (!schema) {
    return base;
  }

  const extracted = extractJson(raw);
  if (extracted === undefined) {
    base.parseError = "Failed to extract JSON from output";
    return base;
  }

  const result = schema.safeParse(extracted);
  if (!result.success) {
    base.parseError = `Schema validation failed: ${result.error.message}`;
    return base;
  }

  base.output = result.data;
  return base;
}
