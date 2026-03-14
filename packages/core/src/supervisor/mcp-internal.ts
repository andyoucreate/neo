import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Minimal MCP stdio server that provides a `report_progress` tool
 * for the supervisor to log structured activity without truncation.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP standard).
 * The activity path is passed via NEO_ACTIVITY_PATH env var.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface ReportProgressInput {
  type: "decision" | "action" | "blocker" | "progress";
  message: string;
}

const TOOL_DEFINITION = {
  name: "report_progress",
  description:
    "Log a structured progress report. Use this to report your decisions, actions, blockers, and progress. Messages are logged without truncation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string" as const,
        enum: ["decision", "action", "blocker", "progress"],
        description: "Category of the report",
      },
      message: {
        type: "string" as const,
        description: "Full message to log — not truncated",
      },
    },
    required: ["type", "message"],
  },
};

function respond(id: number | string, result: unknown): void {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(`${response}\n`);
}

function respondError(id: number | string, code: number, message: string): void {
  const response = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(`${response}\n`);
}

async function handleRequest(req: JsonRpcRequest, activityPath: string): Promise<void> {
  switch (req.method) {
    case "initialize":
      respond(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "neo-internal", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      respond(req.id, { tools: [TOOL_DEFINITION] });
      break;

    case "tools/call": {
      const toolName = req.params?.name as string;
      if (toolName !== "report_progress") {
        respondError(req.id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      const args = req.params?.arguments as ReportProgressInput;
      if (!args?.type || !args?.message) {
        respondError(req.id, -32602, "Missing required arguments: type, message");
        return;
      }

      // Map report type to activity log type
      const typeMap: Record<string, string> = {
        decision: "decision",
        action: "action",
        blocker: "error",
        progress: "event",
      };

      const entry = {
        id: randomUUID(),
        type: typeMap[args.type] ?? "event",
        summary: args.message,
        timestamp: new Date().toISOString(),
      };

      await appendFile(activityPath, `${JSON.stringify(entry)}\n`, "utf-8");
      respond(req.id, {
        content: [{ type: "text", text: `Logged: [${args.type}] ${args.message.slice(0, 100)}` }],
      });
      break;
    }

    default:
      if (!req.method.startsWith("notifications/")) {
        respondError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

// ─── Main ──────────────────────────────────────────────

const activityPath = process.env.NEO_ACTIVITY_PATH;
if (!activityPath) {
  process.stderr.write("NEO_ACTIVITY_PATH env var is required\n");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line) as JsonRpcRequest;
    handleRequest(req, activityPath).catch((err) => {
      process.stderr.write(`MCP handler error: ${err}\n`);
    });
  } catch {
    // Skip malformed JSON
  }
});
