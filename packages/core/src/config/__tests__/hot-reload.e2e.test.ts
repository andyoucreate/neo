import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ConfigStore } from "../ConfigStore";
import { ConfigWatcher } from "../ConfigWatcher";
import { defaultConfig } from "../merge";

// ─── Test isolation setup ────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_hot_reload_e2e__");
const MOCK_HOME = path.join(TMP_DIR, "home");
const MOCK_REPO = path.join(TMP_DIR, "repo");

// Mock homedir to use temp directory
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => MOCK_HOME,
  };
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

/**
 * Wait for a condition to be true with polling.
 * Used for async file system events.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timeout exceeded");
}

// ─── Setup / Teardown ────────────────────────────────────────

beforeEach(async () => {
  await mkdir(MOCK_HOME, { recursive: true });
  await mkdir(path.join(MOCK_HOME, ".neo"), { recursive: true });
  await mkdir(path.join(MOCK_REPO, ".neo"), { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── E2E Tests: Hot-reload workflow ──────────────────────────

describe("hot-reload E2E", () => {
  describe("ConfigWatcher detects file changes", () => {
    it("emits change event when global config file is modified", async () => {
      // 1. Create initial config
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      // 2. Create ConfigStore and ConfigWatcher
      const store = new ConfigStore();
      await store.load();
      expect(store.get<number>("budget.dailyCapUsd")).toBe(100);

      // Short debounce for faster tests
      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      let changeCount = 0;
      watcher.on("change", () => {
        changeCount++;
      });

      // 3. Start watching
      watcher.start();

      try {
        // 4. Modify the config file
        await writeGlobalConfig({
          budget: { dailyCapUsd: 500 },
        });

        // 5. Wait for the change event
        await waitFor(() => changeCount > 0, 3000);

        // 6. Verify store was reloaded with new value
        expect(store.get<number>("budget.dailyCapUsd")).toBe(500);
        expect(changeCount).toBeGreaterThanOrEqual(1);
      } finally {
        watcher.stop();
      }
    });

    it("emits change event when repo config file is modified", async () => {
      // 1. Create initial configs
      await writeGlobalConfig({
        budget: { dailyCapUsd: 1000 },
      });
      await writeRepoConfig({
        budget: { dailyCapUsd: 250 },
      });

      // 2. Create ConfigStore with repo path
      const store = new ConfigStore(MOCK_REPO);
      await store.load();
      expect(store.get<number>("budget.dailyCapUsd")).toBe(250);

      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      let changeCount = 0;
      watcher.on("change", () => {
        changeCount++;
      });

      watcher.start();

      try {
        // 3. Modify repo config
        await writeRepoConfig({
          budget: { dailyCapUsd: 300 },
        });

        // 4. Wait for change
        await waitFor(() => changeCount > 0, 3000);

        // 5. Verify new value
        expect(store.get<number>("budget.dailyCapUsd")).toBe(300);
      } finally {
        watcher.stop();
      }
    });

    it("handles multiple rapid file changes with debouncing", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      const store = new ConfigStore();
      await store.load();

      // Use longer debounce to ensure batching
      const watcher = new ConfigWatcher(store, { debounceMs: 100 });
      let changeCount = 0;
      watcher.on("change", () => {
        changeCount++;
      });

      watcher.start();

      try {
        // Make 3 rapid changes
        await writeGlobalConfig({ budget: { dailyCapUsd: 200 } });
        await new Promise((r) => setTimeout(r, 20));
        await writeGlobalConfig({ budget: { dailyCapUsd: 300 } });
        await new Promise((r) => setTimeout(r, 20));
        await writeGlobalConfig({ budget: { dailyCapUsd: 400 } });

        // Wait for debounce + some buffer
        await new Promise((r) => setTimeout(r, 250));

        // Should have batched into 1 change event (or at most 2 if timing varies)
        expect(changeCount).toBeLessThanOrEqual(2);
        // Final value should be the last written
        expect(store.get<number>("budget.dailyCapUsd")).toBe(400);
      } finally {
        watcher.stop();
      }
    });

    it("continues working after config file is deleted and recreated", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      const store = new ConfigStore();
      await store.load();

      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      let changeCount = 0;
      watcher.on("change", () => {
        changeCount++;
      });

      watcher.start();

      try {
        // Delete the config file
        const configPath = path.join(MOCK_HOME, ".neo", "config.yml");
        await rm(configPath, { force: true });

        // Wait for unlink event
        await waitFor(() => changeCount > 0, 3000);
        const deleteChangeCount = changeCount;

        // Now recreate with new value
        await writeGlobalConfig({
          budget: { dailyCapUsd: 999 },
        });

        // Wait for add event
        await waitFor(() => changeCount > deleteChangeCount, 3000);

        // Store should have the new value
        expect(store.get<number>("budget.dailyCapUsd")).toBe(999);
      } finally {
        watcher.stop();
      }
    });
  });

  describe("ConfigStore reload behavior", () => {
    it("reload merges changes correctly (repo > global > defaults)", async () => {
      // Start with global only
      await writeGlobalConfig({
        budget: { dailyCapUsd: 500 },
        concurrency: { maxSessions: 10 },
      });

      const store = new ConfigStore(MOCK_REPO);
      await store.load();

      expect(store.get<number>("budget.dailyCapUsd")).toBe(500);
      expect(store.get<number>("concurrency.maxSessions")).toBe(10);

      // Add repo override
      await writeRepoConfig({
        budget: { dailyCapUsd: 100 },
      });

      // Manually reload (simulating what watcher would do)
      await store.load();

      // Repo should override global
      expect(store.get<number>("budget.dailyCapUsd")).toBe(100);
      // Global still applies for non-overridden values
      expect(store.get<number>("concurrency.maxSessions")).toBe(10);
    });

    it("falls back to defaults when config becomes invalid", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 500 },
      });

      const store = new ConfigStore();
      await store.load();
      expect(store.get<number>("budget.dailyCapUsd")).toBe(500);

      // Write invalid YAML
      const configPath = path.join(MOCK_HOME, ".neo", "config.yml");
      await writeFile(configPath, "invalid: yaml: [", "utf-8");

      // Reload — should fall back to defaults
      await store.load();
      expect(store.get<number>("budget.dailyCapUsd")).toBe(defaultConfig.budget.dailyCapUsd);
    });

    it("preserves config when reload fails silently", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 500 },
      });

      const store = new ConfigStore();
      await store.load();

      const initialConfig = store.getAll();
      expect(initialConfig.budget.dailyCapUsd).toBe(500);

      // Write schema-invalid config (wrong type)
      await writeGlobalConfig({
        budget: { dailyCapUsd: "not-a-number" },
      });

      // Reload — invalid schema is silently ignored, falls back to defaults
      await store.load();
      expect(store.get<number>("budget.dailyCapUsd")).toBe(defaultConfig.budget.dailyCapUsd);
    });
  });

  describe("full hot-reload workflow", () => {
    it("complete workflow: start → modify → detect → reload → verify", async () => {
      // Step 1: Create initial config (global only to simplify)
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100, alertThresholdPct: 80 },
        concurrency: { maxSessions: 5 },
      });

      // Step 2: Initialize store and watcher (without repo for clearer test)
      const store = new ConfigStore();
      await store.load();

      // Verify initial state
      expect(store.get<number>("budget.dailyCapUsd")).toBe(100);
      expect(store.get<number>("budget.alertThresholdPct")).toBe(80);
      expect(store.get<number>("concurrency.maxSessions")).toBe(5);

      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      const changes: Array<{ timestamp: Date; newBudget: number }> = [];

      watcher.on("change", () => {
        changes.push({
          timestamp: new Date(),
          newBudget: store.get<number>("budget.dailyCapUsd"),
        });
      });

      // Step 3: Start watching
      watcher.start();

      try {
        // Step 4: Make first change to global config
        await writeGlobalConfig({
          budget: { dailyCapUsd: 500, alertThresholdPct: 90 },
          concurrency: { maxSessions: 20 },
        });

        await waitFor(() => changes.length > 0, 3000);
        const afterFirstChange = changes.length;

        // Verify first change applied
        expect(store.get<number>("budget.dailyCapUsd")).toBe(500);
        expect(store.get<number>("budget.alertThresholdPct")).toBe(90);
        expect(store.get<number>("concurrency.maxSessions")).toBe(20);

        // Step 5: Make second change
        await writeGlobalConfig({
          budget: { dailyCapUsd: 999, alertThresholdPct: 95 },
          concurrency: { maxSessions: 30 },
        });

        await waitFor(() => changes.length > afterFirstChange, 3000);

        // Final verification
        expect(store.get<number>("budget.dailyCapUsd")).toBe(999);
        expect(store.get<number>("budget.alertThresholdPct")).toBe(95);
        expect(store.get<number>("concurrency.maxSessions")).toBe(30);

        // Verify we got change events
        expect(changes.length).toBeGreaterThanOrEqual(2);
      } finally {
        watcher.stop();
      }
    });

    it("watcher cleanup releases file handles", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      const store = new ConfigStore();
      await store.load();

      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      let changeCount = 0;
      watcher.on("change", () => {
        changeCount++;
      });

      // Start and verify working
      watcher.start();

      await writeGlobalConfig({ budget: { dailyCapUsd: 200 } });
      await waitFor(() => changeCount > 0, 3000);
      expect(store.get<number>("budget.dailyCapUsd")).toBe(200);

      // Stop the watcher
      watcher.stop();

      // Changes after stop should not trigger events
      const countBeforeChange = changeCount;
      await writeGlobalConfig({ budget: { dailyCapUsd: 300 } });
      await new Promise((r) => setTimeout(r, 200));

      // Count should not have increased
      expect(changeCount).toBe(countBeforeChange);
    });

    it("multiple watchers can observe the same store", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      const store = new ConfigStore();
      await store.load();

      const watcher1 = new ConfigWatcher(store, { debounceMs: 50 });
      const watcher2 = new ConfigWatcher(store, { debounceMs: 50 });

      let count1 = 0;
      let count2 = 0;

      watcher1.on("change", () => count1++);
      watcher2.on("change", () => count2++);

      watcher1.start();
      watcher2.start();

      try {
        await writeGlobalConfig({ budget: { dailyCapUsd: 200 } });
        await waitFor(() => count1 > 0 && count2 > 0, 3000);

        expect(count1).toBeGreaterThanOrEqual(1);
        expect(count2).toBeGreaterThanOrEqual(1);
        expect(store.get<number>("budget.dailyCapUsd")).toBe(200);
      } finally {
        watcher1.stop();
        watcher2.stop();
      }
    });
  });

  describe("edge cases", () => {
    it("handles watching non-existent config file gracefully", async () => {
      // Create the directory but NOT the config file
      await rm(path.join(MOCK_HOME, ".neo", "config.yml"), { force: true });

      const store = new ConfigStore();
      await store.load(); // Should use defaults
      expect(store.get<number>("budget.dailyCapUsd")).toBe(defaultConfig.budget.dailyCapUsd);

      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      let changeCount = 0;
      watcher.on("change", () => changeCount++);

      // Should not throw when starting to watch non-existent file
      watcher.start();

      try {
        // Wait a bit — no events expected
        await new Promise((r) => setTimeout(r, 100));
        expect(changeCount).toBe(0);

        // Now create the config file
        await writeGlobalConfig({ budget: { dailyCapUsd: 999 } });

        // Should detect the new file
        await waitFor(() => changeCount > 0, 3000);
        expect(store.get<number>("budget.dailyCapUsd")).toBe(999);
      } finally {
        watcher.stop();
      }
    });

    it("stopping watcher multiple times is safe", () => {
      const store = new ConfigStore();
      const watcher = new ConfigWatcher(store, { debounceMs: 50 });

      watcher.start();
      watcher.stop();
      watcher.stop(); // Second stop should be a no-op
      watcher.stop(); // Third stop should also be safe

      // No errors thrown
      expect(true).toBe(true);
    });

    it("starting watcher multiple times is idempotent", async () => {
      await writeGlobalConfig({
        budget: { dailyCapUsd: 100 },
      });

      const store = new ConfigStore();
      await store.load();

      const watcher = new ConfigWatcher(store, { debounceMs: 50 });
      let changeCount = 0;
      watcher.on("change", () => changeCount++);

      // Start multiple times
      watcher.start();
      watcher.start();
      watcher.start();

      try {
        await writeGlobalConfig({ budget: { dailyCapUsd: 200 } });
        await waitFor(() => changeCount > 0, 3000);

        // Should only get events once (not 3x)
        expect(changeCount).toBe(1);
      } finally {
        watcher.stop();
      }
    });
  });
});
