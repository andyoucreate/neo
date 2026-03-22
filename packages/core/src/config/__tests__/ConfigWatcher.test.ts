import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "../ConfigStore";
import { ConfigWatcher } from "../ConfigWatcher";

// Mock chokidar
vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Mock ConfigStore ────────────────────────────────────

class MockConfigStore extends EventEmitter {
  private repoPath: string | undefined;

  constructor(repoPath?: string) {
    super();
    this.repoPath = repoPath;
  }

  getRepoPath(): string | undefined {
    return this.repoPath;
  }

  async load(): Promise<void> {
    // Mock implementation
  }
}

// ─── Tests ───────────────────────────────────────────────

describe("ConfigWatcher", () => {
  let store: ConfigStore;
  let originalSetTimeout: typeof setTimeout;

  beforeEach(() => {
    store = new MockConfigStore() as unknown as ConfigStore;
    // Capture original setTimeout to restore later
    originalSetTimeout = globalThis.setTimeout;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original setTimeout
    globalThis.setTimeout = originalSetTimeout;
  });

  describe("timer cleanup", () => {
    it("calls unref() on debounce timer to prevent process hanging", () => {
      // Mock setTimeout to track if unref was called
      const mockTimer = {
        unref: vi.fn(),
        ref: vi.fn(),
        hasRef: vi.fn().mockReturnValue(true),
        refresh: vi.fn(),
        [Symbol.toPrimitive](): number {
          return 123;
        },
      } as unknown as NodeJS.Timeout;

      const setTimeoutSpy = vi.fn(() => mockTimer);
      globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

      const watcher = new ConfigWatcher(store, { debounceMs: 100 });

      // Access private method through prototype
      // biome-ignore lint/suspicious/noExplicitAny: Testing private method
      const handleChange = (watcher as any).handleChange.bind(watcher);

      // Trigger handleChange
      handleChange();

      // Verify setTimeout was called
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);

      // Verify unref was called on the timer
      expect(mockTimer.unref).toHaveBeenCalledTimes(1);
    });

    it("clears timer on stop()", () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const watcher = new ConfigWatcher(store, { debounceMs: 100 });

      // Trigger a change to create the timer
      // biome-ignore lint/suspicious/noExplicitAny: Testing private method
      const handleChange = (watcher as any).handleChange.bind(watcher);
      handleChange();

      // Stop should clear the timer
      watcher.stop();

      // clearTimeout should have been called in stop()
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    });

    it("handles multiple rapid handleChange calls by clearing previous timer", () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const watcher = new ConfigWatcher(store, { debounceMs: 100 });

      // biome-ignore lint/suspicious/noExplicitAny: Testing private method
      const handleChange = (watcher as any).handleChange.bind(watcher);

      // First call creates timer
      handleChange();

      // Second call should clear previous timer
      handleChange();

      // clearTimeout should have been called once
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

      // Third call should clear again
      handleChange();

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

      watcher.stop();
    });

    it("stop() is safe to call when no timer exists", () => {
      const watcher = new ConfigWatcher(store, { debounceMs: 100 });

      // Stop without starting or triggering changes
      expect(() => watcher.stop()).not.toThrow();

      // Multiple stops should also be safe
      expect(() => watcher.stop()).not.toThrow();
      expect(() => watcher.stop()).not.toThrow();
    });

    it("stop() clears both timer and watcher", () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const watcher = new ConfigWatcher(store, { debounceMs: 100 });
      watcher.start();

      // Trigger a change to create the timer
      // biome-ignore lint/suspicious/noExplicitAny: Testing private method
      const handleChange = (watcher as any).handleChange.bind(watcher);
      handleChange();

      watcher.stop();

      // Verify clearTimeout was called
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe("debounce behavior", () => {
    it("uses default debounce time when not specified", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const watcher = new ConfigWatcher(store);

      // biome-ignore lint/suspicious/noExplicitAny: Testing private method
      const handleChange = (watcher as any).handleChange.bind(watcher);
      handleChange();

      // Default is 500ms
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 500);

      watcher.stop();
    });

    it("uses custom debounce time when specified", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const watcher = new ConfigWatcher(store, { debounceMs: 250 });

      // biome-ignore lint/suspicious/noExplicitAny: Testing private method
      const handleChange = (watcher as any).handleChange.bind(watcher);
      handleChange();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250);

      watcher.stop();
    });
  });
});
