import { describe, expect, it } from "vitest";
import { getAdapter, listModels, MODEL_ALIASES, resolveModel, SUPPORTED_MODELS } from "@/models";

describe("SUPPORTED_MODELS", () => {
  it("contains claude models", () => {
    expect(SUPPORTED_MODELS["claude-sonnet-4-6"]).toBe("claude");
    expect(SUPPORTED_MODELS["claude-opus-4-7"]).toBe("claude");
    expect(SUPPORTED_MODELS["claude-opus-4-6"]).toBe("claude");
    expect(SUPPORTED_MODELS["claude-haiku-4-5"]).toBe("claude");
  });

  it("contains codex models", () => {
    expect(SUPPORTED_MODELS["gpt-5.4"]).toBe("codex");
    expect(SUPPORTED_MODELS["gpt-5.4-mini"]).toBe("codex");
  });
});

describe("MODEL_ALIASES", () => {
  it("maps short names to canonical IDs", () => {
    expect(MODEL_ALIASES.opus).toBe("claude-opus-4-7");
    expect(MODEL_ALIASES.sonnet).toBe("claude-sonnet-4-6");
    expect(MODEL_ALIASES.haiku).toBe("claude-haiku-4-5");
  });
});

describe("resolveModel", () => {
  it("resolves aliases to canonical model ID", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-7");
    expect(resolveModel("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("returns non-alias model as-is", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModel("gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("getAdapter", () => {
  it("returns claude for claude models", () => {
    expect(getAdapter("claude-sonnet-4-6")).toBe("claude");
    expect(getAdapter("claude-opus-4-7")).toBe("claude");
  });

  it("returns codex for codex models", () => {
    expect(getAdapter("gpt-5.4")).toBe("codex");
    expect(getAdapter("gpt-5.4-mini")).toBe("codex");
  });

  it("resolves aliases before lookup", () => {
    expect(getAdapter("opus")).toBe("claude");
    expect(getAdapter("sonnet")).toBe("claude");
  });

  it("throws for unknown model", () => {
    expect(() => getAdapter("unknown-model")).toThrow('Unknown model "unknown-model"');
  });
});

describe("listModels", () => {
  it("returns all supported model IDs", () => {
    const models = listModels();
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("gpt-5.4");
    expect(models.length).toBeGreaterThanOrEqual(6);
  });
});
