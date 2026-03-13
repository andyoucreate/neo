import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_config_test__");
const CONFIG_PATH = path.join(TMP_DIR, "config.yml");

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function writeConfig(content: string): Promise<void> {
  return writeFile(CONFIG_PATH, content, "utf-8");
}

describe("loadConfig", () => {
  it("loads a valid config with all fields", async () => {
    await writeConfig(`
repos:
  - path: /my/repo
    name: my-repo
    defaultBranch: develop
    branchPrefix: fix
    pushRemote: upstream
    autoCreatePr: true
    prBaseBranch: develop

concurrency:
  maxSessions: 10
  maxPerRepo: 3
  queueMax: 100

budget:
  dailyCapUsd: 1000
  alertThresholdPct: 90

recovery:
  maxRetries: 5
  backoffBaseMs: 60000

sessions:
  initTimeoutMs: 60000
  maxDurationMs: 7200000

mcpServers:
  context7:
    type: http
    url: https://mcp.context7.com/mcp
    headers:
      Authorization: Bearer token
  local:
    type: stdio
    command: node
    args: [server.js]
    env:
      DEBUG: "true"

claudeCodePath: /usr/local/bin/claude

idempotency:
  enabled: false
  key: prompt
  ttlMs: 7200000
`);

    const config = await loadConfig(CONFIG_PATH);

    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]?.path).toBe("/my/repo");
    expect(config.repos[0]?.name).toBe("my-repo");
    expect(config.repos[0]?.defaultBranch).toBe("develop");
    expect(config.repos[0]?.branchPrefix).toBe("fix");
    expect(config.repos[0]?.pushRemote).toBe("upstream");
    expect(config.repos[0]?.autoCreatePr).toBe(true);
    expect(config.repos[0]?.prBaseBranch).toBe("develop");

    expect(config.concurrency.maxSessions).toBe(10);
    expect(config.concurrency.maxPerRepo).toBe(3);
    expect(config.concurrency.queueMax).toBe(100);

    expect(config.budget.dailyCapUsd).toBe(1000);
    expect(config.budget.alertThresholdPct).toBe(90);

    expect(config.recovery.maxRetries).toBe(5);
    expect(config.recovery.backoffBaseMs).toBe(60000);

    expect(config.sessions.initTimeoutMs).toBe(60000);
    expect(config.sessions.maxDurationMs).toBe(7200000);

    expect(config.mcpServers?.context7).toEqual({
      type: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect(config.mcpServers?.local).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { DEBUG: "true" },
    });

    expect(config.claudeCodePath).toBe("/usr/local/bin/claude");

    expect(config.idempotency?.enabled).toBe(false);
    expect(config.idempotency?.key).toBe("prompt");
    expect(config.idempotency?.ttlMs).toBe(7200000);
  });

  it("applies defaults for partial config", async () => {
    await writeConfig(`
repos:
  - path: /my/repo
`);

    const config = await loadConfig(CONFIG_PATH);

    expect(config.repos[0]?.defaultBranch).toBe("main");
    expect(config.repos[0]?.branchPrefix).toBe("feat");
    expect(config.repos[0]?.pushRemote).toBe("origin");
    expect(config.repos[0]?.autoCreatePr).toBe(false);

    expect(config.concurrency.maxSessions).toBe(5);
    expect(config.concurrency.maxPerRepo).toBe(2);
    expect(config.concurrency.queueMax).toBe(50);

    expect(config.budget.dailyCapUsd).toBe(500);
    expect(config.budget.alertThresholdPct).toBe(80);

    expect(config.recovery.maxRetries).toBe(3);
    expect(config.recovery.backoffBaseMs).toBe(30_000);

    expect(config.sessions.initTimeoutMs).toBe(120_000);
    expect(config.sessions.maxDurationMs).toBe(3_600_000);
  });

  it("throws descriptive error for missing repos", async () => {
    await writeConfig(`
concurrency:
  maxSessions: 5
`);

    await expect(loadConfig(CONFIG_PATH)).rejects.toThrow("repos");
  });

  it("throws for invalid YAML", async () => {
    await writeConfig(`
repos:
  - path: /my/repo
  invalid yaml: [
`);

    await expect(loadConfig(CONFIG_PATH)).rejects.toThrow("Invalid YAML");
  });

  it("throws for missing config file", async () => {
    await expect(loadConfig("/nonexistent/config.yml")).rejects.toThrow(
      "Config file not found",
    );
  });

  it("validates RepoConfig defaults", async () => {
    await writeConfig(`
repos:
  - path: /repo-a
  - path: /repo-b
    defaultBranch: develop
    branchPrefix: hotfix
`);

    const config = await loadConfig(CONFIG_PATH);

    expect(config.repos[0]?.defaultBranch).toBe("main");
    expect(config.repos[0]?.branchPrefix).toBe("feat");
    expect(config.repos[0]?.pushRemote).toBe("origin");

    expect(config.repos[1]?.defaultBranch).toBe("develop");
    expect(config.repos[1]?.branchPrefix).toBe("hotfix");
  });

  it("validates http McpServerConfig", async () => {
    await writeConfig(`
repos:
  - path: /my/repo
mcpServers:
  myserver:
    type: http
    url: https://example.com/mcp
`);

    const config = await loadConfig(CONFIG_PATH);
    const server = config.mcpServers?.myserver;
    assert(server, "server should be defined");
    expect(server.type).toBe("http");
    if (server.type === "http") {
      expect(server.url).toBe("https://example.com/mcp");
    }
  });

  it("validates stdio McpServerConfig", async () => {
    await writeConfig(`
repos:
  - path: /my/repo
mcpServers:
  localserver:
    type: stdio
    command: npx
    args: [mcp-server]
    env:
      PORT: "3000"
`);

    const config = await loadConfig(CONFIG_PATH);
    const server = config.mcpServers?.localserver;
    assert(server, "server should be defined");
    expect(server.type).toBe("stdio");
    if (server.type === "stdio") {
      expect(server.command).toBe("npx");
      expect(server.args).toEqual(["mcp-server"]);
      expect(server.env).toEqual({ PORT: "3000" });
    }
  });

  it("rejects McpServerConfig with invalid type", async () => {
    await writeConfig(`
repos:
  - path: /my/repo
mcpServers:
  bad:
    type: websocket
    url: ws://localhost
`);

    await expect(loadConfig(CONFIG_PATH)).rejects.toThrow();
  });
});
