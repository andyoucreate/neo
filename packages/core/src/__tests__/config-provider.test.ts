import { describe, expect, it } from "vitest";
import { supervisorConfigSchema } from "@/config/schema";

describe("supervisor config provider field", () => {
  it("defaults to claude", () => {
    const result = supervisorConfigSchema.parse({});
    expect(result.provider).toBe("claude");
  });

  it("accepts codex provider", () => {
    const result = supervisorConfigSchema.parse({ provider: "codex" });
    expect(result.provider).toBe("codex");
  });

  it("rejects unknown provider", () => {
    expect(() => supervisorConfigSchema.parse({ provider: "gemini" })).toThrow();
  });
});
