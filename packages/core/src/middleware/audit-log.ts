import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Middleware } from "@/types";

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_FLUSH_SIZE = 20;

/**
 * Audit log middleware.
 *
 * Buffers JSONL entries in memory and flushes to disk either when
 * the buffer reaches `flushSize` entries or every `flushIntervalMs`.
 * File per session. Uses `{ decision: "async" }` so it never blocks the chain.
 *
 * Call `flush()` to force-write remaining entries (e.g. on shutdown).
 * Call `cleanup()` to stop the internal timer (e.g. on shutdown or before GC).
 */
export interface AuditLogMiddleware extends Middleware {
  flush: () => Promise<void>;
  cleanup: () => void;
}

export function auditLog(options: {
  dir: string;
  includeInput?: boolean;
  includeOutput?: boolean;
  flushIntervalMs?: number;
  flushSize?: number;
}): AuditLogMiddleware {
  const {
    dir,
    includeInput = true,
    includeOutput = false,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    flushSize = DEFAULT_FLUSH_SIZE,
  } = options;

  let dirCreated = false;
  // sessionId → buffered lines
  const buffers = new Map<string, string[]>();
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  async function ensureDir(): Promise<void> {
    if (!dirCreated) {
      await mkdir(dir, { recursive: true });
      dirCreated = true;
    }
  }

  async function flushAll(): Promise<void> {
    if (buffers.size === 0) return;
    await ensureDir();

    const writes: Promise<void>[] = [];
    for (const [sessionId, lines] of buffers) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      writes.push(appendFile(filePath, lines.join(""), "utf-8"));
    }
    buffers.clear();
    await Promise.all(writes);
  }

  async function flushSession(sessionId: string): Promise<void> {
    const lines = buffers.get(sessionId);
    if (!lines || lines.length === 0) return;
    await ensureDir();

    const filePath = path.join(dir, `${sessionId}.jsonl`);
    await appendFile(filePath, lines.join(""), "utf-8");
    buffers.delete(sessionId);
  }

  function stopTimer(): void {
    if (flushTimer !== undefined) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
  }

  return {
    name: "audit-log",
    on: "PostToolUse",
    async flush() {
      stopTimer();
      await flushAll();
    },
    cleanup() {
      stopTimer();
    },
    async handler(event, context) {
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

      const sessionId = event.sessionId;
      let lines = buffers.get(sessionId);
      if (!lines) {
        lines = [];
        buffers.set(sessionId, lines);
      }
      lines.push(`${JSON.stringify(entry)}\n`);

      // Flush when buffer is full
      if (lines.length >= flushSize) {
        await flushSession(sessionId);
      }

      // Start periodic flush timer if not already running
      if (flushTimer === undefined && flushIntervalMs > 0) {
        flushTimer = setInterval(() => {
          void flushAll();
        }, flushIntervalMs);
        // Unref so it doesn't keep the process alive
        if (typeof flushTimer === "object" && "unref" in flushTimer) {
          flushTimer.unref();
        }
      }

      return { decision: "async", asyncTimeout: 5_000 };
    },
  };
}
