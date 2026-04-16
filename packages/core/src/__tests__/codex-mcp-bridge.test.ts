import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexMcpBridge } from "@/supervisor/adapters/codex-mcp-bridge";

describe("CodexMcpBridge", () => {
  const tools = [
    {
      name: "dispatch_agent",
      description: "Dispatch an agent to work on a task",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["agent", "prompt"],
      },
    },
  ];

  it("generates MCP server config with correct structure", () => {
    const bridge = new CodexMcpBridge(tools);
    const config = bridge.toMcpServerConfig();

    expect(config).toHaveProperty("command", "node");
    expect(config).toHaveProperty("args");
    expect(Array.isArray(config.args)).toBe(true);
    expect(config.args).toHaveLength(1);
  });

  it("creates a bridge script file on disk", () => {
    const bridge = new CodexMcpBridge(tools);
    const config = bridge.toMcpServerConfig();

    expect(existsSync(config.args[0])).toBe(true);
  });

  it("returns same config on subsequent calls (caches script)", () => {
    const bridge = new CodexMcpBridge(tools);
    const config1 = bridge.toMcpServerConfig();
    const config2 = bridge.toMcpServerConfig();

    expect(config1.args[0]).toBe(config2.args[0]);
  });

  it("returns tool definitions", () => {
    const bridge = new CodexMcpBridge(tools);
    const defs = bridge.getToolDefinitions();
    const first = defs.at(0);

    expect(defs).toHaveLength(1);
    expect(first?.name).toBe("dispatch_agent");
    expect(first?.inputSchema).toBeDefined();
  });
});
