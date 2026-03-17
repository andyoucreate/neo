// ─── SDK Stream Message Types ────────────────────────────
// Unified type definitions for Claude Agent SDK stream messages.
// Both session.ts and heartbeat.ts import from this module.

/**
 * Base SDK stream message shape.
 * All messages from the SDK stream have at least a type field.
 */
export interface SDKStreamMessage {
  type: string;
  subtype?: string;
}

/**
 * Init message emitted when a session starts.
 * Contains the session ID for tracking.
 */
export interface SDKInitMessage extends SDKStreamMessage {
  type: "system";
  subtype: "init";
  session_id: string;
}

/**
 * Result message emitted when a session completes.
 * Contains the final output, cost, and turn count.
 */
export interface SDKResultMessage extends SDKStreamMessage {
  type: "result";
  subtype: "success" | string;
  session_id: string;
  result: string;
  total_cost_usd: number;
  num_turns: number;
}

/**
 * Content block in assistant messages.
 */
export interface SDKContentBlock {
  type: string;
  thinking?: string;
  text?: string;
}

/**
 * Assistant message with content blocks.
 * Used when subtype is not present (plain assistant message).
 */
export interface SDKAssistantMessage {
  type: "assistant";
  subtype?: string;
  message?: {
    content?: SDKContentBlock[];
  };
}

/**
 * Tool use message from the assistant.
 */
export interface SDKToolUseMessage {
  type: "assistant";
  subtype: "tool_use";
  tool?: string;
  input?: unknown;
}

/**
 * Tool result message.
 */
export interface SDKToolResultMessage {
  type: "assistant";
  subtype: "tool_result";
  result?: string;
}

// ─── Type Guards ─────────────────────────────────────────

/**
 * Check if a message is an init message.
 */
export function isInitMessage(msg: SDKStreamMessage): msg is SDKInitMessage {
  return msg.type === "system" && msg.subtype === "init";
}

/**
 * Check if a message is a result message.
 */
export function isResultMessage(msg: SDKStreamMessage): msg is SDKResultMessage {
  return msg.type === "result";
}
