import { describe, expect, it } from "vitest";
import { modelsConfigSchema, neoConfigSchema, supervisorConfigSchema } from "@/config/schema";

describe("supervisor config", () => {
  it("defaults model to claude-sonnet-4-6", () => {
    const result = supervisorConfigSchema.parse({});
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("accepts an explicit model string", () => {
    const result = supervisorConfigSchema.parse({ model: "claude-opus-4-6" });
    expect(result.model).toBe("claude-opus-4-6");
  });
});

describe("modelsConfigSchema", () => {
  it("parses valid models config", () => {
    const config = neoConfigSchema.parse({ models: { default: "claude-sonnet-4-6" } });
    expect(config.models.default).toBe("claude-sonnet-4-6");
  });

  it("uses default when models not specified", () => {
    const config = neoConfigSchema.parse({});
    expect(config.models.default).toBe("claude-sonnet-4-6");
  });

  it("parses modelsConfigSchema directly", () => {
    const result = modelsConfigSchema.parse({ default: "claude-opus-4-6" });
    expect(result.default).toBe("claude-opus-4-6");
  });

  it("applies default when called with undefined", () => {
    const result = modelsConfigSchema.parse(undefined);
    expect(result.default).toBe("claude-sonnet-4-6");
  });
});
