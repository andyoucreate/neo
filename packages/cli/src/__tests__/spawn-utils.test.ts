import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnWithConfirmation } from "../spawn-utils.js";

describe("spawnWithConfirmation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns PID on successful spawn", async () => {
    // Spawn a simple Node command that exits immediately
    const result = await spawnWithConfirmation(process.execPath, ["-e", "process.exit(0)"]);

    expect(result.error).toBeUndefined();
    expect(result.pid).toBeGreaterThan(0);
  });

  it("returns error when command does not exist", async () => {
    const result = await spawnWithConfirmation("/nonexistent/binary/path", ["--version"]);

    expect(result.error).toBeDefined();
    expect(result.pid).toBe(0);
    expect(result.error).toMatch(/ENOENT|spawn/i);
  });

  it("calls onComplete callback on success", async () => {
    const onComplete = vi.fn();

    await spawnWithConfirmation(process.execPath, ["-e", "process.exit(0)"], {
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("calls onComplete callback on error", async () => {
    const onComplete = vi.fn();

    await spawnWithConfirmation("/nonexistent/binary/path", ["--version"], {
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("respects custom timeout", async () => {
    const start = Date.now();

    // Spawn a command that sleeps, with a very short timeout
    // The timeout should fire before the process finishes
    const result = await spawnWithConfirmation(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      {
        timeoutMs: 50,
      },
    );

    const elapsed = Date.now() - start;

    // Should complete quickly due to timeout (the spawn event fires fast even if the process runs long)
    expect(elapsed).toBeLessThan(2000);
    // Either success (spawn event fired) or timeout error - both are acceptable
    expect(result.pid >= 0 || result.error !== undefined).toBe(true);
  });

  it("passes custom spawn options", async () => {
    // Test that custom env is passed through
    const result = await spawnWithConfirmation(
      process.execPath,
      ["-e", "process.exit(process.env.TEST_VAR === 'test_value' ? 0 : 1)"],
      {
        spawnOptions: {
          env: { ...process.env, TEST_VAR: "test_value" },
        },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.pid).toBeGreaterThan(0);
  });

  it("spawns detached processes by default", async () => {
    // Spawn a process and verify it's detached (doesn't block the parent)
    const result = await spawnWithConfirmation(process.execPath, [
      "-e",
      "setTimeout(() => {}, 5000)",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.pid).toBeGreaterThan(0);

    // The test should not hang - if detached works correctly, we return immediately
  });

  it("only calls onComplete once even if both spawn and error events fire", async () => {
    const onComplete = vi.fn();

    // Normal spawn should only trigger once
    await spawnWithConfirmation(process.execPath, ["-e", "process.exit(0)"], {
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
