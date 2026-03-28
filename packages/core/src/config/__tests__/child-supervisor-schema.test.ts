import { describe, expect, it } from "vitest";
import {
  type ChildSupervisorConfig,
  childSupervisorConfigSchema,
  childSupervisorTypeSchema,
} from "../child-supervisor-schema.js";

describe("childSupervisorTypeSchema", () => {
  it("accepts valid supervisor types", () => {
    expect(childSupervisorTypeSchema.parse("cleanup")).toBe("cleanup");
    expect(childSupervisorTypeSchema.parse("custom")).toBe("custom");
  });

  it("rejects invalid types", () => {
    expect(() => childSupervisorTypeSchema.parse("invalid")).toThrow();
  });
});

describe("childSupervisorConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const input = {
      name: "cleanup-neo",
      type: "cleanup",
      repo: "/path/to/neo",
    };
    const result = childSupervisorConfigSchema.parse(input);

    expect(result.name).toBe("cleanup-neo");
    expect(result.type).toBe("cleanup");
    expect(result.repo).toBe("/path/to/neo");
    expect(result.enabled).toBe(true);
    expect(result.budget.dailyCapUsd).toBe(10);
    expect(result.heartbeatIntervalMs).toBe(60_000);
  });

  it("parses full config with custom values", () => {
    const input: ChildSupervisorConfig = {
      name: "cleanup-neo",
      type: "cleanup",
      repo: "/path/to/neo",
      enabled: false,
      budget: {
        dailyCapUsd: 5,
        maxCostPerTaskUsd: 0.5,
      },
      heartbeatIntervalMs: 120_000,
      autoStart: false,
      objective: "Keep the codebase clean",
      acceptanceCriteria: ["No lint errors", "All tests pass"],
    };
    const result = childSupervisorConfigSchema.parse(input);

    expect(result.enabled).toBe(false);
    expect(result.budget.dailyCapUsd).toBe(5);
    expect(result.heartbeatIntervalMs).toBe(120_000);
    expect(result.autoStart).toBe(false);
  });

  it("requires name, type, and repo", () => {
    expect(() => childSupervisorConfigSchema.parse({})).toThrow();
    expect(() => childSupervisorConfigSchema.parse({ name: "x" })).toThrow();
    expect(() => childSupervisorConfigSchema.parse({ name: "x", type: "cleanup" })).toThrow();
  });
});
