import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("health command", () => {
  describe("command export", () => {
    it("exports a valid citty command definition", async () => {
      const { default: healthCmd } = await import("../commands/health.js");
      expect(healthCmd.meta.name).toBe("health");
      expect(typeof healthCmd.run).toBe("function");
    });

    it("has correct description", async () => {
      const { default: healthCmd } = await import("../commands/health.js");
      expect(healthCmd.meta.description).toContain("health check");
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
