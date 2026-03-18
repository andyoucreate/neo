import type { NeoConfig } from "./schema";

/**
 * Retrieves a nested value from config using dot notation.
 *
 * @param config - The configuration object
 * @param path - Dot-separated path (e.g., "budget.dailyCapUsd")
 * @returns The value at the path, or undefined if not found
 *
 * @example
 * getConfigValue(config, "budget.dailyCapUsd") // 500
 * getConfigValue(config, "missing.path") // undefined
 */
export function getConfigValue(config: NeoConfig, path: string): unknown {
  if (path === "") {
    return config;
  }

  const keys = path.split(".");
  let current: unknown = config;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Sets a nested value in config using dot notation, returning a new config object.
 * Creates intermediate objects as needed.
 *
 * @param config - The configuration object
 * @param path - Dot-separated path (e.g., "budget.dailyCapUsd")
 * @param value - The value to set
 * @returns A new config object with the value set (immutable update)
 *
 * @example
 * setConfigValue(config, "budget.dailyCapUsd", 1000)
 * setConfigValue(config, "new.nested.key", "value")
 */
export function setConfigValue(config: NeoConfig, path: string, value: unknown): NeoConfig {
  if (path === "") {
    // Empty path means replace entire config
    return value as NeoConfig;
  }

  const keys = path.split(".");
  return setNestedValue(config, keys, value) as NeoConfig;
}

/**
 * Recursively builds a new object with the value set at the given key path.
 */
function setNestedValue(obj: unknown, keys: readonly string[], value: unknown): unknown {
  const key = keys[0];
  if (key === undefined) {
    return value;
  }

  const rest = keys.slice(1);

  // Get current object or create empty object if missing/invalid
  const current: Record<string, unknown> =
    obj !== null && typeof obj === "object" ? { ...(obj as Record<string, unknown>) } : {};

  if (rest.length === 0) {
    // Last key - set the value
    current[key] = value;
  } else {
    // Intermediate key - recurse
    current[key] = setNestedValue(current[key], rest, value);
  }

  return current;
}
