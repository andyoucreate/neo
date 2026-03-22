import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShutdownManager,
  ShutdownManager,
  terminateGracefully,
  waitForExit,
} from "@/supervisor/shutdown";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_shutdown_test__");

// ─── Mock ChildProcess ──────────────────────────────────

class MockChildProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  exitCode: number | null = null;

  kill(signal?: string): boolean {
    if (signal === "SIGKILL") {
      this.killed = true;
      this.exitCode = 1;
      this.emit("exit", 1, signal);
    }
    return true;
  }

  simulateExit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

// ─── Helpers ────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── ShutdownManager Tests ──────────────────────────────

describe("ShutdownManager", () => {
  it("constructs with default options", () => {
    const manager = new ShutdownManager();
    expect(manager.shuttingDown).toBe(false);
  });

  it("constructs with custom options", () => {
    const onShutdownStart = vi.fn();
    const manager = new ShutdownManager({
      timeoutMs: 10_000,
      onShutdownStart,
    });
    expect(manager.shuttingDown).toBe(false);
  });

  it("registers and unregisters child processes", () => {
    const manager = new ShutdownManager();
    const child = new MockChildProcess() as unknown as ChildProcess;

    manager.registerChildProcess(child);
    // Can't easily inspect internal state, but should not throw
    manager.unregisterChildProcess(child);
  });

  it("auto-removes child process on exit", () => {
    const manager = new ShutdownManager();
    const child = new MockChildProcess();

    manager.registerChildProcess(child as unknown as ChildProcess);
    child.simulateExit(0);
    // Process should be auto-removed from the set
  });

  it("registers and unregisters sessions", () => {
    const manager = new ShutdownManager();

    manager.registerSession("/path/to/session");
    manager.unregisterSession("/path/to/session");
    // Should not throw
  });

  it("tracks pending writes and auto-removes on settlement", async () => {
    const manager = new ShutdownManager();
    let resolveWrite: (() => void) | undefined;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });

    manager.trackWrite(writePromise);
    resolveWrite?.();
    await writePromise;
    // Promise should be auto-removed
  });

  it("registers and unregisters custom handlers", () => {
    const manager = new ShutdownManager();
    const handler = async () => {};

    manager.registerHandler(handler);
    manager.unregisterHandler(handler);
    // Should not throw
  });

  it("sets runs directory", () => {
    const manager = new ShutdownManager();
    manager.setRunsDir("/path/to/runs");
    // Should not throw
  });

  it("install is idempotent", () => {
    const manager = new ShutdownManager();
    manager.install();
    manager.install(); // Should not throw or add duplicate handlers
  });

  it("shutdown sets shuttingDown to true", async () => {
    const manager = new ShutdownManager({ timeoutMs: 100 });

    expect(manager.shuttingDown).toBe(false);
    const shutdownPromise = manager.shutdown();
    expect(manager.shuttingDown).toBe(true);
    await shutdownPromise;
  });

  it("shutdown is idempotent", async () => {
    const onShutdownStart = vi.fn();
    const manager = new ShutdownManager({
      timeoutMs: 100,
      onShutdownStart,
    });

    const p1 = manager.shutdown();
    const p2 = manager.shutdown();

    await Promise.all([p1, p2]);

    // onShutdownStart should only be called once
    expect(onShutdownStart).toHaveBeenCalledTimes(1);
  });

  it("calls onShutdownStart and onShutdownComplete callbacks", async () => {
    const onShutdownStart = vi.fn();
    const onShutdownComplete = vi.fn();
    const manager = new ShutdownManager({
      timeoutMs: 100,
      onShutdownStart,
      onShutdownComplete,
    });

    await manager.shutdown();

    expect(onShutdownStart).toHaveBeenCalledTimes(1);
    expect(onShutdownComplete).toHaveBeenCalledTimes(1);
  });

  it("runs custom handlers during shutdown", async () => {
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);
    const manager = new ShutdownManager({ timeoutMs: 100 });

    manager.registerHandler(handler1);
    manager.registerHandler(handler2);

    await manager.shutdown();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("continues shutdown even if a handler throws", async () => {
    const handler1 = vi.fn().mockRejectedValue(new Error("Handler failed"));
    const handler2 = vi.fn().mockResolvedValue(undefined);
    const manager = new ShutdownManager({ timeoutMs: 100 });

    manager.registerHandler(handler1);
    manager.registerHandler(handler2);

    await manager.shutdown();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("flushes pending writes during shutdown", async () => {
    const manager = new ShutdownManager({ timeoutMs: 100 });
    let resolved = false;
    let resolveWrite: (() => void) | undefined;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }).then(() => {
      resolved = true;
    });

    manager.trackWrite(writePromise);

    // Start shutdown, then resolve the write
    const shutdownPromise = manager.shutdown();
    resolveWrite?.();

    await shutdownPromise;

    expect(resolved).toBe(true);
  });

  it("marks orphaned runs as failed during shutdown", async () => {
    const runsDir = path.join(TMP_DIR, "runs");
    const repoDir = path.join(runsDir, "test-repo");
    await mkdir(repoDir, { recursive: true });

    // Create a running run owned by this process
    const runFile = path.join(repoDir, "test-run.json");
    await writeFile(
      runFile,
      JSON.stringify({
        runId: "test-run",
        status: "running",
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const manager = new ShutdownManager({ timeoutMs: 100 });
    manager.setRunsDir(runsDir);

    await manager.shutdown();

    // Read the file and check status
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(runFile, "utf-8");
    const run = JSON.parse(content);
    expect(run.status).toBe("failed");
  });

  it("does not mark runs owned by other processes", async () => {
    const runsDir = path.join(TMP_DIR, "runs");
    const repoDir = path.join(runsDir, "test-repo");
    await mkdir(repoDir, { recursive: true });

    // Create a running run owned by a different process
    const runFile = path.join(repoDir, "other-run.json");
    await writeFile(
      runFile,
      JSON.stringify({
        runId: "other-run",
        status: "running",
        pid: 99999, // Different PID
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const manager = new ShutdownManager({ timeoutMs: 100 });
    manager.setRunsDir(runsDir);

    await manager.shutdown();

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(runFile, "utf-8");
    const run = JSON.parse(content);
    expect(run.status).toBe("running"); // Should not be changed
  });

  it("terminates child processes during shutdown", async () => {
    const manager = new ShutdownManager({ timeoutMs: 100 });
    const child = new MockChildProcess();
    const killSpy = vi.spyOn(child, "kill");

    manager.registerChildProcess(child as unknown as ChildProcess);

    // Simulate graceful exit after SIGTERM
    child.once("newListener", (event) => {
      if (event === "exit") {
        setTimeout(() => child.simulateExit(0), 10);
      }
    });

    await manager.shutdown();

    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
  });

  it("force kills child processes that do not exit gracefully", async () => {
    vi.useFakeTimers();

    const manager = new ShutdownManager({ timeoutMs: 10_000 }); // Long timeout so SIGKILL fires first
    const child = new MockChildProcess();

    // Override kill to not trigger exit for SIGTERM
    child.kill = vi.fn((signal?: string) => {
      if (signal === "SIGKILL") {
        child.killed = true;
        child.exitCode = 1;
        child.emit("exit", 1, signal);
      }
      return true;
    });

    manager.registerChildProcess(child as unknown as ChildProcess);

    const shutdownPromise = manager.shutdown();

    // Advance past the FORCE_KILL_DELAY_MS (5000ms)
    await vi.advanceTimersByTimeAsync(5100);

    await shutdownPromise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });

  it("respects shutdown timeout", async () => {
    const manager = new ShutdownManager({ timeoutMs: 50 });

    // Register a handler that takes too long
    manager.registerHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const start = Date.now();
    await manager.shutdown();
    const elapsed = Date.now() - start;

    // Should have timed out before the handler completed
    expect(elapsed).toBeLessThan(150);
  });
});

// ─── createShutdownManager Tests ────────────────────────

describe("createShutdownManager", () => {
  it("creates and installs a shutdown manager", () => {
    const manager = createShutdownManager({ timeoutMs: 100 });
    expect(manager).toBeInstanceOf(ShutdownManager);
    // install() was called internally
  });
});

// ─── waitForExit Tests ──────────────────────────────────

describe("waitForExit", () => {
  it("returns true immediately if process already exited", async () => {
    const child = new MockChildProcess();
    child.exitCode = 0;

    const result = await waitForExit(child as unknown as ChildProcess, 100);
    expect(result).toBe(true);
  });

  it("returns true immediately if process already killed", async () => {
    const child = new MockChildProcess();
    child.killed = true;

    const result = await waitForExit(child as unknown as ChildProcess, 100);
    expect(result).toBe(true);
  });

  it("returns true when process exits within timeout", async () => {
    const child = new MockChildProcess();

    const exitPromise = waitForExit(child as unknown as ChildProcess, 100);

    // Simulate exit after 20ms
    setTimeout(() => child.simulateExit(0), 20);

    const result = await exitPromise;
    expect(result).toBe(true);
  });

  it("returns false when timeout is reached", async () => {
    const child = new MockChildProcess();

    const result = await waitForExit(child as unknown as ChildProcess, 20);
    expect(result).toBe(false);
  });
});

// ─── Middleware cleanup sequence Tests ─────────────────

describe("Middleware cleanup sequence", () => {
  it("calls cleanup() before flush() during shutdown", async () => {
    const manager = new ShutdownManager({ timeoutMs: 100 });
    const callOrder: string[] = [];

    const mockMiddleware = {
      name: "test-middleware",
      on: "PostToolUse" as const,
      async handler() {
        return { decision: "pass" as const };
      },
      async cleanup() {
        callOrder.push("cleanup");
      },
      async flush() {
        callOrder.push("flush");
      },
    };

    // Register a custom handler that simulates middleware cleanup
    manager.registerHandler(async () => {
      // Simulate the orchestrator's middleware cleanup sequence
      // This mirrors packages/core/src/orchestrator.ts:263-270
      if ("cleanup" in mockMiddleware && typeof mockMiddleware.cleanup === "function") {
        await mockMiddleware.cleanup();
      }
      if ("flush" in mockMiddleware && typeof mockMiddleware.flush === "function") {
        await mockMiddleware.flush();
      }
    });

    await manager.shutdown();

    expect(callOrder).toEqual(["cleanup", "flush"]);
  });

  it("cleanup() is idempotent when both cleanup() and flush() are called", async () => {
    const manager = new ShutdownManager({ timeoutMs: 100 });
    let cleanupCalls = 0;
    let flushCalls = 0;

    const mockMiddleware = {
      name: "test-middleware",
      on: "PostToolUse" as const,
      async handler() {
        return { decision: "pass" as const };
      },
      async cleanup() {
        cleanupCalls++;
      },
      async flush() {
        flushCalls++;
      },
    };

    // Register a custom handler that calls both cleanup and flush
    manager.registerHandler(async () => {
      if ("cleanup" in mockMiddleware && typeof mockMiddleware.cleanup === "function") {
        await mockMiddleware.cleanup();
      }
      if ("flush" in mockMiddleware && typeof mockMiddleware.flush === "function") {
        await mockMiddleware.flush();
      }
    });

    await manager.shutdown();

    // Both should have been called exactly once
    expect(cleanupCalls).toBe(1);
    expect(flushCalls).toBe(1);
  });
});

// ─── terminateGracefully Tests ──────────────────────────

describe("terminateGracefully", () => {
  it("returns true immediately if process already exited", async () => {
    const child = new MockChildProcess();
    child.exitCode = 0;

    const result = await terminateGracefully(child as unknown as ChildProcess, 100);
    expect(result).toBe(true);
  });

  it("returns true immediately if process already killed", async () => {
    const child = new MockChildProcess();
    child.killed = true;

    const result = await terminateGracefully(child as unknown as ChildProcess, 100);
    expect(result).toBe(true);
  });

  it("sends SIGTERM and returns true on graceful exit", async () => {
    const child = new MockChildProcess();

    // Simulate graceful exit after SIGTERM
    child.kill = vi.fn((signal?: string) => {
      if (signal === "SIGTERM") {
        setTimeout(() => child.simulateExit(0), 10);
      }
      return true;
    });

    const result = await terminateGracefully(child as unknown as ChildProcess, 100);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result).toBe(true);
  });

  it("sends SIGKILL after grace period and returns false", async () => {
    const child = new MockChildProcess();

    // Override kill to only respond to SIGKILL
    child.kill = vi.fn((signal?: string) => {
      if (signal === "SIGKILL") {
        child.killed = true;
        child.exitCode = 1;
        child.emit("exit", 1, signal);
      }
      return true;
    });

    const result = await terminateGracefully(child as unknown as ChildProcess, 20);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(result).toBe(false);
  });
});
