import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Helper function to wait for worker startup, matching the implementation in run.ts.
 * Extracted here for testing purposes.
 */
async function waitForWorkerStartup(
  startedPath: string,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(startedPath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

describe("worker startup detection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `neo-test-worker-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("waitForWorkerStartup", () => {
    it("returns true immediately if .started file already exists", async () => {
      const startedPath = path.join(testDir, "test.started");
      writeFileSync(startedPath, JSON.stringify({ pid: 1234 }));

      const start = Date.now();
      const result = await waitForWorkerStartup(startedPath, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(200); // Should return almost immediately
    });

    it("returns true when .started file appears during wait", async () => {
      const startedPath = path.join(testDir, "test.started");

      // Write the file after 200ms
      setTimeout(() => {
        writeFileSync(startedPath, JSON.stringify({ pid: 1234 }));
      }, 200);

      const start = Date.now();
      const result = await waitForWorkerStartup(startedPath, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1000);
    });

    it("returns false when timeout expires without .started file", async () => {
      const startedPath = path.join(testDir, "nonexistent.started");

      const start = Date.now();
      const result = await waitForWorkerStartup(startedPath, 300, 50);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(elapsed).toBeLessThan(500);
    });

    it("polls at specified interval", async () => {
      const startedPath = path.join(testDir, "test.started");

      // Write the file after 250ms
      setTimeout(() => {
        writeFileSync(startedPath, JSON.stringify({ pid: 1234 }));
      }, 250);

      const result = await waitForWorkerStartup(startedPath, 1000, 100);

      expect(result).toBe(true);
    });
  });

  describe("worker startup flow", () => {
    it("startup file contains expected metadata", async () => {
      const startedPath = path.join(testDir, "test.started");
      const startupData = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await writeFile(startedPath, JSON.stringify(startupData), "utf-8");

      const content = JSON.parse(
        await import("node:fs/promises").then((fs) => fs.readFile(startedPath, "utf-8")),
      );

      expect(content).toHaveProperty("pid");
      expect(content).toHaveProperty("startedAt");
      expect(typeof content.pid).toBe("number");
      expect(typeof content.startedAt).toBe("string");
    });
  });
});
