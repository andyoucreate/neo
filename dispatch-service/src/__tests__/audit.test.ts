import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import type { PreToolUseHookInput, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

// vi.hoisted runs before vi.mock hoisting
const { tempDir, auditPath } = vi.hoisted(() => {
   
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  return { tempDir: td, auditPath: path.join(td, "logs", "audit.log") };
});

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return { ...actual, AUDIT_LOG_PATH: auditPath };
});

import { appendToAuditLog } from "../audit.js";

describe("Audit Log", () => {
  beforeEach(async () => {
    // Force re-creation of the audit dir on next call
    // We do this by re-importing a fresh module version
    // But vitest caches modules, so we just ensure dir exists
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(auditPath), { recursive: true });
    writeFileSync(auditPath, "", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should write PreToolUse events with tool info", async () => {
    const input: PreToolUseHookInput = {
      hook_event_name: "PreToolUse",
      session_id: "session-123",
      cwd: "/tmp/repo",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    };

    await appendToAuditLog(input);

    const content = readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.event).toBe("PreToolUse");
    expect(entry.sessionId).toBe("session-123");
    expect(entry.toolName).toBe("Bash");
    expect(entry.toolInput).toEqual({ command: "pnpm test" });
    expect(entry.ts).toBeDefined();
  });

  it("should redact sensitive fields", async () => {
    const input: PreToolUseHookInput = {
      hook_event_name: "PreToolUse",
      session_id: "session-456",
      cwd: "/tmp/repo",
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/.env",
        content: "normal content",
        api_token: "sk-secret-123",
        password: "hunter2",
        apiKey: "key-456",
      },
    };

    await appendToAuditLog(input);

    const content = readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.toolInput.content).toBe("normal content");
    expect(entry.toolInput.api_token).toBe("[REDACTED]");
    expect(entry.toolInput.password).toBe("[REDACTED]");
    expect(entry.toolInput.apiKey).toBe("[REDACTED]");
  });

  it("should truncate long values", async () => {
    const longValue = "x".repeat(600);
    const input: PreToolUseHookInput = {
      hook_event_name: "PreToolUse",
      session_id: "session-789",
      cwd: "/tmp/repo",
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/file.ts",
        content: longValue,
      },
    };

    await appendToAuditLog(input);

    const content = readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.toolInput.content.length).toBeLessThan(600);
    expect(entry.toolInput.content).toContain("...[truncated]");
  });

  it("should handle PostToolUse events", async () => {
    const input: PostToolUseHookInput = {
      hook_event_name: "PostToolUse",
      session_id: "session-post",
      cwd: "/tmp/repo",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_output: "hello\n",
    };

    await appendToAuditLog(input);

    const content = readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.event).toBe("PostToolUse");
    expect(entry.toolName).toBe("Bash");
  });

  it("should append multiple entries", async () => {
    const input1: PreToolUseHookInput = {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/file.ts" },
    };

    const input2: PreToolUseHookInput = {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/out.ts", content: "code" },
    };

    await appendToAuditLog(input1);
    await appendToAuditLog(input2);

    const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
