import { describe, expect, it } from "vitest";
import { parseConfigWithWarnings, parseRepoConfigWithWarnings } from "../parser";

describe("parseConfigWithWarnings", () => {
  describe("unknown keys", () => {
    it("warns about unknown top-level keys", () => {
      const input = {
        repos: [],
        unknownKey: "value",
        anotherUnknown: 123,
      };

      const result = parseConfigWithWarnings(input);

      expect(result.config.repos).toEqual([]);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toEqual({
        type: "unknown_key",
        path: "unknownKey",
        message: "Unknown configuration key 'unknownKey'",
      });
      expect(result.warnings[1]).toEqual({
        type: "unknown_key",
        path: "anotherUnknown",
        message: "Unknown configuration key 'anotherUnknown'",
      });
    });

    it("warns about unknown nested keys", () => {
      const input = {
        repos: [],
        concurrency: {
          maxSessions: 10,
          unknownConcurrencyKey: true,
        },
      };

      const result = parseConfigWithWarnings(input);

      expect(result.config.concurrency.maxSessions).toBe(10);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toEqual({
        type: "unknown_key",
        path: "concurrency.unknownConcurrencyKey",
        message: "Unknown configuration key 'concurrency.unknownConcurrencyKey'",
      });
    });

    it("warns about deeply nested unknown keys", () => {
      const input = {
        repos: [],
        supervisor: {
          port: 8080,
          unknownSupervisorKey: "value",
        },
      };

      const result = parseConfigWithWarnings(input);

      expect(result.config.supervisor.port).toBe(8080);
      const unknownWarning = result.warnings.find(
        (w) => w.path === "supervisor.unknownSupervisorKey",
      );
      expect(unknownWarning).toBeDefined();
      expect(unknownWarning?.type).toBe("unknown_key");
    });
  });

  describe("valid config", () => {
    it("returns empty warnings for valid config", () => {
      const input = {
        repos: [{ path: "/test/repo" }],
        concurrency: {
          maxSessions: 10,
          maxPerRepo: 5,
          queueMax: 100,
        },
      };

      const result = parseConfigWithWarnings(input);

      expect(result.warnings).toHaveLength(0);
      expect(result.config.repos).toHaveLength(1);
      expect(result.config.concurrency.maxSessions).toBe(10);
    });

    it("applies defaults for missing fields", () => {
      const input = {
        repos: [],
      };

      const result = parseConfigWithWarnings(input);

      expect(result.warnings).toHaveLength(0);
      expect(result.config.concurrency.maxSessions).toBe(5);
      expect(result.config.budget.dailyCapUsd).toBe(500);
    });
  });

  describe("validation errors", () => {
    it("throws for invalid repo config", () => {
      const input = {
        repos: [{ name: "missing-path" }],
      };

      expect(() => parseConfigWithWarnings(input)).toThrow();
    });
  });

  describe("parsing behavior", () => {
    it("does not fail on warnings - only informs", () => {
      const input = {
        repos: [{ path: "/valid/path" }],
        unknownKey: "ignored",
        concurrency: {
          maxSessions: 5,
          extraKey: "also ignored",
        },
      };

      const result = parseConfigWithWarnings(input);

      // Config is valid and parsed
      expect(result.config.repos[0]?.path).toBe("/valid/path");
      // Warnings are collected
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.path === "unknownKey")).toBe(true);
    });
  });
});

describe("parseRepoConfigWithWarnings", () => {
  it("warns about unknown keys in repo override config", () => {
    const input = {
      concurrency: { maxSessions: 10 },
      unknownRepoKey: "value",
    };

    const result = parseRepoConfigWithWarnings(input);

    expect(result.config.concurrency?.maxSessions).toBe(10);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({
      type: "unknown_key",
      path: "unknownRepoKey",
      message: "Unknown configuration key 'unknownRepoKey'",
    });
  });

  it("returns empty warnings for valid repo config", () => {
    const input = {
      budget: { dailyCapUsd: 100 },
      recovery: { maxRetries: 5 },
    };

    const result = parseRepoConfigWithWarnings(input);

    expect(result.warnings).toHaveLength(0);
    expect(result.config.budget?.dailyCapUsd).toBe(100);
    expect(result.config.recovery?.maxRetries).toBe(5);
  });
});
