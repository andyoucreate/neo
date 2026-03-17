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
 * Content block in an assistant message.
 */
export interface SDKContentBlock {
  type: string;
  thinking?: string;
  text?: string;
}

/**
 * Assistant message with content blocks.
 */
export interface SDKAssistantMessage extends SDKStreamMessage {
  type: "assistant";
  message?: {
    content?: SDKContentBlock[];
  };
}

/**
 * Tool use message from the assistant.
 */
export interface SDKToolUseMessage extends SDKStreamMessage {
  type: "assistant";
  subtype: "tool_use";
  tool: string;
  input?: unknown;
}

/**
 * Tool result message.
 */
export interface SDKToolResultMessage extends SDKStreamMessage {
  type: "assistant";
  subtype: "tool_result";
  result?: string;
}

// ─── Type Guards ─────────────────────────────────────────

/**
 * Check if a message is an init message (session started).
 */
export function isInitMessage(msg: SDKStreamMessage): msg is SDKInitMessage {
  return msg.type === "system" && msg.subtype === "init";
}

/**
 * Check if a message is a result message (session completed).
 */
export function isResultMessage(msg: SDKStreamMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

/**
 * Check if a message is an assistant message with content.
 */
export function isAssistantMessage(msg: SDKStreamMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant" && !msg.subtype;
}

/**
 * Check if a message is a tool use message.
 */
export function isToolUseMessage(msg: SDKStreamMessage): msg is SDKToolUseMessage {
  return msg.type === "assistant" && msg.subtype === "tool_use";
}

/**
 * Check if a message is a tool result message.
 */
export function isToolResultMessage(msg: SDKStreamMessage): msg is SDKToolResultMessage {
  return msg.type === "assistant" && msg.subtype === "tool_result";
}
