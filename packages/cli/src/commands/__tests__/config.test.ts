import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

// ─── Test isolation setup ────────────────────────────────────
// Mock homedir() and process.cwd() to use temp directories

const TMP_DIR = path.join(import.meta.dirname, "__tmp_config_cli__");
const MOCK_HOME = path.join(TMP_DIR, "home");
const MOCK_REPO = path.join(TMP_DIR, "repo");

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => MOCK_HOME,
  };
});

// Mock process.cwd() to return MOCK_REPO
const originalCwd = process.cwd;
let mockCwd = MOCK_REPO;

// Track console output
let consoleOutput: string[] = [];
let consoleErrorOutput: string[] = [];

beforeEach(async () => {
  // Setup directories
  await mkdir(MOCK_HOME, { recursive: true });
  await mkdir(path.join(MOCK_HOME, ".neo"), { recursive: true });
  await mkdir(path.join(MOCK_REPO, ".neo"), { recursive: true });

  // Reset mocks
  mockCwd = MOCK_REPO;
  process.cwd = () => mockCwd;

  // Capture console output
  consoleOutput = [];
  consoleErrorOutput = [];

  vi.spyOn(console, "log").mockImplementation((...args) => {
    consoleOutput.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
    consoleErrorOutput.push(String(msg));
    return true;
  });

  // Reset exitCode before each test
  process.exitCode = undefined;
});

afterEach(async () => {
  process.cwd = originalCwd;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Helper functions ────────────────────────────────────────

function writeGlobalConfig(content: Record<string, unknown>): Promise<void> {
  const configPath = path.join(MOCK_HOME, ".neo", "config.yml");
  return writeFile(configPath, stringifyYaml(content), "utf-8");
}

function writeRepoConfig(content: Record<string, unknown>): Promise<void> {
  const configPath = path.join(MOCK_REPO, ".neo", "config.yml");
  return writeFile(configPath, stringifyYaml(content), "utf-8");
}

// Import command after mocks are set up
async function runConfigCommand(args: Record<string, unknown>): Promise<number | undefined> {
  // Clear module cache to ensure fresh import with mocks
  vi.resetModules();
  // Reset exitCode before running command
  process.exitCode = undefined;

  const { default: configCommand } = await import("../config.js");
  await configCommand.run?.({ args: args as never } as never);

  return process.exitCode;
}

// ─── Tests ───────────────────────────────────────────────────

describe("neo config CLI", () => {
  describe("neo config list", () => {
    it("lists all config values in YAML format by default", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000 },
        concurrency: { maxSessions: 10 },
      });

      const exitCode = await runConfigCommand({ action: "list" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      expect(output).toContain("budget:");
      expect(output).toContain("dailyCapUsd: 1000");
      expect(output).toContain("concurrency:");
      expect(output).toContain("maxSessions: 10");
    });

    it("lists all config values in JSON format when --format=json", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 500 },
      });

      const exitCode = await runConfigCommand({ action: "list", format: "json" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.budget.dailyCapUsd).toBe(500);
    });

    it("uses defaults when no config file exists", async () => {
      // Remove config directories
      await rm(path.join(MOCK_HOME, ".neo"), { recursive: true, force: true });
      await rm(path.join(MOCK_REPO, ".neo"), { recursive: true, force: true });

      const exitCode = await runConfigCommand({ action: "list", format: "json" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      const parsed = JSON.parse(output);
      // Should have default values
      expect(parsed.budget.dailyCapUsd).toBe(500);
      expect(parsed.concurrency.maxSessions).toBe(5);
    });

    it("merges repo config over global config", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000 },
      });
      await writeRepoConfig({
        budget: { dailyCapUsd: 100 },
      });

      const exitCode = await runConfigCommand({ action: "list", format: "json" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.budget.dailyCapUsd).toBe(100);
    });
  });

  describe("neo config get <key>", () => {
    it("gets an existing key", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 750 },
      });

      const exitCode = await runConfigCommand({ action: "get", key: "budget.dailyCapUsd" });

      expect(exitCode).toBeUndefined();
      expect(consoleOutput).toContain("750");
    });

    it("gets nested keys with dot-notation", async () => {
      await writeGlobalConfig({
        concurrency: { maxSessions: 15, maxPerRepo: 3 },
      });

      const exitCode = await runConfigCommand({ action: "get", key: "concurrency.maxPerRepo" });

      expect(exitCode).toBeUndefined();
      expect(consoleOutput).toContain("3");
    });

    it("outputs JSON for object values", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 500, alertThresholdPct: 80 },
      });

      const exitCode = await runConfigCommand({ action: "get", key: "budget" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.dailyCapUsd).toBe(500);
      expect(parsed.alertThresholdPct).toBe(80);
    });

    it("handles missing key gracefully", async () => {
      await writeGlobalConfig({});

      const exitCode = await runConfigCommand({ action: "get", key: "nonexistent.path" });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Key not found: nonexistent.path");
    });

    it("errors when key argument is missing", async () => {
      const exitCode = await runConfigCommand({ action: "get" });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Usage: neo config get <key>");
    });

    it("returns default value for unset but valid schema key", async () => {
      // No config file, should use defaults
      await rm(path.join(MOCK_HOME, ".neo"), { recursive: true, force: true });
      await rm(path.join(MOCK_REPO, ".neo"), { recursive: true, force: true });

      const exitCode = await runConfigCommand({ action: "get", key: "recovery.maxRetries" });

      expect(exitCode).toBeUndefined();
      expect(consoleOutput).toContain("3"); // Default value
    });
  });

  describe("neo config set <key> <value>", () => {
    it("sets simple string values", async () => {
      const exitCode = await runConfigCommand({
        action: "set",
        key: "sessions.dir",
        value: "/custom/sessions",
        global: true,
      });

      expect(exitCode).toBeUndefined();
      expect(consoleOutput.join("")).toContain("Set sessions.dir");

      // Verify it was saved
      const exitCode2 = await runConfigCommand({ action: "get", key: "sessions.dir" });
      expect(exitCode2).toBeUndefined();
      expect(consoleOutput.join("\n")).toContain("/custom/sessions");
    });

    it("sets numeric values", async () => {
      const exitCode = await runConfigCommand({
        action: "set",
        key: "budget.dailyCapUsd",
        value: "1500",
        global: true,
      });

      expect(exitCode).toBeUndefined();

      // Verify it was saved as number
      const exitCode2 = await runConfigCommand({ action: "get", key: "budget.dailyCapUsd" });
      expect(exitCode2).toBeUndefined();
      expect(consoleOutput).toContain("1500");
    });

    it("sets boolean values", async () => {
      const exitCode = await runConfigCommand({
        action: "set",
        key: "memory.embeddings",
        value: "false",
        global: true,
      });

      expect(exitCode).toBeUndefined();

      // Verify it was saved
      const exitCode2 = await runConfigCommand({ action: "get", key: "memory.embeddings" });
      expect(exitCode2).toBeUndefined();
      expect(consoleOutput).toContain("false");
    });

    it("sets nested paths via dot-notation", async () => {
      const exitCode = await runConfigCommand({
        action: "set",
        key: "concurrency.maxPerRepo",
        value: "8",
        global: true,
      });

      expect(exitCode).toBeUndefined();

      const exitCode2 = await runConfigCommand({ action: "get", key: "concurrency.maxPerRepo" });
      expect(exitCode2).toBeUndefined();
      expect(consoleOutput).toContain("8");
    });

    it("handles JSON values for complex objects", async () => {
      const exitCode = await runConfigCommand({
        action: "set",
        key: "idempotency",
        value: '{"enabled":true,"key":"prompt","ttlMs":7200000}',
        global: true,
      });

      expect(exitCode).toBeUndefined();

      const exitCode2 = await runConfigCommand({ action: "get", key: "idempotency.key" });
      expect(exitCode2).toBeUndefined();
      expect(consoleOutput).toContain("prompt");
    });

    it("validates against schema and rejects invalid values", async () => {
      const exitCode = await runConfigCommand({
        action: "set",
        key: "budget.dailyCapUsd",
        value: "not-a-number",
        global: true,
      });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Invalid config value");
    });

    it("sets to repo config by default when in a repo", async () => {
      // Create .git directory to simulate being in a repo
      await mkdir(path.join(MOCK_REPO, ".git"), { recursive: true });

      const exitCode = await runConfigCommand({
        action: "set",
        key: "budget.dailyCapUsd",
        value: "200",
        global: false,
      });

      expect(exitCode).toBeUndefined();

      // Check it was saved to repo config
      const { existsSync, readFileSync } = await import("node:fs");
      const repoConfigPath = path.join(MOCK_REPO, ".neo", "config.yml");
      expect(existsSync(repoConfigPath)).toBe(true);

      const content = readFileSync(repoConfigPath, "utf-8");
      expect(content).toContain("dailyCapUsd: 200");
    });

    it("errors when not in repo and --global not specified", async () => {
      // Simulate being outside a repo
      mockCwd = "/tmp/not-a-repo";

      const exitCode = await runConfigCommand({
        action: "set",
        key: "budget.dailyCapUsd",
        value: "100",
        global: false,
      });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Not in a repository");
    });

    it("errors when key or value is missing", async () => {
      const exitCode = await runConfigCommand({ action: "set", key: "budget.dailyCapUsd" });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Usage: neo config set");
    });
  });

  describe("neo config unset <key>", () => {
    it("unsets an existing key", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000, alertThresholdPct: 90 },
      });

      const exitCode = await runConfigCommand({
        action: "unset",
        key: "budget.alertThresholdPct",
        global: true,
      });

      expect(exitCode).toBeUndefined();
      expect(consoleOutput.join("")).toContain("Unset budget.alertThresholdPct");
    });

    it("errors when key does not exist", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000 },
      });

      const exitCode = await runConfigCommand({
        action: "unset",
        key: "nonexistent.key",
        global: true,
      });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Key not found");
    });

    it("errors when config file does not exist", async () => {
      await rm(path.join(MOCK_HOME, ".neo", "config.yml"), { force: true });

      const exitCode = await runConfigCommand({
        action: "unset",
        key: "budget.dailyCapUsd",
        global: true,
      });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Config file not found");
    });

    it("errors when key argument is missing", async () => {
      const exitCode = await runConfigCommand({ action: "unset", global: true });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Usage: neo config unset");
    });
  });

  describe("neo config path", () => {
    it("shows global and repo config paths", async () => {
      const exitCode = await runConfigCommand({ action: "path" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      expect(output).toContain("Global:");
      expect(output).toContain(".neo/config.yml");
      expect(output).toContain("Repo:");
    });

    it("shows (not found) for missing config files", async () => {
      await rm(path.join(MOCK_HOME, ".neo", "config.yml"), { force: true });
      await rm(path.join(MOCK_REPO, ".neo", "config.yml"), { force: true });

      const exitCode = await runConfigCommand({ action: "path" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      expect(output).toContain("(not found)");
    });

    it("shows (not in a repository) when outside a repo", async () => {
      mockCwd = "/tmp/not-a-repo";

      const exitCode = await runConfigCommand({ action: "path" });

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      expect(output).toContain("(not in a repository)");
    });
  });

  describe("unknown action", () => {
    it("errors with unknown action", async () => {
      const exitCode = await runConfigCommand({ action: "invalid" });

      expect(exitCode).toBe(1);
      expect(consoleErrorOutput.join("")).toContain("Unknown action: invalid");
    });
  });

  describe("default action", () => {
    it("defaults to list when no action provided", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      const exitCode = await runConfigCommand({});

      expect(exitCode).toBeUndefined();
      const output = consoleOutput.join("\n");
      expect(output).toContain("budget:");
    });
  });
});
