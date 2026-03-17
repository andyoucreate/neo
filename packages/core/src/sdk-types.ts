// ─── SDK Stream Message Types ────────────────────────────
//
// TypeScript interfaces for Claude Agent SDK stream messages.
// These match the actual response shapes from @anthropic-ai/claude-agent-sdk.

/**
 * Base SDK stream message. All messages have a type field.
 * Specific message types extend this with additional fields.
 */
export interface SDKStreamMessage {
  type: string;
  subtype?: string;
}

/**
 * Init message sent when a session starts.
 * Emitted with type: "system", subtype: "init".
 */
export interface SDKInitMessage extends SDKStreamMessage {
  type: "system";
  subtype: "init";
  session_id: string;
}

/**
 * Result message sent when a session completes.
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

// ─── Assistant Message Types ─────────────────────────────

/** Content block in assistant messages (thinking, text, etc.) */
export interface SDKContentBlock {
  type: string;
  thinking?: string;
  text?: string;
}

/** Assistant message with content blocks (no subtype). */
export interface SDKAssistantContentMessage {
  type: "assistant";
  subtype?: never;
  message: {
    content?: SDKContentBlock[];
  };
}

/** Assistant tool use message. */
export interface SDKToolUseMessage extends SDKStreamMessage {
  type: "assistant";
  subtype: "tool_use";
  tool: string;
  input: unknown;
}

/** Assistant tool result message. */
export interface SDKToolResultMessage extends SDKStreamMessage {
  type: "assistant";
  subtype: "tool_result";
  result: string;
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
 * Check if a message is an assistant content message (thinking/text blocks).
 */
export function isAssistantContentMessage(
  msg: SDKStreamMessage,
): msg is SDKAssistantContentMessage {
  return msg.type === "assistant" && msg.subtype === undefined;
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
