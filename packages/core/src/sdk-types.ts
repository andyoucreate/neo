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
