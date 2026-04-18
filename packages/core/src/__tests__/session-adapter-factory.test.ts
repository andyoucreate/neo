import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/config";
import { ClaudeAgentRunner } from "@/runner/adapters/claude-session";
import { CodexAgentRunner } from "@/runner/adapters/codex-session";
import { createAgentRunner } from "@/runner/adapters/index";

const claudeConfig: ProviderConfig = {
  adapter: "claude",
  models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
  args: [],
  env: {},
};

const codexConfig: ProviderConfig = {
  adapter: "codex",
  models: { default: "o3", available: ["o3"] },
  args: ["--full-auto"],
  env: {},
};

describe("createAgentRunner", () => {
  it("returns ClaudeAgentRunner for claude adapter", () => {
    const runner = createAgentRunner(claudeConfig);
    expect(runner).toBeInstanceOf(ClaudeAgentRunner);
  });

  it("returns CodexAgentRunner for codex adapter", () => {
    const runner = createAgentRunner(codexConfig);
    expect(runner).toBeInstanceOf(CodexAgentRunner);
  });

  it("throws for unknown adapter", () => {
    const badConfig = { ...claudeConfig, adapter: "gemini" };
    expect(() => createAgentRunner(badConfig)).toThrow('Unknown adapter "gemini"');
  });
});
