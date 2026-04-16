import { describe, expect, it } from "vitest";
import { ClaudeSessionAdapter } from "@/runner/adapters/claude-session";
import { CodexSessionAdapter } from "@/runner/adapters/codex-session";
import { createSessionAdapter } from "@/runner/adapters/index";

describe("createSessionAdapter", () => {
  it("returns ClaudeSessionAdapter for claude provider", () => {
    const adapter = createSessionAdapter("claude");
    expect(adapter).toBeInstanceOf(ClaudeSessionAdapter);
  });

  it("returns CodexSessionAdapter for codex provider", () => {
    const adapter = createSessionAdapter("codex");
    expect(adapter).toBeInstanceOf(CodexSessionAdapter);
  });
});
