import { describe, expect, it } from "vitest";
import { parseChildCommand, parseChildSpawnCommand } from "./child-command-parser.js";

describe("parseChildCommand", () => {
  it("parses child:inject", () => {
    const result = parseChildCommand("child:inject sup-123 please add auth context");
    expect(result).toEqual({
      type: "inject",
      supervisorId: "sup-123",
      context: "please add auth context",
    });
  });

  it("parses child:unblock", () => {
    const result = parseChildCommand("child:unblock sup-456 use option B");
    expect(result).toEqual({
      type: "unblock",
      supervisorId: "sup-456",
      answer: "use option B",
    });
  });

  it("parses child:stop", () => {
    const result = parseChildCommand("child:stop sup-789");
    expect(result).toEqual({ type: "stop", supervisorId: "sup-789" });
  });

  it("returns null for non-child messages", () => {
    expect(parseChildCommand("decision:answer abc yes")).toBeNull();
    expect(parseChildCommand("hello world")).toBeNull();
    expect(parseChildCommand("child:unknown foo bar")).toBeNull();
  });

  it("returns null for child:inject without context", () => {
    expect(parseChildCommand("child:inject sup-123")).toBeNull();
  });

  it("returns null for child:unblock without answer", () => {
    expect(parseChildCommand("child:unblock sup-123")).toBeNull();
  });

  it("returns null for child:stop without supervisorId", () => {
    expect(parseChildCommand("child:stop")).toBeNull();
  });
});

describe("parseChildSpawnCommand", () => {
  it("parses valid spawn command", () => {
    const input = 'child:spawn {"objective":"Do X","acceptanceCriteria":["Done"]}';
    const result = parseChildSpawnCommand(input);
    expect(result).toEqual({
      objective: "Do X",
      acceptanceCriteria: ["Done"],
      maxCostUsd: undefined,
    });
  });

  it("parses spawn with budget", () => {
    const input = 'child:spawn {"objective":"Y","acceptanceCriteria":["A","B"],"maxCostUsd":5.5}';
    const result = parseChildSpawnCommand(input);
    expect(result?.maxCostUsd).toBe(5.5);
  });

  it("returns null for non-spawn commands", () => {
    expect(parseChildSpawnCommand("child:inject foo bar")).toBeNull();
    expect(parseChildSpawnCommand("random text")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseChildSpawnCommand("child:spawn {invalid}")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    expect(parseChildSpawnCommand('child:spawn {"objective":"X"}')).toBeNull();
    expect(parseChildSpawnCommand('child:spawn {"acceptanceCriteria":["Y"]}')).toBeNull();
  });
});
