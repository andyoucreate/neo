import { describe, it, expect } from "vitest";
import type { PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  blockDangerousCommands,
  protectFiles,
} from "../hooks.js";

function makePreToolUseInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "test-tool-use",
  };
}

describe("blockDangerousCommands", () => {
  it("should block rm -rf /", async () => {
    const input = makePreToolUseInput("Bash", { command: "rm -rf /" });
    const result = (await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
    if (
      result.hookSpecificOutput &&
      result.hookSpecificOutput.hookEventName === "PreToolUse"
    ) {
      expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("should block rm -rf ~", async () => {
    const input = makePreToolUseInput("Bash", { command: "rm -rf ~" });
    const result = (await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
  });

  it("should block git push --force", async () => {
    const input = makePreToolUseInput("Bash", {
      command: "git push --force origin main",
    });
    const result = (await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
  });

  it("should block npm publish", async () => {
    const input = makePreToolUseInput("Bash", { command: "npm publish" });
    const result = (await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
  });

  it("should allow safe commands", async () => {
    const input = makePreToolUseInput("Bash", {
      command: "pnpm test -- --coverage",
    });
    const result = await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toEqual({});
  });

  it("should allow git push without force", async () => {
    const input = makePreToolUseInput("Bash", {
      command: "git push origin feat/my-branch",
    });
    const result = await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toEqual({});
  });

  it("should return empty for non-PreToolUse events", async () => {
    const input = {
      hook_event_name: "PostToolUse" as const,
      session_id: "test",
      transcript_path: "/tmp/test",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      tool_response: "ok",
      tool_use_id: "test",
    };
    const result = await blockDangerousCommands(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toEqual({});
  });
});

describe("protectFiles", () => {
  it("should block writes to .env", async () => {
    const input = makePreToolUseInput("Write", {
      file_path: "/opt/voltaire/.env",
    });
    const result = (await protectFiles(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
    if (
      result.hookSpecificOutput &&
      result.hookSpecificOutput.hookEventName === "PreToolUse"
    ) {
      expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("should block writes to .pem files", async () => {
    const input = makePreToolUseInput("Edit", {
      file_path: "/home/voltaire/server.pem",
    });
    const result = (await protectFiles(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
  });

  it("should block writes to CI config", async () => {
    const input = makePreToolUseInput("Write", {
      file_path: "/repo/.github/workflows/ci.yml",
    });
    const result = (await protectFiles(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    )) as SyncHookJSONOutput;
    expect(result.hookSpecificOutput).toBeDefined();
  });

  it("should allow writes to normal source files", async () => {
    const input = makePreToolUseInput("Write", {
      file_path: "/repo/src/components/button.tsx",
    });
    const result = await protectFiles(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toEqual({});
  });

  it("should allow writes to test files", async () => {
    const input = makePreToolUseInput("Edit", {
      file_path: "/repo/src/__tests__/button.test.ts",
    });
    const result = await protectFiles(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toEqual({});
  });
});
