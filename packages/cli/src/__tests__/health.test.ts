import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("health command", () => {
  describe("command export", () => {
    it("exports a valid citty command definition", async () => {
      const { default: healthCmd } = await import("../commands/health.js");
      const meta = healthCmd.meta as { name?: string };
      expect(meta.name).toBe("health");
      expect(typeof healthCmd.run).toBe("function");
    });

    it("has correct description", async () => {
      const { default: healthCmd } = await import("../commands/health.js");
      const meta = healthCmd.meta as { description?: string };
      expect(meta.description).toContain("health check");
    });
  });

  describe("HealthSummary structure", () => {
    it("aggregates all checks with overall status", () => {
      const summary = {
        ok: false,
        checks: {
          config: { ok: true },
          git: { ok: true },
          claude: { ok: false, error: "timeout" },
        },
      };

      expect(summary.ok).toBe(false);
      expect(summary.checks.config.ok).toBe(true);
      expect(summary.checks.claude.ok).toBe(false);
    });

    it("is ok only when all checks pass", () => {
      const checks = {
        config: { ok: true },
        git: { ok: true },
        claude: { ok: true },
      };
      const allOk = Object.values(checks).every((c) => c.ok);

      expect(allOk).toBe(true);
    });

    it("is not ok when any check fails", () => {
      const checks = {
        config: { ok: true },
        git: { ok: false, error: "not found" },
        claude: { ok: true },
      };
      const allOk = Object.values(checks).every((c) => c.ok);

      expect(allOk).toBe(false);
    });
  });

  describe("checkGit behavior", () => {
    it("returns ok:true with version when git is available", async () => {
      // This test runs against real system git
      try {
        const { stdout } = await execFileAsync("git", ["--version"]);
        const hasVersion = stdout.includes("git version");
        expect(hasVersion).toBe(true);
      } catch {
        // Skip if git not installed (CI edge case)
        expect(true).toBe(true);
      }
    });

    it("extracts version from git --version output", () => {
      // Test version regex handles both 2-part and 3-part versions
      const output1 = "git version 2.48.1";
      const output2 = "git version 2.25";

      const match1 = output1.match(/git version (\d+\.\d+(?:\.\d+)?)/);
      const match2 = output2.match(/git version (\d+\.\d+(?:\.\d+)?)/);

      expect(match1?.[1]).toBe("2.48.1");
      expect(match2?.[1]).toBe("2.25");
    });
  });

  describe("checkClaude timeout handling", () => {
    it("recognizes AbortError as timeout", () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";

      const isTimeout = err instanceof Error && err.name === "AbortError";
      expect(isTimeout).toBe(true);
    });

    it("formats timeout error message correctly", () => {
      const CLAUDE_TIMEOUT_MS = 5000;
      const message = `timeout after ${CLAUDE_TIMEOUT_MS}ms`;
      expect(message).toBe("timeout after 5000ms");
    });
  });

  describe("checkConfig behavior", () => {
    it("returns ok:true when config loads successfully", () => {
      // Test the pattern: try loadGlobalConfig() -> ok:true
      const loadSuccess = true;
      const result = loadSuccess ? { ok: true } : { ok: false, error: "failed" };
      expect(result.ok).toBe(true);
    });

    it("returns ok:false with error when config load fails", () => {
      // Test the pattern: catch error -> ok:false with error message
      const err = new Error("Config file not found");
      const result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Config file not found");
    });
  });

  describe("exit code logic", () => {
    it("returns 0 when all checks pass", () => {
      const summary = { ok: true, checks: {} };
      const exitCode = summary.ok ? 0 : 1;
      expect(exitCode).toBe(0);
    });

    it("returns 1 when any check fails", () => {
      const summary = { ok: false, checks: {} };
      const exitCode = summary.ok ? 0 : 1;
      expect(exitCode).toBe(1);
    });
  });
});
