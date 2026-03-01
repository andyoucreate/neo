import type { McpStdioServerConfig, McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * MCP server configurations for different agent pipelines.
 * Passed to SDK query() options per session.
 */

export const mcpPlaywright: Record<string, McpStdioServerConfig> = {
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest", "--headless", "--browser", "chromium"],
  },
};

export const mcpNotion: Record<string, McpHttpServerConfig> = {
  notion: {
    type: "http",
    url: "https://mcp.notion.com/mcp",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_TOKEN ?? ""}`,
    },
  },
};

export const mcpContext7: Record<string, McpHttpServerConfig> = {
  context7: {
    type: "http",
    url: "https://mcp.context7.com/mcp",
  },
};
