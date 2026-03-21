/**
 * Config parsing warnings for deprecated and unknown fields.
 *
 * Warnings inform users about configuration issues without blocking loading.
 */

// ─── Types ────────────────────────────────────────────────────

export type ConfigWarningType = "deprecated" | "unknown";

export interface ConfigWarning {
  type: ConfigWarningType;
  field: string;
  message: string;
  suggestion?: string | undefined;
}

export interface ConfigParseResult<T> {
  data: T;
  warnings: ConfigWarning[];
}

// ─── Deprecated fields registry ───────────────────────────────

/**
 * Registry of deprecated config fields with their migration info.
 * Key is the field path (dot notation), value is the deprecation info.
 */
export const DEPRECATED_FIELDS: Record<
  string,
  { since: string; replacement?: string; message: string }
> = {
  // Example deprecated fields - add real ones as they become deprecated
  // 'concurrency.maxWorkers': {
  //   since: '0.5.0',
  //   replacement: 'concurrency.maxSessions',
  //   message: 'Use concurrency.maxSessions instead',
  // },
};

// ─── Known fields registry ────────────────────────────────────

/**
 * Set of all known top-level config fields.
 * Used to detect unknown fields that might be typos.
 */
export const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "repos",
  "concurrency",
  "budget",
  "recovery",
  "sessions",
  "webhooks",
  "supervisor",
  "memory",
  "mcpServers",
  "claudeCodePath",
  "idempotency",
]);

/**
 * Known nested fields per top-level key.
 * Used for deeper unknown field detection.
 */
export const KNOWN_NESTED_FIELDS: Record<string, Set<string>> = {
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
  ]),
  memory: new Set(["embeddings"]),
  idempotency: new Set(["enabled", "key", "ttlMs"]),
};

/**
 * Known fields for repo config entries.
 */
export const KNOWN_REPO_FIELDS = new Set([
  "path",
  "name",
  "defaultBranch",
  "branchPrefix",
  "pushRemote",
  "gitStrategy",
]);

/**
 * Known fields for webhook config entries.
 */
export const KNOWN_WEBHOOK_FIELDS = new Set(["url", "events", "secret", "timeoutMs"]);

/**
 * Known fields for MCP server config entries.
 */
export const KNOWN_MCP_SERVER_FIELDS = new Set([
  "type",
  "url",
  "headers",
  "command",
  "args",
  "env",
]);

// ─── Helper functions ─────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createUnknownWarning(
  field: string,
  messagePrefix: string,
  unknownKey: string,
  knownFields: Set<string>,
): ConfigWarning {
  return {
    type: "unknown",
    field,
    message: `${messagePrefix}'${field}'`,
    suggestion: getSuggestion(unknownKey, knownFields),
  };
}

// ─── Warning detection ────────────────────────────────────────

/**
 * Checks for deprecated fields in the config.
 */
function checkDeprecatedFields(config: Record<string, unknown>, path = ""): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const [key, value] of Object.entries(config)) {
    const fieldPath = path ? `${path}.${key}` : key;

    const deprecation = DEPRECATED_FIELDS[fieldPath];
    if (deprecation) {
      warnings.push({
        type: "deprecated",
        field: fieldPath,
        message: `Field '${fieldPath}' is deprecated since ${deprecation.since}. ${deprecation.message}`,
        suggestion: deprecation.replacement
          ? `Use '${deprecation.replacement}' instead`
          : undefined,
      });
    }

    if (isPlainObject(value)) {
      warnings.push(...checkDeprecatedFields(value, fieldPath));
    }
  }

  return warnings;
}

/**
 * Checks nested object fields against known field set.
 */
function checkNestedFields(
  key: string,
  value: Record<string, unknown>,
  knownFields: Set<string>,
): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const nestedKey of Object.keys(value)) {
    if (!knownFields.has(nestedKey)) {
      warnings.push(
        createUnknownWarning(
          `${key}.${nestedKey}`,
          "Unknown config field ",
          nestedKey,
          knownFields,
        ),
      );
    }
  }

  return warnings;
}

/**
 * Checks array entries for unknown fields.
 */
function checkArrayEntries(
  key: string,
  items: unknown[],
  knownFields: Set<string>,
  messagePrefix: string,
): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isPlainObject(item)) {
      for (const itemKey of Object.keys(item)) {
        if (!knownFields.has(itemKey)) {
          warnings.push(
            createUnknownWarning(`${key}[${i}].${itemKey}`, messagePrefix, itemKey, knownFields),
          );
        }
      }
    }
  }

  return warnings;
}

/**
 * Checks MCP server entries for unknown fields.
 */
function checkMcpServers(servers: Record<string, unknown>): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (isPlainObject(serverConfig)) {
      for (const serverKey of Object.keys(serverConfig)) {
        if (!KNOWN_MCP_SERVER_FIELDS.has(serverKey)) {
          warnings.push(
            createUnknownWarning(
              `mcpServers.${serverName}.${serverKey}`,
              "Unknown MCP server config field ",
              serverKey,
              KNOWN_MCP_SERVER_FIELDS,
            ),
          );
        }
      }
    }
  }

  return warnings;
}

/**
 * Checks for unknown fields in the config.
 */
function checkUnknownFields(config: Record<string, unknown>): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const [key, value] of Object.entries(config)) {
    // Check top-level unknown fields
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      warnings.push(
        createUnknownWarning(key, "Unknown config field ", key, KNOWN_TOP_LEVEL_FIELDS),
      );
      continue;
    }

    // Check nested object fields
    if (isPlainObject(value)) {
      const nestedKnown = KNOWN_NESTED_FIELDS[key];
      if (nestedKnown) {
        warnings.push(...checkNestedFields(key, value, nestedKnown));
      }
    }

    // Check repos array
    if (key === "repos" && Array.isArray(value)) {
      warnings.push(
        ...checkArrayEntries(key, value, KNOWN_REPO_FIELDS, "Unknown repo config field "),
      );
    }

    // Check webhooks array
    if (key === "webhooks" && Array.isArray(value)) {
      warnings.push(
        ...checkArrayEntries(key, value, KNOWN_WEBHOOK_FIELDS, "Unknown webhook config field "),
      );
    }

    // Check mcpServers
    if (key === "mcpServers" && isPlainObject(value)) {
      warnings.push(...checkMcpServers(value));
    }
  }

  return warnings;
}

/**
 * Finds a suggestion for a typo by checking Levenshtein distance.
 */
function getSuggestion(unknown: string, known: Set<string>): string | undefined {
  const threshold = 3;
  let bestMatch: string | undefined;
  let bestDistance = threshold + 1;

  for (const candidate of known) {
    const distance = levenshteinDistance(unknown.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  return bestMatch ? `Did you mean '${bestMatch}'?` : undefined;
}

/**
 * Calculates the Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  // Handle empty strings
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Initialize matrix with proper dimensions
  const rows = b.length + 1;
  const cols = a.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  // Fill first column
  for (let i = 0; i <= b.length; i++) {
    const row = matrix[i];
    if (row) row[0] = i;
  }

  // Fill first row
  const firstRow = matrix[0];
  if (firstRow) {
    for (let j = 0; j <= a.length; j++) {
      firstRow[j] = j;
    }
  }

  // Fill rest of matrix
  for (let i = 1; i <= b.length; i++) {
    const currentRow = matrix[i];
    const prevRow = matrix[i - 1];
    if (!currentRow || !prevRow) continue;

    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      const deletion = (prevRow[j] ?? 0) + 1;
      const insertion = (currentRow[j - 1] ?? 0) + 1;
      const substitution = (prevRow[j - 1] ?? 0) + cost;
      currentRow[j] = Math.min(deletion, insertion, substitution);
    }
  }

  const lastRow = matrix[b.length];
  return lastRow ? (lastRow[a.length] ?? 0) : 0;
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Collects all warnings from a parsed config object.
 *
 * @param config - Raw parsed YAML config (before Zod validation)
 * @returns Array of warnings for deprecated and unknown fields
 */
export function collectConfigWarnings(config: Record<string, unknown>): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  warnings.push(...checkDeprecatedFields(config));
  warnings.push(...checkUnknownFields(config));

  return warnings;
}

/**
 * Formats warnings for console output.
 *
 * @param warnings - Array of config warnings
 * @param filePath - Path to the config file (for context)
 * @returns Formatted warning messages
 */
export function formatConfigWarnings(warnings: ConfigWarning[], filePath: string): string[] {
  return warnings.map((w) => {
    const prefix = w.type === "deprecated" ? "[deprecated]" : "[unknown]";
    const suggestion = w.suggestion ? ` ${w.suggestion}` : "";
    return `[neo] ${prefix} ${filePath}: ${w.message}${suggestion}`;
  });
}
