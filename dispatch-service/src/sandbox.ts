import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Standard sandbox for developer, fixer, QA agents.
 * Allows writes within the repo and /tmp only.
 */
export function createSandboxConfig(repoDir: string): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [
        `${repoDir}/**`, // repo directory (rw)
        "/tmp/**", // temp files
      ],
      denyWrite: [
        "/opt/voltaire/**", // system config
        "/etc/**", // system files
        "/home/voltaire/.openclaw/**", // openclaw data
      ],
      denyRead: [
        "/opt/voltaire/.env", // secrets
      ],
    },
    network: {
      allowedDomains: [
        "api.anthropic.com",
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "mcp.notion.com",
      ],
      allowLocalBinding: true, // for preview servers
    },
  };
}

/**
 * Read-only sandbox for reviewer agents.
 * No filesystem writes allowed.
 */
export function createReadonlySandboxConfig(_repoDir: string): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [],
      denyWrite: ["**/*"],
      denyRead: ["/opt/voltaire/.env"],
    },
    network: {
      allowedDomains: ["registry.npmjs.org"], // for pnpm audit
    },
  };
}
