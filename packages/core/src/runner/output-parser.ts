import type { ZodType } from "zod";

export interface ParsedOutput {
  rawOutput: string;
  output?: unknown;
  parseError?: string;
}

/**
 * Extract JSON from agent output that may be wrapped in markdown code blocks.
 * Tries multiple strategies: raw JSON parse, then markdown code block extraction.
 */
function extractJson(raw: string): unknown | undefined {
  // Strategy 1: Try parsing the entire string as JSON
  try {
    return JSON.parse(raw);
  } catch {
    // Not raw JSON, continue
  }

  // Strategy 2: Extract from markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/;
  const match = raw.match(codeBlockRegex);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      // Invalid JSON inside code block
    }
  }

  return undefined;
}

/**
 * Parse agent output, optionally validating against a Zod schema.
 *
 * - If no schema: returns rawOutput only
 * - If schema provided: extracts JSON from output, validates with schema
 * - On failure: returns rawOutput + parseError (caller decides whether to retry)
 */
export function parseOutput(raw: string, schema?: ZodType): ParsedOutput {
  if (!schema) {
    return { rawOutput: raw };
  }

  const extracted = extractJson(raw);
  if (extracted === undefined) {
    return {
      rawOutput: raw,
      parseError: "Failed to extract JSON from output",
    };
  }

  const result = schema.safeParse(extracted);
  if (!result.success) {
    return {
      rawOutput: raw,
      parseError: `Schema validation failed: ${result.error.message}`,
    };
  }

  return {
    rawOutput: raw,
    output: result.data,
  };
}
