export type ChildCommand =
  | { type: "inject"; supervisorId: string; context: string }
  | { type: "unblock"; supervisorId: string; answer: string }
  | { type: "stop"; supervisorId: string };

/**
 * Parse a TUI inbox message text into a child supervisor command.
 * Returns null if the text is not a child command.
 *
 * Formats:
 *   child:inject <supervisorId> <context...>
 *   child:unblock <supervisorId> <answer...>
 *   child:stop <supervisorId>
 */
export function parseChildCommand(text: string): ChildCommand | null {
  const trimmed = text.trim();

  const injectMatch = /^child:inject\s+(\S+)\s+(.+)$/i.exec(trimmed);
  if (injectMatch) {
    const supervisorId = injectMatch[1];
    const context = injectMatch[2];
    if (!supervisorId || !context) return null;
    return { type: "inject", supervisorId, context };
  }

  const unblockMatch = /^child:unblock\s+(\S+)\s+(.+)$/i.exec(trimmed);
  if (unblockMatch) {
    const supervisorId = unblockMatch[1];
    const answer = unblockMatch[2];
    if (!supervisorId || !answer) return null;
    return { type: "unblock", supervisorId, answer };
  }

  const stopMatch = /^child:stop\s+(\S+)$/i.exec(trimmed);
  if (stopMatch) {
    const supervisorId = stopMatch[1];
    if (!supervisorId) return null;
    return { type: "stop", supervisorId };
  }

  return null;
}
