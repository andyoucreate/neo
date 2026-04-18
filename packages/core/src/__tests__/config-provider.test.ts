import { describe, expect, it } from "vitest";
import { providerConfigSchema, supervisorConfigSchema } from "@/config/schema";

describe("supervisor config adapter field", () => {
  it("defaults adapter to undefined", () => {
    const result = supervisorConfigSchema.parse({});
    expect(result.adapter).toBeUndefined();
  });

  it("accepts an explicit adapter string", () => {
    const result = supervisorConfigSchema.parse({ adapter: "codex" });
    expect(result.adapter).toBe("codex");
  });
});

describe("providerConfigSchema", () => {
  it("parses valid provider config", () => {
    const result = providerConfigSchema.parse({
      adapter: "claude",
      models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
    });
    expect(result.adapter).toBe("claude");
    expect(result.args).toEqual([]);
    expect(result.env).toEqual({});
  });

  it("rejects models.default not in models.available", () => {
    expect(() =>
      providerConfigSchema.parse({
        adapter: "claude",
        models: { default: "gpt-4o", available: ["claude-sonnet-4-6"] },
      }),
    ).toThrow("models.default must be in models.available");
  });
});
