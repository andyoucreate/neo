import { describe, it, expect } from "vitest";
import { sanitize } from "../sanitize.js";

function validTicket(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "PROJ-42",
    title: "Add dark mode toggle",
    type: "feature",
    priority: "medium",
    complexity: 3,
    criteria: "User can toggle dark mode from settings",
    description: "Implement dark mode with persistent preference",
    repository: "github.com/org/my-app",
    ...overrides,
  };
}

describe("sanitize", () => {
  describe("valid input", () => {
    it("should return a SanitizedTicket for valid input", () => {
      const result = sanitize(validTicket());
      expect(result).not.toBe("quarantined");
      if (result === "quarantined") return;

      expect(result.ticketId).toBe("PROJ-42");
      expect(result.title).toBe("Add dark mode toggle");
      expect(result.type).toBe("feature");
      expect(result.priority).toBe("medium");
      expect(result.complexity).toBe(3);
    });

    it("should accept all valid ticket types", () => {
      for (const type of ["feature", "bug", "refactor", "chore"]) {
        const result = sanitize(validTicket({ type }));
        expect(result).not.toBe("quarantined");
      }
    });

    it("should accept all valid priorities", () => {
      for (const priority of ["critical", "high", "medium", "low"]) {
        const result = sanitize(validTicket({ priority }));
        expect(result).not.toBe("quarantined");
      }
    });

    it("should accept all valid complexity points", () => {
      for (const complexity of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]) {
        const result = sanitize(validTicket({ complexity }));
        expect(result).not.toBe("quarantined");
        if (result === "quarantined") return;
        expect(result.complexity).toBe(complexity);
      }
    });

    it("should default complexity to 3 if missing", () => {
      const result = sanitize(validTicket({ complexity: undefined }));
      expect(result).not.toBe("quarantined");
      if (result === "quarantined") return;
      expect(result.complexity).toBe(3);
    });

    it("should accept full GitHub URL for repository", () => {
      const result = sanitize(
        validTicket({ repository: "https://github.com/org/my-app" }),
      );
      expect(result).not.toBe("quarantined");
      if (result === "quarantined") return;
      expect(result.repository).toBe("github.com/org/my-app");
    });

    it("should accept org/repo shorthand and normalize it", () => {
      const result = sanitize(validTicket({ repository: "org/my-app" }));
      expect(result).not.toBe("quarantined");
      if (result === "quarantined") return;
      expect(result.repository).toBe("github.com/org/my-app");
    });
  });

  describe("truncation", () => {
    it("should truncate long titles", () => {
      const longTitle = "A".repeat(300);
      const result = sanitize(validTicket({ title: longTitle }));
      expect(result).not.toBe("quarantined");
      if (result === "quarantined") return;
      expect(result.title.length).toBeLessThanOrEqual(200);
    });

    it("should truncate long descriptions", () => {
      const longDesc = "B".repeat(5_000);
      const result = sanitize(validTicket({ description: longDesc }));
      expect(result).not.toBe("quarantined");
      if (result === "quarantined") return;
      expect(result.description.length).toBeLessThanOrEqual(2_000);
    });
  });

  describe("quarantine — missing required fields", () => {
    it("should quarantine when ticketId is missing", () => {
      expect(sanitize({ title: "test", type: "feature", priority: "low", repository: "github.com/org/repo" })).toBe("quarantined");
    });

    it("should quarantine when title is empty", () => {
      expect(sanitize(validTicket({ title: "" }))).toBe("quarantined");
    });

    it("should quarantine when type is invalid", () => {
      expect(sanitize(validTicket({ type: "invalid" }))).toBe("quarantined");
    });

    it("should quarantine when repository format is invalid", () => {
      expect(sanitize(validTicket({ repository: "not-a-repo" }))).toBe("quarantined");
    });
  });
});
