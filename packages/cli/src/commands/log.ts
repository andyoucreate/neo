import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { appendLogBuffer, getSupervisorDir, MemoryStore } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const VALID_TYPES = [
  "progress",
  "action",
  "decision",
  "blocker",
  "milestone",
  "discovery",
] as const;
type LogType = (typeof VALID_TYPES)[number];

// Map log types to activity.jsonl entry types (preserve existing behavior)
const TYPE_MAP: Record<string, string> = {
  decision: "decision",
  action: "action",
  blocker: "error",
  progress: "event",
  milestone: "event",
  discovery: "event",
};

// Implicit routing: which target each type gets by default
const TARGET_MAP: Record<string, "memory" | "knowledge" | "digest"> = {
  progress: "digest",
  action: "digest",
  decision: "memory",
  milestone: "memory",
  blocker: "memory",
  discovery: "knowledge",
};

export default defineCommand({
  meta: {
    name: "log",
    description: "Log a structured progress report to the supervisor activity log",
  },
  args: {
    type: {
      type: "positional",
      description: "Report type: progress, action, decision, blocker, milestone, discovery",
      required: true,
    },
    message: {
      type: "positional",
      description: "Message to log",
      required: true,
    },
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: "supervisor",
    },
    memory: {
      type: "boolean",
      description: "Override routing: send to memory target",
      default: false,
    },
    knowledge: {
      type: "boolean",
      description: "Override routing: send to knowledge target",
      default: false,
    },
    repo: {
      type: "string",
      description: "Repository path",
    },
    procedure: {
      type: "boolean",
      description: "Also write as a procedure memory entry",
      default: false,
    },
  },
  async run({ args }) {
    const type = args.type as string;
    if (!VALID_TYPES.includes(type as LogType)) {
      printError(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const dir = getSupervisorDir(args.name);
    const now = new Date().toISOString();
    const id = randomUUID();

    // Resolve agent/run from env vars or flags
    const agent = process.env.NEO_AGENT_NAME ?? undefined;
    const runId = process.env.NEO_RUN_ID ?? undefined;
    const repo = (args.repo as string | undefined) ?? process.env.NEO_REPOSITORY ?? undefined;

    // Resolve target with flag overrides
    let target: "memory" | "knowledge" | "digest" = TARGET_MAP[type] ?? "digest";
    if (args.memory) target = "memory";
    if (args.knowledge) target = "knowledge";

    // 1. Always: append to activity.jsonl (existing behavior)
    const activityEntry = {
      id,
      type: TYPE_MAP[type] ?? "event",
      summary: args.message,
      timestamp: now,
    };
    await appendFile(`${dir}/activity.jsonl`, `${JSON.stringify(activityEntry)}\n`, "utf-8");

    // 2. Always: append to log-buffer.jsonl via shared helper
    await appendLogBuffer(dir, {
      id,
      type: type as "progress" | "action" | "decision" | "blocker" | "milestone" | "discovery",
      message: args.message,
      agent,
      runId,
      repo,
      target,
      timestamp: now,
    });

    // 3. Write to memory store for knowledge/procedure entries
    if (target === "knowledge" || args.procedure) {
      try {
        const store = new MemoryStore(path.join(dir, "memory.sqlite"));
        await store.write({
          type: args.procedure ? "procedure" : "fact",
          scope: repo ?? "global",
          content: args.message,
          source: agent ?? "user",
          runId,
        });
        store.close();
      } catch {
        // Best-effort — don't crash CLI if store write fails
      }
    }

    // 4. If blocker: also append to inbox.jsonl (wake up heartbeat)
    if (type === "blocker") {
      const inboxMessage = {
        id: randomUUID(),
        from: "agent" as const,
        text: `[BLOCKER]${agent ? ` (${agent})` : ""} ${args.message}`,
        timestamp: now,
      };
      await appendFile(`${dir}/inbox.jsonl`, `${JSON.stringify(inboxMessage)}\n`, "utf-8");
    }

    printSuccess(`Logged: [${type}] ${args.message.slice(0, 100)}`);
  },
});
