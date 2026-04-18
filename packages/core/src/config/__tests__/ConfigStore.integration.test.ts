import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

// ─── Test isolation setup ────────────────────────────────────
// We mock homedir() to use a tmp directory so tests don't touch the real ~/.neo

const TMP_DIR = path.join(import.meta.dirname, "__tmp_configstore_integration__");
const MOCK_HOME = path.join(TMP_DIR, "home");
const MOCK_REPO = path.join(TMP_DIR, "repo");

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => MOCK_HOME,
  };
});

// Import after mocking to ensure mock is applied
import { ConfigStore } from "../ConfigStore";
import { defaultConfig } from "../merge";

beforeEach(async () => {
  await mkdir(MOCK_HOME, { recursive: true });
  await mkdir(path.join(MOCK_HOME, ".neo"), { recursive: true });
  await mkdir(path.join(MOCK_REPO, ".neo"), { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Helper functions ────────────────────────────────────────

const DEFAULT_PROVIDER = {
  adapter: "claude",
  models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
};

function writeGlobalConfig(content: Record<string, unknown>): Promise<void> {
  const configPath = path.join(MOCK_HOME, ".neo", "config.yml");
  const withProvider = { provider: DEFAULT_PROVIDER, ...content };
  return writeFile(configPath, stringifyYaml(withProvider), "utf-8");
}

function writeRepoConfig(content: Record<string, unknown>): Promise<void> {
  const configPath = path.join(MOCK_REPO, ".neo", "config.yml");
  return writeFile(configPath, stringifyYaml(content), "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────

describe("ConfigStore integration", () => {
  describe("loading config from disk", () => {
    it("loads global config from ~/.neo/config.yml", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000 },
        concurrency: { maxSessions: 10 },
      });

      const store = new ConfigStore();
      await store.load();

      expect(store.get<number>("budget.dailyCapUsd")).toBe(1000);
      expect(store.get<number>("concurrency.maxSessions")).toBe(10);
    });

    it("loads local repo config from <repoPath>/.neo/config.yml", async () => {
      await writeRepoConfig({
        budget: { dailyCapUsd: 250 },
      });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      expect(store.get<number>("budget.dailyCapUsd")).toBe(250);
    });

    it("returns defaults when no config files exist", async () => {
      // Remove the .neo directories created in beforeEach
      await rm(path.join(MOCK_HOME, ".neo"), { recursive: true, force: true });
      await rm(path.join(MOCK_REPO, ".neo"), { recursive: true, force: true });

      const store = new ConfigStore();
      await store.load();

      expect(store.get<number>("budget.dailyCapUsd")).toBe(defaultConfig.budget.dailyCapUsd);
      expect(store.get<number>("concurrency.maxSessions")).toBe(
        defaultConfig.concurrency.maxSessions,
      );
    });

    it("silently ignores malformed YAML in global config", async () => {
      const configPath = path.join(MOCK_HOME, ".neo", "config.yml");
      await writeFile(configPath, "invalid: yaml: [", "utf-8");

      const store = new ConfigStore();
      await store.load();

      // Falls back to defaults
      expect(store.get<number>("budget.dailyCapUsd")).toBe(defaultConfig.budget.dailyCapUsd);
    });

    it("silently ignores malformed YAML in repo config", async () => {
      await writeGlobalConfig({ budget: { dailyCapUsd: 1000 } });
      const repoConfigPath = path.join(MOCK_REPO, ".neo", "config.yml");
      await writeFile(repoConfigPath, "invalid: yaml: [", "utf-8");

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      // Uses global config, repo config ignored
      expect(store.get<number>("budget.dailyCapUsd")).toBe(1000);
    });

    it("silently ignores invalid schema in global config", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: "not-a-number" },
      });

      const store = new ConfigStore();
      await store.load();

      // Falls back to defaults
      expect(store.get<number>("budget.dailyCapUsd")).toBe(defaultConfig.budget.dailyCapUsd);
    });
  });

  describe("merging precedence", () => {
    it("repo config overrides global config", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000, alertThresholdPct: 90 },
        concurrency: { maxSessions: 10 },
      });
      await writeRepoConfig({
        budget: { dailyCapUsd: 250, alertThresholdPct: 95 },
      });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      // Repo overrides global for explicitly set values
      expect(store.get<number>("budget.dailyCapUsd")).toBe(250);
      expect(store.get<number>("budget.alertThresholdPct")).toBe(95);
      // Other sections unaffected by repo override
      expect(store.get<number>("concurrency.maxSessions")).toBe(10);
    });

    it("global config overrides defaults", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 750 },
      });

      const store = new ConfigStore();
      await store.load();

      expect(store.get<number>("budget.dailyCapUsd")).toBe(750);
      // Default preserved for non-overridden values
      expect(store.get<number>("budget.alertThresholdPct")).toBe(
        defaultConfig.budget.alertThresholdPct,
      );
    });

    it("deep merges nested objects within sections", async () => {
      await writeGlobalConfig({
        concurrency: { maxSessions: 20, maxPerRepo: 8 },
      });
      await writeRepoConfig({
        concurrency: { maxPerRepo: 2, maxSessions: 15 },
      });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      // Repo overrides both specified values
      expect(store.get<number>("concurrency.maxPerRepo")).toBe(2);
      expect(store.get<number>("concurrency.maxSessions")).toBe(15);
      // Default value used for unspecified fields
      expect(store.get<number>("concurrency.queueMax")).toBe(defaultConfig.concurrency.queueMax);
    });

    it("global config applies to sections not present in repo config", async () => {
      await writeGlobalConfig({
        concurrency: { maxSessions: 20 },
        recovery: { maxRetries: 7 },
      });
      await writeRepoConfig({
        concurrency: { maxPerRepo: 2 },
      });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      // recovery section untouched by repo config — uses global values
      expect(store.get<number>("recovery.maxRetries")).toBe(7);
    });

    it("applies three-level precedence: repo > global > defaults", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000 },
        recovery: { maxRetries: 5 },
      });
      await writeRepoConfig({
        budget: { dailyCapUsd: 100 },
      });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      // Repo (highest priority)
      expect(store.get<number>("budget.dailyCapUsd")).toBe(100);
      // Global (middle priority)
      expect(store.get<number>("recovery.maxRetries")).toBe(5);
      // Default (lowest priority)
      expect(store.get<number>("sessions.initTimeoutMs")).toBe(
        defaultConfig.sessions.initTimeoutMs,
      );
    });
  });

  describe("get and getAll", () => {
    it("throws when called before load()", () => {
      const store = new ConfigStore();

      expect(() => store.get("budget.dailyCapUsd")).toThrow("ConfigStore not loaded");
      expect(() => store.getAll()).toThrow("ConfigStore not loaded");
    });

    it("getAll() returns the full merged config", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 800 },
      });

      const store = new ConfigStore();
      await store.load();

      const config = store.getAll();
      expect(config.budget.dailyCapUsd).toBe(800);
      expect(config.concurrency.maxSessions).toBe(defaultConfig.concurrency.maxSessions);
    });

    it("get() supports dot notation for nested paths", async () => {
      await writeGlobalConfig({
        supervisor: { port: 8080 },
      });

      const store = new ConfigStore();
      await store.load();

      expect(store.get<number>("supervisor.port")).toBe(8080);
    });

    it("get() returns undefined for missing paths", async () => {
      const store = new ConfigStore();
      await store.load();

      expect(store.get("nonexistent.path")).toBeUndefined();
    });
  });

  describe("getRepoPath", () => {
    it("returns undefined when no repoPath provided", () => {
      const store = new ConfigStore();
      expect(store.getRepoPath()).toBeUndefined();
    });

    it("returns the repoPath when provided", () => {
      const store = new ConfigStore(MOCK_REPO);
      expect(store.getRepoPath()).toBe(MOCK_REPO);
    });
  });

  describe("file creation behavior", () => {
    it("does not create config files that do not exist", async () => {
      // Start fresh without any .neo directories
      await rm(path.join(MOCK_HOME, ".neo"), { recursive: true, force: true });
      await rm(path.join(MOCK_REPO, ".neo"), { recursive: true, force: true });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      // ConfigStore is read-only — it does not create files
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(MOCK_HOME, ".neo", "config.yml"))).toBe(false);
      expect(existsSync(path.join(MOCK_REPO, ".neo", "config.yml"))).toBe(false);
    });
  });

  describe("concurrent access", () => {
    it("multiple stores can load the same global config concurrently", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 500 },
      });

      const store1 = new ConfigStore();
      const store2 = new ConfigStore();
      const store3 = new ConfigStore();

      // Load all concurrently
      await Promise.all([store1.load(), store2.load(), store3.load()]);

      expect(store1.get<number>("budget.dailyCapUsd")).toBe(500);
      expect(store2.get<number>("budget.dailyCapUsd")).toBe(500);
      expect(store3.get<number>("budget.dailyCapUsd")).toBe(500);
    });

    it("multiple stores with different repo paths load independently", async () => {
      const repo2 = path.join(TMP_DIR, "repo2");
      await mkdir(path.join(repo2, ".neo"), { recursive: true });

      await writeGlobalConfig({ budget: { dailyCapUsd: 1000 } });
      await writeRepoConfig({ budget: { dailyCapUsd: 100 } });
      await writeFile(
        path.join(repo2, ".neo", "config.yml"),
        stringifyYaml({ budget: { dailyCapUsd: 200 } }),
        "utf-8",
      );

      const store1 = new ConfigStore(MOCK_REPO);
      const store2 = new ConfigStore(repo2);

      await Promise.all([store1.load(), store2.load()]);

      expect(store1.get<number>("budget.dailyCapUsd")).toBe(100);
      expect(store2.get<number>("budget.dailyCapUsd")).toBe(200);
    });

    it("stores are independent — reloading one does not affect others", async () => {
      await writeGlobalConfig({ budget: { dailyCapUsd: 500 } });

      const store1 = new ConfigStore();
      const store2 = new ConfigStore();

      await store1.load();
      await store2.load();

      // Modify the config file
      await writeGlobalConfig({ budget: { dailyCapUsd: 999 } });

      // Reload only store1
      await store1.load();

      expect(store1.get<number>("budget.dailyCapUsd")).toBe(999);
      expect(store2.get<number>("budget.dailyCapUsd")).toBe(500); // Still old value
    });
  });
});
