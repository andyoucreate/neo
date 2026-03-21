import { describe, expect, it } from "vitest";
import {
  collectConfigWarnings,
  DEPRECATED_FIELDS,
  formatConfigWarnings,
  KNOWN_NESTED_FIELDS,
  KNOWN_TOP_LEVEL_FIELDS,
} from "../warnings";

describe("collectConfigWarnings", () => {
  describe("unknown fields", () => {
    it("detects unknown top-level fields", () => {
      const config = {
        repos: [],
        unknownField: "value",
        anotherUnknown: 123,
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "unknownField",
        message: "Unknown config field 'unknownField'",
      });
      expect(warnings[1]).toMatchObject({
        type: "unknown",
        field: "anotherUnknown",
        message: "Unknown config field 'anotherUnknown'",
      });
    });

    it("detects unknown nested fields in concurrency", () => {
      const config = {
        concurrency: {
          maxSessions: 5,
          unknownOption: true,
        },
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "concurrency.unknownOption",
        message: "Unknown config field 'concurrency.unknownOption'",
      });
    });

    it("detects unknown nested fields in budget", () => {
      const config = {
        budget: {
          dailyCapUsd: 500,
          monthlyLimit: 10000,
        },
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "budget.monthlyLimit",
        message: "Unknown config field 'budget.monthlyLimit'",
      });
    });

    it("detects unknown nested fields in supervisor", () => {
      const config = {
        supervisor: {
          port: 7777,
          unknownTimer: 5000,
        },
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "supervisor.unknownTimer",
        message: "Unknown config field 'supervisor.unknownTimer'",
      });
    });

    it("detects unknown fields in repos array entries", () => {
      const config = {
        repos: [
          {
            path: "/my/repo",
            name: "my-repo",
            unknownRepoOption: true,
          },
          {
            path: "/another/repo",
            invalidField: "value",
          },
        ],
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "repos[0].unknownRepoOption",
        message: "Unknown repo config field 'repos[0].unknownRepoOption'",
      });
      expect(warnings[1]).toMatchObject({
        type: "unknown",
        field: "repos[1].invalidField",
        message: "Unknown repo config field 'repos[1].invalidField'",
      });
    });

    it("detects unknown fields in webhooks array entries", () => {
      const config = {
        webhooks: [
          {
            url: "https://example.com/webhook",
            unknownWebhookOption: true,
          },
        ],
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "webhooks[0].unknownWebhookOption",
        message: "Unknown webhook config field 'webhooks[0].unknownWebhookOption'",
      });
    });

    it("detects unknown fields in mcpServers entries", () => {
      const config = {
        mcpServers: {
          myServer: {
            type: "http",
            url: "https://example.com",
            unknownServerOption: true,
          },
        },
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "mcpServers.myServer.unknownServerOption",
        message: "Unknown MCP server config field 'mcpServers.myServer.unknownServerOption'",
      });
    });

    it("suggests similar field names for typos", () => {
      const config = {
        concurency: {}, // typo: missing 'r'
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "concurency",
        suggestion: "Did you mean 'concurrency'?",
      });
    });

    it("suggests similar nested field names", () => {
      const config = {
        budget: {
          dailyCap: 500, // typo: should be dailyCapUsd
        },
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "unknown",
        field: "budget.dailyCap",
        suggestion: "Did you mean 'dailyCapUsd'?",
      });
    });
  });

  describe("deprecated fields", () => {
    it("detects deprecated fields when registry has entries", () => {
      // Temporarily add a deprecated field for testing
      const originalDeprecated = { ...DEPRECATED_FIELDS };
      (DEPRECATED_FIELDS as Record<string, unknown>)["concurrency.maxWorkers"] = {
        since: "0.5.0",
        replacement: "concurrency.maxSessions",
        message: "Use concurrency.maxSessions instead",
      };

      try {
        const config = {
          concurrency: {
            maxWorkers: 10,
          },
        };

        const warnings = collectConfigWarnings(config);

        const deprecatedWarning = warnings.find((w) => w.type === "deprecated");
        expect(deprecatedWarning).toBeDefined();
        expect(deprecatedWarning).toMatchObject({
          type: "deprecated",
          field: "concurrency.maxWorkers",
          message:
            "Field 'concurrency.maxWorkers' is deprecated since 0.5.0. Use concurrency.maxSessions instead",
          suggestion: "Use 'concurrency.maxSessions' instead",
        });
      } finally {
        // Restore original state
        for (const key of Object.keys(DEPRECATED_FIELDS)) {
          if (!(key in originalDeprecated)) {
            delete (DEPRECATED_FIELDS as Record<string, unknown>)[key];
          }
        }
      }
    });

    it("returns empty warnings for config with no deprecated fields", () => {
      const config = {
        repos: [{ path: "/my/repo" }],
        concurrency: { maxSessions: 5 },
      };

      const warnings = collectConfigWarnings(config);
      const deprecatedWarnings = warnings.filter((w) => w.type === "deprecated");

      expect(deprecatedWarnings).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("returns empty warnings for valid config", () => {
      const config = {
        repos: [
          {
            path: "/my/repo",
            name: "my-repo",
            defaultBranch: "main",
            branchPrefix: "feat",
            pushRemote: "origin",
            gitStrategy: "branch",
          },
        ],
        concurrency: {
          maxSessions: 5,
          maxPerRepo: 4,
          queueMax: 50,
        },
        budget: {
          dailyCapUsd: 500,
          alertThresholdPct: 80,
        },
      };

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(0);
    });

    it("handles empty config", () => {
      const config = {};

      const warnings = collectConfigWarnings(config);

      expect(warnings).toHaveLength(0);
    });

    it("handles null values gracefully", () => {
      const config = {
        repos: null,
        concurrency: null,
      };

      // Should not throw
      const warnings = collectConfigWarnings(config as unknown as Record<string, unknown>);

      // null values are not objects, so no nested field checking occurs
      expect(warnings).toHaveLength(0);
    });

    it("handles arrays with non-object entries", () => {
      const config = {
        repos: ["string-value", 123, null],
      };

      // Should not throw
      const warnings = collectConfigWarnings(config as unknown as Record<string, unknown>);

      expect(warnings).toHaveLength(0);
    });
  });
});

describe("formatConfigWarnings", () => {
  it("formats unknown field warnings", () => {
    const warnings = [
      {
        type: "unknown" as const,
        field: "unknownField",
        message: "Unknown config field 'unknownField'",
        suggestion: "Did you mean 'concurrency'?",
      },
    ];

    const formatted = formatConfigWarnings(warnings, "/path/to/config.yml");

    expect(formatted).toHaveLength(1);
    expect(formatted[0]).toBe(
      "[neo] [unknown] /path/to/config.yml: Unknown config field 'unknownField' Did you mean 'concurrency'?",
    );
  });

  it("formats deprecated field warnings", () => {
    const warnings = [
      {
        type: "deprecated" as const,
        field: "oldField",
        message: "Field 'oldField' is deprecated since 0.5.0",
        suggestion: "Use 'newField' instead",
      },
    ];

    const formatted = formatConfigWarnings(warnings, "/path/to/config.yml");

    expect(formatted).toHaveLength(1);
    expect(formatted[0]).toBe(
      "[neo] [deprecated] /path/to/config.yml: Field 'oldField' is deprecated since 0.5.0 Use 'newField' instead",
    );
  });

  it("formats warnings without suggestions", () => {
    const warnings = [
      {
        type: "unknown" as const,
        field: "weirdField",
        message: "Unknown config field 'weirdField'",
      },
    ];

    const formatted = formatConfigWarnings(warnings, "/path/to/config.yml");

    expect(formatted).toHaveLength(1);
    expect(formatted[0]).toBe(
      "[neo] [unknown] /path/to/config.yml: Unknown config field 'weirdField'",
    );
  });

  it("formats multiple warnings", () => {
    const warnings = [
      {
        type: "unknown" as const,
        field: "field1",
        message: "Unknown config field 'field1'",
      },
      {
        type: "deprecated" as const,
        field: "field2",
        message: "Field 'field2' is deprecated",
      },
    ];

    const formatted = formatConfigWarnings(warnings, "/path/to/config.yml");

    expect(formatted).toHaveLength(2);
  });
});

describe("known fields registries", () => {
  it("KNOWN_TOP_LEVEL_FIELDS includes all expected fields", () => {
    const expected = [
      "repos",
      "concurrency",
      "budget",
      "recovery",
      "sessions",
      "webhooks",
      "supervisor",
      "memory",
      "mcpServers",
      "claudeCodePath",
      "idempotency",
    ];

    for (const field of expected) {
      expect(KNOWN_TOP_LEVEL_FIELDS.has(field)).toBe(true);
    }
  });

  it("KNOWN_NESTED_FIELDS includes all expected nested field sets", () => {
    expect(KNOWN_NESTED_FIELDS.concurrency).toBeDefined();
    expect(KNOWN_NESTED_FIELDS.budget).toBeDefined();
    expect(KNOWN_NESTED_FIELDS.recovery).toBeDefined();
    expect(KNOWN_NESTED_FIELDS.sessions).toBeDefined();
    expect(KNOWN_NESTED_FIELDS.supervisor).toBeDefined();
    expect(KNOWN_NESTED_FIELDS.memory).toBeDefined();
    expect(KNOWN_NESTED_FIELDS.idempotency).toBeDefined();

    // Verify some specific nested fields
    expect(KNOWN_NESTED_FIELDS.concurrency?.has("maxSessions")).toBe(true);
    expect(KNOWN_NESTED_FIELDS.budget?.has("dailyCapUsd")).toBe(true);
    expect(KNOWN_NESTED_FIELDS.supervisor?.has("port")).toBe(true);
  });
});
