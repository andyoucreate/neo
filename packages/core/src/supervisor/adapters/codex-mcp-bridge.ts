import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ToolDefinition } from "../supervisor-tools.js";

interface McpServerConfig {
  command: string;
  args: [string];
}

export class CodexMcpBridge {
  private scriptPath: string | undefined;

  constructor(private readonly tools: ToolDefinition[]) {}

  getToolDefinitions(): ToolDefinition[] {
    return this.tools;
  }

  toMcpServerConfig(): McpServerConfig {
    if (!this.scriptPath) {
      this.scriptPath = this.generateBridgeScript();
    }
    return {
      command: "node",
      args: [this.scriptPath],
    };
  }

  private generateBridgeScript(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "neo-mcp-bridge-"));
    const scriptPath = path.join(dir, "bridge.mjs");

    const toolsJson = JSON.stringify(
      this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    );

    const script = `import { createInterface } from "node:readline";

const tools = ${toolsJson};

const rl = createInterface({ input: process.stdin });

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\\n");
}

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "neo-supervisor-tools", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      respondError(id, -32601, "Tool not found: " + toolName);
      return;
    }
    respond(id, {
      content: [{ type: "text", text: "Tool call received: " + toolName }],
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  respondError(id, -32601, "Method not found: " + method);
});
`;

    writeFileSync(scriptPath, script, "utf-8");
    return scriptPath;
  }
}
