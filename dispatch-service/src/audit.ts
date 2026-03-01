import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { AUDIT_LOG_PATH } from "./config.js";

let dirEnsured = false;

/**
 * Append an event to the audit log (append-only JSONL).
 * Non-blocking — errors are caught by the caller.
 */
export async function appendToAuditLog(input: HookInput): Promise<void> {
  if (!dirEnsured) {
    await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
    dirEnsured = true;
  }

  const entry = {
    ts: new Date().toISOString(),
    event: input.hook_event_name,
    sessionId: input.session_id,
    cwd: input.cwd,
    ...(("tool_name" in input) && { toolName: input.tool_name }),
    ...(("tool_input" in input) && { toolInput: redactSecrets(input.tool_input) }),
  };

  await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Redact potential secrets from tool input before logging.
 */
function redactSecrets(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;

  const obj = input as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("password") ||
      lowerKey.includes("api_key") ||
      lowerKey.includes("apikey")
    ) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 500) {
      redacted[key] = value.slice(0, 500) + "...[truncated]";
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}
