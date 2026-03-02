import { describe, expect, it } from "vitest";
import {
  createSandboxConfig,
  createReadonlySandboxConfig,
} from "../sandbox.js";

describe("Sandbox Configuration", () => {
  describe("createSandboxConfig (read-write)", () => {
    it("should enable sandbox", () => {
      const config = createSandboxConfig("/home/voltaire/repos/org/repo");
      expect(config.enabled).toBe(true);
    });

    it("should auto-allow bash when sandboxed", () => {
      const config = createSandboxConfig("/home/voltaire/repos/org/repo");
      expect(config.autoAllowBashIfSandboxed).toBe(true);
    });

    it("should allow writes to repo directory", () => {
      const config = createSandboxConfig("/home/voltaire/repos/org/repo");
      expect(config.filesystem?.allowWrite).toContain(
        "/home/voltaire/repos/org/repo/**",
      );
    });

    it("should allow writes to /tmp", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.filesystem?.allowWrite).toContain("/tmp/**");
    });

    it("should deny writes to system directories", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.filesystem?.denyWrite).toContain("/opt/voltaire/.env");
      expect(config.filesystem?.denyWrite).toContain("/opt/voltaire/dispatch-service/**");
      expect(config.filesystem?.denyWrite).toContain("/etc/**");
    });

    it("should deny reads to secrets", () => {
      const config = createSandboxConfig("/any/path");
      expect(config.filesystem?.denyRead).toContain("/opt/voltaire/.env");
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

    it("should deny reads to secrets", () => {
      const config = createReadonlySandboxConfig("/any/path");
      expect(config.filesystem?.denyRead).toContain("/opt/voltaire/.env");
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
