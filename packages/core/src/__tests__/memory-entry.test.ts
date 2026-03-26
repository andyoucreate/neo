import { describe, expect, it } from "vitest";
import {
  memoryEntrySchema,
  memoryTypeSchema,
  memoryWriteInputSchema,
} from "@/supervisor/memory/entry";

describe("memoryTypeSchema", () => {
  it("accepts new types: knowledge, warning, focus", () => {
    expect(memoryTypeSchema.parse("knowledge")).toBe("knowledge");
    expect(memoryTypeSchema.parse("warning")).toBe("warning");
    expect(memoryTypeSchema.parse("focus")).toBe("focus");
  });

  it("rejects old types: fact, procedure, episode, feedback, task", () => {
    expect(() => memoryTypeSchema.parse("fact")).toThrow();
    expect(() => memoryTypeSchema.parse("procedure")).toThrow();
    expect(() => memoryTypeSchema.parse("episode")).toThrow();
    expect(() => memoryTypeSchema.parse("feedback")).toThrow();
    expect(() => memoryTypeSchema.parse("task")).toThrow();
  });
});

describe("memoryWriteInputSchema", () => {
  it("accepts subtype for knowledge entries", () => {
    const input = {
      type: "knowledge",
      content: "Test content",
      subtype: "fact",
    };
    const result = memoryWriteInputSchema.parse(input);
    expect(result.subtype).toBe("fact");
  });

  it("accepts subtype procedure for knowledge entries", () => {
    const input = {
      type: "knowledge",
      content: "Test content",
      subtype: "procedure",
    };
    const result = memoryWriteInputSchema.parse(input);
    expect(result.subtype).toBe("procedure");
  });
});

describe("memoryEntrySchema", () => {
  it("includes optional subtype field", () => {
    const entry = {
      id: "mem_abc123",
      type: "knowledge",
      scope: "global",
      content: "Test",
      source: "user",
      tags: [],
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      subtype: "fact",
    };
    const result = memoryEntrySchema.parse(entry);
    expect(result.subtype).toBe("fact");
  });

  it("does not require supersedes field", () => {
    const entry = {
      id: "mem_abc123",
      type: "knowledge",
      scope: "global",
      content: "Test",
      source: "user",
      tags: [],
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
    };
    const result = memoryEntrySchema.parse(entry);
    expect(result.supersedes).toBeUndefined();
  });
});
