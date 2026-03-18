import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigStore, getDataDir, neoConfigSchema, repoOverrideConfigSchema } from "@neotx/core";
import { defineCommand } from "citty";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { printError, printJson, printSuccess } from "../output.js";

// ─── Path helpers ───────────────────────────────────────────

function getGlobalConfigPath(): string {
  return join(getDataDir(), "config.yml");
}

function getRepoConfigPath(repoPath: string): string {
  return join(repoPath, ".neo", "config.yml");
}

function findRepoRoot(): string | undefined {
  // Look for .neo/config.yml or .git in current directory
  const cwd = process.cwd();
  if (existsSync(join(cwd, ".neo", "config.yml"))) {
    return cwd;
  }
  if (existsSync(join(cwd, ".git"))) {
    return cwd;
  }
  return undefined;
}

// ─── Dot-notation helpers ───────────────────────────────────

function getByPath(obj: unknown, path: string): unknown {
  if (path === "") return obj;

  const keys = path.split(".");
  let current = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (path === "") return value as Record<string, unknown>;

  const keys = path.split(".");
  const result = { ...obj };
  let current: Record<string, unknown> = result;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
      current[key] = {};
    } else {
      current[key] = { ...(current[key] as Record<string, unknown>) };
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }

  return result;
}

function unsetByPath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  if (path === "") return {};

  const keys = path.split(".");
  const result = { ...obj };

  if (keys.length === 1) {
    const firstKey = keys[0];
    if (firstKey !== undefined) {
      delete result[firstKey];
    }
    return result;
  }

  // Navigate to parent and delete the last key
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    if (current[key] === undefined || typeof current[key] !== "object") {
      return result; // Path doesn't exist
    }
    current[key] = { ...(current[key] as Record<string, unknown>) };
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  if (lastKey !== undefined) {
    delete current[lastKey];
  }
  return result;
}

// ─── Config file I/O ────────────────────────────────────────

async function loadConfigFile(filePath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(filePath)) return null;

  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = parseYaml(content);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function saveConfigFile(filePath: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, stringifyYaml(config), "utf-8");
}

// ─── Handlers ───────────────────────────────────────────────

async function handleGet(key: string): Promise<void> {
  const repoPath = findRepoRoot();
  const store = new ConfigStore(repoPath);
  await store.load();

  try {
    const value = store.get(key);

    if (value === undefined) {
      printError(`Key not found: ${key}`);
      process.exitCode = 1;
      return;
    }

    // Output: JSON for objects/arrays, plain for primitives
    if (typeof value === "object" && value !== null) {
      printJson(value);
    } else {
      console.log(String(value));
    }
  } catch {
    printError(`Key not found: ${key}`);
    process.exitCode = 1;
  }
}

async function handleList(format: string): Promise<void> {
  const repoPath = findRepoRoot();
  const store = new ConfigStore(repoPath);
  await store.load();

  const config = store.getAll();

  if (format === "json") {
    printJson(config);
  } else {
    // Default to YAML
    console.log(stringifyYaml(config));
  }
}

async function handleSet(key: string, value: string, global: boolean): Promise<void> {
  const configPath = global ? getGlobalConfigPath() : getRepoConfigPath(process.cwd());

  if (!global && !findRepoRoot()) {
    printError("Not in a repository. Use --global to set global config.");
    process.exitCode = 1;
    return;
  }

  // Load existing config or start with empty object
  let config = (await loadConfigFile(configPath)) ?? {};

  // Parse value - try JSON first, fall back to string
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    // Check for boolean strings
    if (value === "true") {
      parsedValue = true;
    } else if (value === "false") {
      parsedValue = false;
    } else if (!Number.isNaN(Number(value)) && value.trim() !== "") {
      parsedValue = Number(value);
    } else {
      parsedValue = value;
    }
  }

  // Update config with new value
  config = setByPath(config, key, parsedValue);

  // Validate against schema before saving
  const schema = global ? neoConfigSchema : repoOverrideConfigSchema;
  const validation = schema.safeParse(config);

  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    printError(`Invalid config value:\n${issues}`);
    process.exitCode = 1;
    return;
  }

  await saveConfigFile(configPath, config);
  printSuccess(`Set ${key} = ${JSON.stringify(parsedValue)}`);
}

async function handleUnset(key: string, global: boolean): Promise<void> {
  const configPath = global ? getGlobalConfigPath() : getRepoConfigPath(process.cwd());

  if (!global && !findRepoRoot()) {
    printError("Not in a repository. Use --global to unset global config.");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfigFile(configPath);

  if (!config) {
    printError(`Config file not found: ${configPath}`);
    process.exitCode = 1;
    return;
  }

  // Check if key exists
  if (getByPath(config, key) === undefined) {
    printError(`Key not found: ${key}`);
    process.exitCode = 1;
    return;
  }

  const updatedConfig = unsetByPath(config, key);
  await saveConfigFile(configPath, updatedConfig);
  printSuccess(`Unset ${key}`);
}

function handlePath(): void {
  const globalPath = getGlobalConfigPath();
  const globalExists = existsSync(globalPath);

  console.log(`Global: ${globalPath}${globalExists ? "" : " (not found)"}`);

  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const repoPath = getRepoConfigPath(repoRoot);
    const repoExists = existsSync(repoPath);
    console.log(`Repo:   ${repoPath}${repoExists ? "" : " (not found)"}`);
  } else {
    console.log("Repo:   (not in a repository)");
  }
}

// ─── Command definition ─────────────────────────────────────

export default defineCommand({
  meta: {
    name: "config",
    description: "Manage neo configuration",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: get, list, set, unset, path",
      required: false,
    },
    key: {
      type: "positional",
      description: "Config key (dot notation, e.g., budget.dailyCapUsd)",
      required: false,
    },
    value: {
      type: "positional",
      description: "Value to set",
      required: false,
    },
    global: {
      type: "boolean",
      description: "Use global config (~/.neo/config.yml)",
      default: false,
      alias: "g",
    },
    format: {
      type: "string",
      description: "Output format: yaml, json (for list)",
      default: "yaml",
      alias: "f",
    },
  },
  async run({ args }) {
    const action = (args.action as string | undefined) ?? "list";
    const key = args.key as string | undefined;
    const value = args.value as string | undefined;
    const global = args.global as boolean;
    const format = args.format as string;

    switch (action) {
      case "get":
        if (!key) {
          printError("Usage: neo config get <key>");
          process.exitCode = 1;
          return;
        }
        return handleGet(key);

      case "list":
        return handleList(format);

      case "set":
        if (!key || value === undefined) {
          printError("Usage: neo config set <key> <value> [--global]");
          process.exitCode = 1;
          return;
        }
        return handleSet(key, value, global);

      case "unset":
        if (!key) {
          printError("Usage: neo config unset <key> [--global]");
          process.exitCode = 1;
          return;
        }
        return handleUnset(key, global);

      case "path":
        return handlePath();

      default:
        printError(`Unknown action: ${action}. Use: get, list, set, unset, path`);
        process.exitCode = 1;
    }
  },
});
