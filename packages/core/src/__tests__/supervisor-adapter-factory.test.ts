import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "@/supervisor/adapters/claude";
import { createSupervisorAdapter } from "@/supervisor/adapters/index";

describe("createSupervisorAdapter", () => {
  it("returns ClaudeAdapter for claude provider", () => {
    const adapter = createSupervisorAdapter("claude");
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it("returns a CodexAdapter for codex provider", () => {
    const adapter = createSupervisorAdapter("codex");
    expect(adapter).toBeDefined();
    expect(adapter.getSessionHandle()).toBeUndefined();
  });
});
