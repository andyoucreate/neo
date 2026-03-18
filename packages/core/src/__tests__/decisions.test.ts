import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DecisionInput, DecisionStore } from "@/supervisor/decisions";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_decisions_test__");
const TEST_FILE = path.join(TMP_DIR, "decisions.jsonl");

function makeDecision(overrides?: Partial<DecisionInput>): DecisionInput {
  return {
    question: "Should we deploy?",
    type: "approval",
    source: "agent-1",
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("DecisionStore", () => {
  describe("create", () => {
    it("creates a decision and returns an ID", async () => {
      const store = new DecisionStore(TEST_FILE);

      const id = await store.create(makeDecision());

      expect(id).toMatch(/^dec_[a-f0-9]{16,}$/);
    });

    it("persists decision to JSONL file", async () => {
      const store = new DecisionStore(TEST_FILE);

      await store.create(makeDecision({ question: "Deploy to prod?" }));

      const content = await readFile(TEST_FILE, "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.question).toBe("Deploy to prod?");
      expect(parsed.createdAt).toBeDefined();
    });

    it("appends multiple decisions", async () => {
      const store = new DecisionStore(TEST_FILE);

      await store.create(makeDecision({ question: "Q1" }));
      await store.create(makeDecision({ question: "Q2" }));

      const content = await readFile(TEST_FILE, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
    });

    it("creates directory if it does not exist", async () => {
      const deepPath = path.join(TMP_DIR, "deep", "nested", "decisions.jsonl");
      const store = new DecisionStore(deepPath);

      const id = await store.create(makeDecision());

      expect(id).toBeDefined();
      const content = await readFile(deepPath, "utf-8");
      expect(content).toContain("Should we deploy?");
    });

    it("preserves optional fields", async () => {
      const store = new DecisionStore(TEST_FILE);

      await store.create(
        makeDecision({
          context: "Production environment",
          options: [
            { key: "yes", label: "Yes" },
            { key: "no", label: "No" },
          ],
          metadata: { env: "prod" },
          expiresAt: "2026-12-31T23:59:59.000Z",
          defaultAnswer: "no",
        }),
      );

      const pendingDecisions = await store.pending();
      const decision = await store.get(pendingDecisions[0]?.id ?? "");
      expect(decision?.context).toBe("Production environment");
      expect(decision?.options).toHaveLength(2);
      expect(decision?.metadata).toEqual({ env: "prod" });
      expect(decision?.expiresAt).toBe("2026-12-31T23:59:59.000Z");
      expect(decision?.defaultAnswer).toBe("no");
    });
  });

  describe("answer", () => {
    it("answers a pending decision", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create(makeDecision());

      await store.answer(id, "yes");

      const decision = await store.get(id);
      expect(decision?.answer).toBe("yes");
      expect(decision?.answeredAt).toBeDefined();
    });

    it("throws when decision is not found", async () => {
      const store = new DecisionStore(TEST_FILE);

      await expect(store.answer("dec_nonexistent", "yes")).rejects.toThrow("Decision not found");
    });

    it("throws when decision is already answered", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create(makeDecision());
      await store.answer(id, "yes");

      await expect(store.answer(id, "no")).rejects.toThrow("Decision already answered");
    });

    it("persists answer to file", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create(makeDecision());

      await store.answer(id, "approved");

      const content = await readFile(TEST_FILE, "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.answer).toBe("approved");
    });

    it("only updates the targeted decision", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id1 = await store.create(makeDecision({ question: "Q1" }));
      const id2 = await store.create(makeDecision({ question: "Q2" }));

      await store.answer(id1, "yes");

      const d1 = await store.get(id1);
      const d2 = await store.get(id2);
      expect(d1?.answer).toBe("yes");
      expect(d2?.answer).toBeUndefined();
    });
  });

  describe("pending", () => {
    it("returns unanswered decisions", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(makeDecision({ question: "Q1" }));
      await store.create(makeDecision({ question: "Q2" }));

      const pending = await store.pending();

      expect(pending).toHaveLength(2);
    });

    it("excludes answered decisions", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id1 = await store.create(makeDecision({ question: "Q1" }));
      await store.create(makeDecision({ question: "Q2" }));
      await store.answer(id1, "yes");

      const pending = await store.pending();

      expect(pending).toHaveLength(1);
      expect(pending[0]?.question).toBe("Q2");
    });

    it("excludes expired decisions", async () => {
      const store = new DecisionStore(TEST_FILE);
      // Past expiration
      await store.create(
        makeDecision({
          question: "Expired",
          expiresAt: "2020-01-01T00:00:00.000Z",
          defaultAnswer: "auto",
        }),
      );
      // Future expiration
      await store.create(
        makeDecision({
          question: "Valid",
          expiresAt: "2099-12-31T23:59:59.000Z",
        }),
      );

      const pending = await store.pending();

      expect(pending).toHaveLength(1);
      expect(pending[0]?.question).toBe("Valid");
    });

    it("returns empty array for empty store", async () => {
      const store = new DecisionStore(TEST_FILE);

      const pending = await store.pending();

      expect(pending).toEqual([]);
    });
  });

  describe("answered", () => {
    it("returns answered decisions", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id1 = await store.create(makeDecision({ question: "Q1" }));
      await store.create(makeDecision({ question: "Q2" }));
      await store.answer(id1, "yes");

      const answered = await store.answered();

      expect(answered).toHaveLength(1);
      expect(answered[0]?.question).toBe("Q1");
    });

    it("filters by since timestamp", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id1 = await store.create(makeDecision({ question: "Q1" }));
      await store.answer(id1, "yes");

      // Mock time for second answer
      const futureTime = "2099-01-01T00:00:00.000Z";
      await store.create(makeDecision({ question: "Q2" }));

      // Manually update file to simulate different answeredAt times
      const decisions = JSON.parse(
        `[${(await readFile(TEST_FILE, "utf-8")).trim().split("\n").join(",")}]`,
      );
      decisions[1].answer = "no";
      decisions[1].answeredAt = futureTime;
      await writeFile(
        TEST_FILE,
        `${decisions.map((d: unknown) => JSON.stringify(d)).join("\n")}\n`,
      );

      const answered = await store.answered("2050-01-01T00:00:00.000Z");

      expect(answered).toHaveLength(1);
      expect(answered[0]?.question).toBe("Q2");
    });

    it("returns empty array when no decisions are answered", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(makeDecision());

      const answered = await store.answered();

      expect(answered).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns decision by ID", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create(makeDecision({ question: "Find me" }));

      const decision = await store.get(id);

      expect(decision?.question).toBe("Find me");
      expect(decision?.id).toBe(id);
    });

    it("returns null for non-existent ID", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(makeDecision());

      const decision = await store.get("dec_nonexistent");

      expect(decision).toBeNull();
    });

    it("returns null for empty store", async () => {
      const store = new DecisionStore(TEST_FILE);

      const decision = await store.get("dec_any");

      expect(decision).toBeNull();
    });
  });

  describe("expire", () => {
    it("auto-answers expired decisions with defaultAnswer", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(
        makeDecision({
          question: "Auto-expire me",
          expiresAt: "2020-01-01T00:00:00.000Z",
          defaultAnswer: "timeout",
        }),
      );

      const expired = await store.expire();

      expect(expired).toHaveLength(1);
      expect(expired[0]?.answer).toBe("timeout");
      expect(expired[0]?.answeredAt).toBeDefined();

      const decision = await store.get(expired[0]?.id ?? "");
      expect(decision?.answer).toBe("timeout");
    });

    it("marks decisions without defaultAnswer as expired", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create(
        makeDecision({
          question: "No default",
          expiresAt: "2020-01-01T00:00:00.000Z",
          // No defaultAnswer - should be marked as expired, not stuck
        }),
      );

      const expired = await store.expire();

      expect(expired).toHaveLength(1);
      expect(expired[0]?.answer).toBeUndefined();
      expect(expired[0]?.expiredAt).toBeDefined();

      // Should not appear in pending
      const pending = await store.pending();
      expect(pending).toHaveLength(0);

      // Decision should have expiredAt set
      const decision = await store.get(id);
      expect(decision?.expiredAt).toBeDefined();
    });

    it("does not expire future decisions", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(
        makeDecision({
          question: "Future",
          expiresAt: "2099-12-31T23:59:59.000Z",
          defaultAnswer: "auto",
        }),
      );

      const expired = await store.expire();

      expect(expired).toEqual([]);
    });

    it("does not expire already answered decisions", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create(
        makeDecision({
          question: "Already answered",
          expiresAt: "2020-01-01T00:00:00.000Z",
          defaultAnswer: "auto",
        }),
      );
      await store.answer(id, "manual");

      const expired = await store.expire();

      expect(expired).toEqual([]);
      const decision = await store.get(id);
      expect(decision?.answer).toBe("manual");
    });

    it("handles concurrent expire calls safely", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(
        makeDecision({
          expiresAt: "2020-01-01T00:00:00.000Z",
          defaultAnswer: "auto",
        }),
      );

      // Run two expire calls concurrently
      const [result1, result2] = await Promise.all([store.expire(), store.expire()]);

      // One should expire it, the other should find nothing to expire
      const totalExpired = result1.length + result2.length;
      expect(totalExpired).toBeGreaterThanOrEqual(1);

      const pending = await store.pending();
      expect(pending).toHaveLength(0);
    });

    it("returns empty array for empty store", async () => {
      const store = new DecisionStore(TEST_FILE);

      const expired = await store.expire();

      expect(expired).toEqual([]);
    });

    it("expires multiple decisions in single call", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(
        makeDecision({
          question: "Q1",
          expiresAt: "2020-01-01T00:00:00.000Z",
          defaultAnswer: "auto1",
        }),
      );
      await store.create(
        makeDecision({
          question: "Q2",
          expiresAt: "2020-01-01T00:00:00.000Z",
          defaultAnswer: "auto2",
        }),
      );

      const expired = await store.expire();

      expect(expired).toHaveLength(2);
    });
  });

  describe("readAll (malformed JSONL handling)", () => {
    it("skips malformed lines silently", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(makeDecision({ question: "Valid" }));

      // Inject malformed line
      const content = await readFile(TEST_FILE, "utf-8");
      await writeFile(TEST_FILE, `${content}not valid json\n`, "utf-8");

      const pending = await store.pending();

      expect(pending).toHaveLength(1);
      expect(pending[0]?.question).toBe("Valid");
    });

    it("handles empty lines gracefully", async () => {
      const store = new DecisionStore(TEST_FILE);
      await store.create(makeDecision());

      const content = await readFile(TEST_FILE, "utf-8");
      await writeFile(TEST_FILE, `\n\n${content}\n\n`, "utf-8");

      const pending = await store.pending();

      expect(pending).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("handles decisions without optional fields", async () => {
      const store = new DecisionStore(TEST_FILE);
      const id = await store.create({
        question: "Minimal",
        type: "simple",
        source: "test",
      });

      const decision = await store.get(id);

      expect(decision?.question).toBe("Minimal");
      expect(decision?.context).toBeUndefined();
      expect(decision?.options).toBeUndefined();
      expect(decision?.expiresAt).toBeUndefined();
    });

    it("handles concurrent creates without data loss", async () => {
      const store = new DecisionStore(TEST_FILE);
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.create(makeDecision({ question: `Q${i}` })),
      );

      const ids = await Promise.all(promises);

      expect(new Set(ids).size).toBe(10); // All unique IDs
      const pending = await store.pending();
      expect(pending).toHaveLength(10);
    });
  });
});
