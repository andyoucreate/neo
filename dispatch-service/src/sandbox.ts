import { homedir } from "node:os";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

const IS_DARWIN = process.platform === "darwin";
const HOME = homedir();

/**
 * Platform-aware writable paths for package managers and caches.
 */
function getPackageManagerPaths(): string[] {
  if (IS_DARWIN) {
    return [
      `${HOME}/Library/pnpm/**`,
      `${HOME}/Library/Caches/**`,
      `${HOME}/.npm/**`,
      `${HOME}/.local/share/pnpm/**`,
    ];
  }
  return [
    `${HOME}/.local/share/pnpm/**`,
    `${HOME}/.cache/**`,
    `${HOME}/.npm/**`,
  ];
}

/**
 * Platform-aware deny-write paths for production infrastructure.
 * On macOS (local dev), these paths don't exist — skip them.
 */
function getDenyWritePaths(): string[] {
  const paths = ["/etc/**"];

  if (!IS_DARWIN) {
    // Production server paths
    paths.push(
      "/opt/voltaire/.env",
      "/opt/voltaire/dispatch-service/**",
      "/opt/voltaire/costs/**",
      "/opt/voltaire/events/**",
      "/opt/voltaire/logs/**",
      `${HOME}/.openclaw/**`,
    );
  }

  return paths;
}

/**
 * Platform-aware deny-read paths for secrets.
 */
function getDenyReadPaths(): string[] {
  if (IS_DARWIN) return [];
  return ["/opt/voltaire/.env"];
}

/**
 * Standard sandbox for developer and fixer agents.
 * Allows writes within the repo and /tmp only.
 */
export function createSandboxConfig(repoDir: string): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [
        `${repoDir}/**`,
        "/tmp/**",
        ...getPackageManagerPaths(),
      ],
      denyWrite: getDenyWritePaths(),
      denyRead: getDenyReadPaths(),
    },
    network: {
      allowedDomains: [
        "api.anthropic.com",
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "mcp.notion.com",
      ],
      allowLocalBinding: true,
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
      denyRead: getDenyReadPaths(),
    },
    network: {
      allowedDomains: ["registry.npmjs.org"],
    },
  };
}
