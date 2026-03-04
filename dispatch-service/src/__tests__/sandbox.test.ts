import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createSandboxConfig,
  createReadonlySandboxConfig,
} from "../sandbox.js";

const IS_DARWIN = process.platform === "darwin";
const HOME = homedir();

describe("Sandbox Configuration", () => {
  describe("createSandboxConfig (read-write)", () => {
    it("should enable sandbox", () => {
      const config = createSandboxConfig("/tmp/repo");
      expect(config.enabled).toBe(true);
    });

    it("should auto-allow bash when sandboxed", () => {
      const config = createSandboxConfig("/tmp/repo");
      expect(config.autoAllowBashIfSandboxed).toBe(true);
    });

    it("should allow writes to repo directory", () => {
      const config = createSandboxConfig("/tmp/repo");
      expect(config.filesystem?.allowWrite).toContain("/tmp/repo/**");
    });

    it("should allow writes to /tmp", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.filesystem?.allowWrite).toContain("/tmp/**");
    });

    it("should include package manager paths for current platform", () => {
      const config = createSandboxConfig("/any/path");
      const allowWrite = config.filesystem?.allowWrite ?? [];

      if (IS_DARWIN) {
        expect(allowWrite).toContain(`${HOME}/Library/pnpm/**`);
        expect(allowWrite).toContain(`${HOME}/Library/Caches/**`);
      } else {
        expect(allowWrite).toContain(`${HOME}/.local/share/pnpm/**`);
        expect(allowWrite).toContain(`${HOME}/.cache/**`);
      }
    });

    it("should deny writes to /etc on all platforms", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.filesystem?.denyWrite).toContain("/etc/**");
    });

    it("should deny writes to production paths on Linux only", () => {
      const config = createSandboxConfig("/any/path");
      const denyWrite = config.filesystem?.denyWrite ?? [];

      if (IS_DARWIN) {
        expect(denyWrite).not.toContain("/opt/voltaire/.env");
      } else {
        expect(denyWrite).toContain("/opt/voltaire/.env");
        expect(denyWrite).toContain("/opt/voltaire/dispatch-service/**");
      }
    });

    it("should deny reads to secrets on Linux only", () => {
      const config = createSandboxConfig("/any/path");
      const denyRead = config.filesystem?.denyRead ?? [];

      if (IS_DARWIN) {
        expect(denyRead).toHaveLength(0);
      } else {
        expect(denyRead).toContain("/opt/voltaire/.env");
      }
    });

    it("should allow essential network domains", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.network?.allowedDomains).toContain("api.anthropic.com");
      expect(config.network?.allowedDomains).toContain("github.com");
      expect(config.network?.allowedDomains).toContain("registry.npmjs.org");
    });

    it("should allow local binding for preview servers", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.network?.allowLocalBinding).toBe(true);
    });
  });

  describe("createReadonlySandboxConfig (reviews)", () => {
    it("should enable sandbox", () => {
      const config = createReadonlySandboxConfig("/any/path");
      expect(config.enabled).toBe(true);
    });

    it("should have empty allowWrite", () => {
      const config = createReadonlySandboxConfig("/any/path");
      expect(config.filesystem?.allowWrite).toEqual([]);
    });

    it("should deny all writes", () => {
      const config = createReadonlySandboxConfig("/any/path");
      expect(config.filesystem?.denyWrite).toContain("**/*");
    });

    it("should deny reads to secrets on Linux only", () => {
      const config = createReadonlySandboxConfig("/any/path");
      const denyRead = config.filesystem?.denyRead ?? [];

      if (IS_DARWIN) {
        expect(denyRead).toHaveLength(0);
      } else {
        expect(denyRead).toContain("/opt/voltaire/.env");
      }
    });

    it("should only allow npm registry for pnpm audit", () => {
      const config = createReadonlySandboxConfig("/any/path");
      expect(config.network?.allowedDomains).toEqual(["registry.npmjs.org"]);
    });

    it("should not allow local binding", () => {
      const config = createReadonlySandboxConfig("/any/path");
      expect(config.network?.allowLocalBinding).toBeUndefined();
    });
  });
});
