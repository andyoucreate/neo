import { describe, expect, it } from "vitest";
import { ClaudeAgentRunner } from "@/runner/adapters/claude-session";
import { CodexAgentRunner } from "@/runner/adapters/codex-session";
import { createAgentRunner } from "@/runner/adapters/index";

describe("createAgentRunner", () => {
  it("returns ClaudeAgentRunner for claude adapter", () => {
    const runner = createAgentRunner("claude");
    expect(runner).toBeInstanceOf(ClaudeAgentRunner);
  });

  it("returns CodexAgentRunner for codex adapter", () => {
    const runner = createAgentRunner("codex");
    expect(runner).toBeInstanceOf(CodexAgentRunner);
  });

  it("throws for unknown adapter", () => {
    expect(() => createAgentRunner("gemini")).toThrow('Unknown adapter "gemini"');
  });
});
