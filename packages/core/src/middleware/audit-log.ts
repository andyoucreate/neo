import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Middleware } from "../types.js";

/**
 * Audit log middleware.
 *
 * Appends a JSONL line for every tool call. File per session.
 * Uses `{ async: true }` so it never blocks the chain.
 */
export function auditLog(options: {
  dir: string;
  includeInput?: boolean;
  includeOutput?: boolean;
}): Middleware {
  const { dir, includeInput = true, includeOutput = false } = options;
  let dirCreated = false;

  return {
    name: "audit-log",
    on: "PostToolUse",
    async handler(event, context) {
      // Ensure directory exists (once)
      if (!dirCreated) {
        await mkdir(dir, { recursive: true });
        dirCreated = true;
      }

      const entry: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        sessionId: event.sessionId,
        agent: context.agent,
        toolName: event.toolName,
      };

      if (includeInput && event.input !== undefined) {
        entry.input = event.input;
      }

      if (includeOutput && event.output !== undefined) {
        entry.output = event.output;
      }

      const filePath = path.join(dir, `${event.sessionId}.jsonl`);
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");

      return { async: true, asyncTimeout: 5_000 };
    },
  };
}
