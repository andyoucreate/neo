import type { z } from "zod";
import type { NeoConfig, RepoOverrideConfig } from "./schema";
import { neoConfigSchema, repoOverrideConfigSchema } from "./schema";

// ─── Warning types ──────────────────────────────────────────

export type ConfigWarningType = "unknown_key" | "deprecated" | "type_coerced";

export interface ConfigWarning {
  type: ConfigWarningType;
  path: string;
  message: string;
}

export interface ParseResult<T> {
  config: T;
  warnings: ConfigWarning[];
}

// ─── Deprecated keys registry ───────────────────────────────
// Add deprecated keys here with their replacement (if any)

const DEPRECATED_KEYS: Record<string, string | null> = {
  // Example: 'sessions.timeout' is deprecated in favor of 'sessions.initTimeoutMs'
  // 'sessions.timeout': 'sessions.initTimeoutMs',
};

// ─── Known keys map ─────────────────────────────────────────
// Static map of known keys for each config section.
// This avoids accessing Zod internals which causes type errors.

type SchemaKeyMap = Record<string, Set<string> | undefined>;

const NEO_CONFIG_KEYS: SchemaKeyMap = {
  "": new Set([
    "repos",
    "concurrency",
    "budget",
    "recovery",
    "sessions",
    "webhooks",
    "supervisor",
    "memory",
    "mcpServers",
    "models",
    "idempotency",
  ]),
  concurrency: new Set(["maxSessions", "maxPerRepo", "queueMax"]),
  budget: new Set(["dailyCapUsd", "alertThresholdPct"]),
  recovery: new Set(["maxRetries", "backoffBaseMs"]),
  sessions: new Set(["initTimeoutMs", "maxDurationMs", "dir"]),
  supervisor: new Set([
    "port",
    "secret",
    "heartbeatTimeoutMs",
    "maxConsecutiveFailures",
    "maxEventsPerSec",
    "dailyCapUsd",
    "consolidationIntervalMs",
    "compactionIntervalMs",
    "eventTimeoutMs",
    "instructions",
    "idleSkipMax",
    "activeWorkSkipMax",
    "autoDecide",
    "model",
  ]),
  memory: new Set(["embeddings"]),
  models: new Set(["default"]),
  idempotency: new Set(["enabled", "key", "ttlMs"]),
};

const REPO_OVERRIDE_KEYS: SchemaKeyMap = {
  "": new Set(["concurrency", "budget", "recovery", "sessions"]),
  concurrency: NEO_CONFIG_KEYS.concurrency,
  budget: NEO_CONFIG_KEYS.budget,
  recovery: NEO_CONFIG_KEYS.recovery,
  sessions: NEO_CONFIG_KEYS.sessions,
};

// ─── Unknown keys detection ─────────────────────────────────

/**
 * Recursively collects warnings for unknown keys in the input.
 */
function collectUnknownKeyWarnings(
  input: unknown,
  keyMap: SchemaKeyMap,
  path: string,
  warnings: ConfigWarning[],
): void {
  if (input === null || input === undefined || typeof input !== "object") {
    return;
  }

  if (Array.isArray(input)) {
    return;
  }

  const inputObj = input as Record<string, unknown>;
  const knownKeys = keyMap[path] ?? keyMap[""];

  if (!knownKeys) {
    return;
  }

  for (const key of Object.keys(inputObj)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (!knownKeys.has(key)) {
      warnings.push({
        type: "unknown_key",
        path: fullPath,
        message: `Unknown configuration key '${fullPath}'`,
      });
    } else {
      // Recurse into nested objects that have known key mappings
      const nestedKeys = keyMap[fullPath] ?? keyMap[key];
      if (nestedKeys && inputObj[key] && typeof inputObj[key] === "object") {
        collectUnknownKeyWarnings(inputObj[key], keyMap, fullPath, warnings);
      }
    }
  }
}

// ─── Deprecated keys detection ──────────────────────────────

/**
 * Checks for deprecated keys in the input.
 */
function collectDeprecatedWarnings(input: unknown, path: string, warnings: ConfigWarning[]): void {
  if (input === null || input === undefined || typeof input !== "object") {
    return;
  }

  if (Array.isArray(input)) {
    return;
  }

  const inputObj = input as Record<string, unknown>;

  for (const key of Object.keys(inputObj)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (fullPath in DEPRECATED_KEYS) {
      const replacement = DEPRECATED_KEYS[fullPath];
      const message = replacement
        ? `Configuration key '${fullPath}' is deprecated, use '${replacement}' instead`
        : `Configuration key '${fullPath}' is deprecated and will be removed`;
      warnings.push({
        type: "deprecated",
        path: fullPath,
        message,
      });
    }

    // Recurse into nested objects
    if (inputObj[key] && typeof inputObj[key] === "object") {
      collectDeprecatedWarnings(inputObj[key], fullPath, warnings);
    }
  }
}

// ─── Type coercion detection ────────────────────────────────

/**
 * Detects type coercions by comparing input types with parsed output.
 */
function collectTypeCoercionWarnings(
  input: unknown,
  parsed: unknown,
  path: string,
  warnings: ConfigWarning[],
): void {
  if (input === undefined || input === null) {
    return;
  }

  // Primitive type coercion detection
  const inputType = typeof input;
  const parsedType = typeof parsed;

  // Detect string-to-number coercion (e.g., "5" -> 5)
  if (inputType === "string" && parsedType === "number" && !Number.isNaN(Number(input))) {
    warnings.push({
      type: "type_coerced",
      path,
      message: `Value at '${path}' was coerced from string "${input}" to number ${parsed}`,
    });
    return;
  }

  // Detect string-to-boolean coercion (e.g., "true" -> true)
  if (inputType === "string" && parsedType === "boolean") {
    warnings.push({
      type: "type_coerced",
      path,
      message: `Value at '${path}' was coerced from string "${input}" to boolean ${parsed}`,
    });
    return;
  }

  // Recurse into objects
  if (
    inputType === "object" &&
    parsedType === "object" &&
    !Array.isArray(input) &&
    !Array.isArray(parsed)
  ) {
    const inputObj = input as Record<string, unknown>;
    const parsedObj = parsed as Record<string, unknown>;

    for (const key of Object.keys(inputObj)) {
      const fullPath = path ? `${path}.${key}` : key;
      collectTypeCoercionWarnings(inputObj[key], parsedObj[key], fullPath, warnings);
    }
  }

  // Recurse into arrays
  if (Array.isArray(input) && Array.isArray(parsed)) {
    for (let i = 0; i < input.length; i++) {
      collectTypeCoercionWarnings(input[i], parsed[i], `${path}[${i}]`, warnings);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Parses NeoConfig with warnings for unknown keys, deprecated options, and type coercions.
 *
 * @param input - Raw parsed YAML/JSON input
 * @returns ParseResult with config and warnings
 * @throws Error if parsing fails (validation errors are still fatal)
 */
export function parseConfigWithWarnings(input: unknown): ParseResult<NeoConfig> {
  const warnings: ConfigWarning[] = [];

  // Collect warnings before parsing
  collectUnknownKeyWarnings(input, NEO_CONFIG_KEYS, "", warnings);
  collectDeprecatedWarnings(input, "", warnings);

  // Parse with Zod - this will throw on validation errors
  const result = neoConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodErrors(result.error.issues));
  }

  // Collect type coercion warnings after parsing
  collectTypeCoercionWarnings(input, result.data, "", warnings);

  return {
    config: result.data,
    warnings,
  };
}

/**
 * Parses RepoOverrideConfig with warnings.
 *
 * @param input - Raw parsed YAML/JSON input
 * @returns ParseResult with config and warnings
 * @throws Error if parsing fails
 */
export function parseRepoConfigWithWarnings(input: unknown): ParseResult<RepoOverrideConfig> {
  const warnings: ConfigWarning[] = [];

  // Collect warnings before parsing
  collectUnknownKeyWarnings(input, REPO_OVERRIDE_KEYS, "", warnings);
  collectDeprecatedWarnings(input, "", warnings);

  // Parse with Zod
  const result = repoOverrideConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodErrors(result.error.issues));
  }

  // Collect type coercion warnings after parsing
  collectTypeCoercionWarnings(input, result.data, "", warnings);

  return {
    config: result.data,
    warnings,
  };
}

// ─── Helper ─────────────────────────────────────────────────

function formatZodErrors(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
