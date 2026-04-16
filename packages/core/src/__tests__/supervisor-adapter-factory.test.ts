import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "@/supervisor/adapters/claude";
import { createSupervisorAdapter } from "@/supervisor/adapters/index";

describe("createSupervisorAdapter", () => {
  it("returns ClaudeAdapter for claude provider", () => {
    const adapter = createSupervisorAdapter("claude");
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it("throws for codex provider (not yet implemented)", () => {
    expect(() => createSupervisorAdapter("codex")).toThrow(/not yet implemented/i);
  });
});
