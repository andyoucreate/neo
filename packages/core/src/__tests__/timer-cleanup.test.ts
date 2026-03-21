import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "@/config";
import { ConfigWatcher } from "@/config/ConfigWatcher";
import { auditLog } from "@/middleware/audit-log";
import { ShutdownManager } from "@/supervisor/shutdown";
import type { MiddlewareContext, MiddlewareEvent } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_timer_cleanup_test__");

// ─── Test Helpers ───────────────────────────────────────

function makeContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    runId: "run-1",
    step: "step-1",
    agent: "test-agent",
    repo: "/tmp/repo",
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<MiddlewareEvent>): MiddlewareEvent {
  return {
    hookEvent: "PostToolUse",
    sessionId: "session-1",
    toolName: "TestTool",
    input: { test: "data" },
    output: "ok",
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  vi.useFakeTimers();
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── AuditLog Timer Cleanup Tests ──────────────────────

describe("AuditLog timer cleanup", () => {
  it("clears timer on shutdown when registered with ShutdownManager", async () => {
    const auditDir = path.join(TMP_DIR, "audit");
    const shutdownManager = new ShutdownManager({ timeoutMs: 1000 });

    const middleware = auditLog({
      dir: auditDir,
      flushIntervalMs: 500,
      shutdownManager,
    });

    // Trigger timer creation by calling handler
    await middleware.handler(makeEvent({ sessionId: "test-session" }), makeContext());

    // Fast-forward to ensure timer is created
    await vi.advanceTimersByTimeAsync(100);

    // Get the number of active timers before shutdown
    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    // Trigger shutdown
    await shutdownManager.shutdown();

    // Fast-forward to ensure cleanup completes
    await vi.runAllTimersAsync();

    // Timer should be cleared
    const timersAfter = vi.getTimerCount();
    expect(timersAfter).toBe(0);
  });

  it("works without ShutdownManager (backward compatibility)", async () => {
    const auditDir = path.join(TMP_DIR, "audit-no-manager");

    const middleware = auditLog({
      dir: auditDir,
      flushIntervalMs: 500,
      // No shutdownManager provided
    });

    // Should not throw
    await middleware.handler(makeEvent({ sessionId: "test-session" }), makeContext());

    await vi.advanceTimersByTimeAsync(100);

    // Manual cleanup via flush should still work
    await middleware.flush();
    await vi.runAllTimersAsync();
  });

  it("prevents timer leak when middleware is garbage collected", async () => {
    const auditDir = path.join(TMP_DIR, "audit-gc");
    const shutdownManager = new ShutdownManager({ timeoutMs: 1000 });

    // Create middleware in a scope
    {
      const middleware = auditLog({
        dir: auditDir,
        flushIntervalMs: 500,
        shutdownManager,
      });

      await middleware.handler(makeEvent({ sessionId: "test-session" }), makeContext());

      await vi.advanceTimersByTimeAsync(100);
    }

    // Middleware goes out of scope, but timer is still active
    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    // ShutdownManager cleanup should clear the timer even if middleware is GC'd
    await shutdownManager.shutdown();
    await vi.runAllTimersAsync();

    const timersAfter = vi.getTimerCount();
    expect(timersAfter).toBe(0);
  });
});

// ─── ConfigWatcher Timer Cleanup Tests ─────────────────

describe("ConfigWatcher timer cleanup", () => {
  it("clears timer on shutdown when registered with ShutdownManager", async () => {
    const repoPath = path.join(TMP_DIR, "test-repo");
    await mkdir(repoPath, { recursive: true });

    const store = new ConfigStore(repoPath);
    await store.load();

    const shutdownManager = new ShutdownManager({ timeoutMs: 1000 });

    const watcher = new ConfigWatcher(store, {
      debounceMs: 300,
      shutdownManager,
    });

    watcher.start();

    // Simulate a config change to trigger debounce timer
    const configPath = path.join(repoPath, ".neo", "config.yml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "test: value\n", "utf-8");

    // Manually trigger the change handler (since we can't easily trigger fs watcher in tests)
    // @ts-expect-error -- accessing private method for testing
    watcher.handleChange();

    await vi.advanceTimersByTimeAsync(100);

    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    // Trigger shutdown
    await shutdownManager.shutdown();
    await vi.runAllTimersAsync();

    // Timer should be cleared
    const timersAfter = vi.getTimerCount();
    expect(timersAfter).toBe(0);
  });

  it("works without ShutdownManager (backward compatibility)", async () => {
    const repoPath = path.join(TMP_DIR, "test-repo-no-manager");
    await mkdir(repoPath, { recursive: true });

    const store = new ConfigStore(repoPath);
    await store.load();

    const watcher = new ConfigWatcher(store, {
      debounceMs: 300,
      // No shutdownManager provided
    });

    watcher.start();

    // Should not throw
    // @ts-expect-error -- accessing private method for testing
    watcher.handleChange();

    await vi.advanceTimersByTimeAsync(100);

    // Manual cleanup via stop should still work
    watcher.stop();
    await vi.runAllTimersAsync();
  });

  it("prevents timer leak when watcher is garbage collected", async () => {
    const repoPath = path.join(TMP_DIR, "test-repo-gc");
    await mkdir(repoPath, { recursive: true });

    const store = new ConfigStore(repoPath);
    await store.load();

    const shutdownManager = new ShutdownManager({ timeoutMs: 1000 });

    // Create watcher in a scope
    {
      const watcher = new ConfigWatcher(store, {
        debounceMs: 300,
        shutdownManager,
      });

      watcher.start();

      // Trigger debounce timer
      // @ts-expect-error -- accessing private method for testing
      watcher.handleChange();

      await vi.advanceTimersByTimeAsync(100);
    }

    // Watcher goes out of scope, but timer is still active
    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    // ShutdownManager cleanup should clear the timer even if watcher is GC'd
    await shutdownManager.shutdown();
    await vi.runAllTimersAsync();

    const timersAfter = vi.getTimerCount();
    expect(timersAfter).toBe(0);
  });

  it("calling stop() multiple times is safe", async () => {
    const repoPath = path.join(TMP_DIR, "test-repo-multi-stop");
    await mkdir(repoPath, { recursive: true });

    const store = new ConfigStore(repoPath);
    await store.load();

    const watcher = new ConfigWatcher(store, { debounceMs: 300 });
    watcher.start();

    watcher.stop();
    watcher.stop(); // Should not throw
    watcher.stop(); // Should not throw

    await vi.runAllTimersAsync();
  });
});
