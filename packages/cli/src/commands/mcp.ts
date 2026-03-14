import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, type McpServerConfig } from "@neotx/core";
import { defineCommand } from "citty";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { printError, printSuccess, printTable } from "../output.js";

// ─── Presets for popular MCP servers ─────────────────────

const MCP_PRESETS: Record<string, { config: McpServerConfig; envVars: string[] }> = {
  linear: {
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@anthropic/linear-mcp-server"],
      env: { LINEAR_API_KEY: "${LINEAR_API_KEY}" },
    },
    envVars: ["LINEAR_API_KEY"],
  },
  notion: {
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@anthropic/notion-mcp-server"],
      env: { NOTION_API_KEY: "${NOTION_API_KEY}" },
    },
    envVars: ["NOTION_API_KEY"],
  },
  github: {
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    },
    envVars: ["GITHUB_TOKEN"],
  },
  jira: {
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@anthropic/jira-mcp-server"],
      env: { JIRA_API_TOKEN: "${JIRA_API_TOKEN}", JIRA_URL: "${JIRA_URL}" },
    },
    envVars: ["JIRA_API_TOKEN", "JIRA_URL"],
  },
  slack: {
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" },
    },
    envVars: ["SLACK_BOT_TOKEN"],
  },
};

// ─── Helpers ─────────────────────────────────────────────

async function loadAndModifyConfig(
  modify: (config: Record<string, unknown>) => void,
): Promise<void> {
  const configPath = path.join(homedir(), ".neo", "config.yml");
  let config: Record<string, unknown>;

  try {
    const raw = await readFile(configPath, "utf-8");
    config = (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch {
    config = {};
  }

  modify(config);
  await writeFile(configPath, stringifyYaml(config), "utf-8");
}

// ─── Subcommands ─────────────────────────────────────────

const listCmd = defineCommand({
  meta: { name: "list", description: "List configured MCP servers" },
  async run() {
    const config = await loadGlobalConfig();
    const servers = config.mcpServers ?? {};
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      console.log("No MCP servers configured.");
      console.log("Add one with: neo mcp add <name> or neo mcp add <preset>");
      console.log(`Available presets: ${Object.keys(MCP_PRESETS).join(", ")}`);
      return;
    }

    const rows = entries.map(([name, cfg]) => {
      if (cfg.type === "stdio") {
        return [name, "stdio", `${cfg.command} ${(cfg.args ?? []).join(" ")}`];
      }
      return [name, "http", cfg.url];
    });

    printTable(["Name", "Type", "Config"], rows);
  },
});

const addCmd = defineCommand({
  meta: { name: "add", description: "Add an MCP server (use a preset name or custom flags)" },
  args: {
    name: {
      type: "positional",
      description: "Server name or preset (linear, notion, github, jira, slack)",
    },
    type: { type: "string", description: "Server type: stdio or http" },
    command: { type: "string", description: "Command for stdio servers" },
    serverArgs: { type: "string", description: "Comma-separated args for stdio servers" },
    url: { type: "string", description: "URL for http servers" },
  },
  async run({ args }) {
    const name = args.name as string | undefined;
    if (!name) {
      printError("Server name is required. Usage: neo mcp add <name>");
      process.exitCode = 1;
      return;
    }

    // Check if it's a preset
    const preset = MCP_PRESETS[name];
    if (preset) {
      // Check env vars
      const missing = preset.envVars.filter((v: string) => !process.env[v]);
      if (missing.length > 0) {
        console.log(`Preset "${name}" requires the following environment variables:`);
        for (const v of missing) {
          console.log(`  ${v} (not set)`);
        }
        console.log("\nSet them before starting the supervisor.");
      }

      await loadAndModifyConfig((config) => {
        const servers = (config.mcpServers as Record<string, unknown>) ?? {};
        servers[name] = preset.config;
        config.mcpServers = servers;
      });

      printSuccess(`Added MCP server "${name}" (preset)`);
      return;
    }

    // Custom server
    if (!args.type) {
      printError(`Unknown preset "${name}". Use --type stdio or --type http for custom servers.`);
      console.log(`Available presets: ${Object.keys(MCP_PRESETS).join(", ")}`);
      process.exitCode = 1;
      return;
    }

    let serverConfig: McpServerConfig;
    if (args.type === "stdio") {
      if (!args.command) {
        printError("--command is required for stdio servers");
        process.exitCode = 1;
        return;
      }
      serverConfig = {
        type: "stdio",
        command: args.command,
        args: args.serverArgs ? args.serverArgs.split(",") : undefined,
      };
    } else if (args.type === "http") {
      if (!args.url) {
        printError("--url is required for http servers");
        process.exitCode = 1;
        return;
      }
      serverConfig = {
        type: "http",
        url: args.url,
      };
    } else {
      printError(`Invalid type "${args.type}". Use "stdio" or "http".`);
      process.exitCode = 1;
      return;
    }

    await loadAndModifyConfig((config) => {
      const servers = (config.mcpServers as Record<string, unknown>) ?? {};
      servers[name] = serverConfig;
      config.mcpServers = servers;
    });

    printSuccess(`Added MCP server "${name}"`);
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove an MCP server" },
  args: {
    name: { type: "positional", description: "Server name to remove" },
  },
  async run({ args }) {
    const name = args.name as string | undefined;
    if (!name) {
      printError("Server name is required. Usage: neo mcp remove <name>");
      process.exitCode = 1;
      return;
    }

    let found = false;

    await loadAndModifyConfig((config) => {
      const servers = config.mcpServers as Record<string, unknown> | undefined;
      if (servers && name in servers) {
        delete servers[name];
        found = true;
        if (Object.keys(servers).length === 0) {
          delete config.mcpServers;
        }
      }
    });

    if (found) {
      printSuccess(`Removed MCP server "${name}"`);
    } else {
      printError(`MCP server "${name}" not found`);
      process.exitCode = 1;
    }
  },
});

// ─── Main command ────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Manage MCP server integrations (Linear, Notion, GitHub, etc.)",
  },
  subCommands: {
    list: () => Promise.resolve(listCmd),
    add: () => Promise.resolve(addCmd),
    remove: () => Promise.resolve(removeCmd),
  },
});
