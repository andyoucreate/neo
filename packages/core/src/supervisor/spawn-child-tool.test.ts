import { describe, expect, it } from "vitest";
import {
  SPAWN_CHILD_SUPERVISOR_TOOL,
  spawnChildSupervisorInputSchema,
} from "./spawn-child-tool.js";

describe("spawn_child_supervisor tool schema", () => {
  it("validates correct input", () => {
    const input = {
      objective: "Implement user authentication",
      acceptanceCriteria: ["All tests pass", "PR created"],
      maxCostUsd: 5.0,
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects missing objective", () => {
    const input = {
      acceptanceCriteria: ["Tests pass"],
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("allows optional maxCostUsd", () => {
    const input = {
      objective: "Fix bug",
      acceptanceCriteria: ["Bug fixed"],
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("enforces minimum criteria length", () => {
    const input = {
      objective: "Do something",
      acceptanceCriteria: [],
    };
    const result = spawnChildSupervisorInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("exports valid tool definition", () => {
    expect(SPAWN_CHILD_SUPERVISOR_TOOL.name).toBe("spawn_child_supervisor");
    expect(SPAWN_CHILD_SUPERVISOR_TOOL.inputSchema).toBeDefined();
  });
});
