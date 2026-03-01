import { describe, it, expect } from "vitest";
import { agents } from "../agents.js";

const EXPECTED_AGENTS = [
  "architect",
  "developer",
  "reviewer-quality",
  "reviewer-security",
  "reviewer-perf",
  "reviewer-coverage",
  "qa-playwright",
  "fixer",
] as const;

const READ_ONLY_AGENTS = [
  "architect",
  "reviewer-quality",
  "reviewer-perf",
  "reviewer-coverage",
];

const WRITABLE_AGENTS = ["developer", "fixer", "qa-playwright"];

const VALID_MODELS = ["opus", "sonnet"];

describe("agents", () => {
  it("defines all 8 expected agents", () => {
    const agentNames = Object.keys(agents).sort();
    expect(agentNames).toEqual([...EXPECTED_AGENTS].sort());
  });

  describe.each(EXPECTED_AGENTS)("%s", (name) => {
    it("has a non-empty description", () => {
      expect(agents[name].description).toBeTruthy();
      expect(agents[name].description.length).toBeGreaterThan(0);
    });

    it("has a non-empty prompt", () => {
      expect(agents[name].prompt).toBeTruthy();
      expect(agents[name].prompt.length).toBeGreaterThan(0);
    });

    it("has at least one tool", () => {
      expect(agents[name].tools.length).toBeGreaterThanOrEqual(1);
    });

    it("has a valid model", () => {
      expect(VALID_MODELS).toContain(agents[name].model);
    });
  });

  describe("read-only agents do NOT have Write or Edit tools", () => {
    it.each(READ_ONLY_AGENTS)("%s has no Write or Edit tool", (name) => {
      expect(agents[name].tools).not.toContain("Write");
      expect(agents[name].tools).not.toContain("Edit");
    });
  });

  describe("writable agents have Write or Edit tools", () => {
    it.each(WRITABLE_AGENTS)("%s has Write or Edit tool", (name) => {
      const hasWrite = agents[name].tools.includes("Write");
      const hasEdit = agents[name].tools.includes("Edit");
      expect(hasWrite || hasEdit).toBe(true);
    });
  });

  it("reviewer-security has Bash for running audits", () => {
    expect(agents["reviewer-security"].tools).toContain("Bash");
  });
});
