import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { appendToAuditLog } from "./audit.js";
import { logger } from "./logger.js";

// ─── Dangerous command blocker (defense-in-depth) ──────────────
const BLOCKED_COMMANDS =
  /rm\s+-rf\s+[/~]|mkfs|fdisk|shutdown|reboot|poweroff|npm\s+publish|pnpm\s+publish|git\s+push\s+--force|git\s+push\s+-f\b|drop\s+table|drop\s+database/i;

const blockDangerousCommands: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const hookInput = input;
  const cmd =
    typeof hookInput.tool_input === "object" && hookInput.tool_input !== null
      ? (hookInput.tool_input as Record<string, unknown>).command
      : undefined;

  if (typeof cmd !== "string") return {};

  if (BLOCKED_COMMANDS.test(cmd)) {
    logger.warn(`Blocked dangerous command: ${cmd}`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Blocked dangerous command: ${cmd}`,
      },
    };
  }

  return {};
};

// ─── Protected files guard ─────────────────────────────────────
const PROTECTED_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*credentials*",
  "*secret*",
  "docker-compose.yml",
  "Dockerfile",
  ".github/workflows/*",
  "openclaw.json",
];

const protectFiles: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const hookInput = input;
  const filePath =
    typeof hookInput.tool_input === "object" && hookInput.tool_input !== null
      ? (hookInput.tool_input as Record<string, unknown>).file_path
      : undefined;

  if (typeof filePath !== "string") return {};

  const fileName = filePath.split("/").pop() ?? "";

  const isProtected = PROTECTED_PATTERNS.some((pattern) => {
    if (pattern.includes("/")) {
      // Path-based pattern — match against full path
      return filePath.includes(pattern.replace(/\*/g, ""));
    }
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
      );
      return regex.test(fileName);
    }
    return filePath.endsWith(pattern);
  });

  if (isProtected) {
    logger.warn(`Blocked write to protected file: ${filePath}`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Protected file: ${filePath}`,
      },
    };
  }

  return {};
};

// ─── Audit logger (async, non-blocking) ────────────────────────
const auditLogger: HookCallback = async (input): Promise<HookJSONOutput> => {
  appendToAuditLog(input).catch((err: unknown) =>
    logger.error("Failed to write audit log", err),
  );
  return { async: true as const, asyncTimeout: 5_000 };
};

// ─── Notification forwarder (Slack) ────────────────────────────
const slackNotifier: HookCallback = async (input): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "Notification") return {};
  const notifInput = input;
  // Slack integration is implemented in a separate module
  // This hook just logs for now — Slack posting is wired in Phase 3
  logger.info(`Agent notification: ${notifInput.message}`);
  return { async: true as const, asyncTimeout: 10_000 };
};

// ─── Export hook configuration ─────────────────────────────────
export const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
  PreToolUse: [
    { matcher: "Bash", hooks: [blockDangerousCommands] },
    { matcher: "Write|Edit", hooks: [protectFiles] },
    { hooks: [auditLogger] },
  ],
  PostToolUse: [{ hooks: [auditLogger] }],
  Notification: [{ hooks: [slackNotifier] }],
};

// Re-export individual hooks for testing
export {
  blockDangerousCommands,
  protectFiles,
  auditLogger,
  slackNotifier,
  BLOCKED_COMMANDS,
  PROTECTED_PATTERNS,
};
