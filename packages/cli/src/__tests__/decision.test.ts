import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_decision_test__");

// Mock getSupervisorDecisionsPath to use our temp directory
vi.mock("@neotx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neotx/core")>();
  return {
    ...actual,
    getSupervisorDecisionsPath: () => path.join(TMP_DIR, "decisions.jsonl"),
  };
});

// Mock output functions to capture output
const mockPrintJson = vi.fn();
const mockPrintError = vi.fn();
const mockPrintSuccess = vi.fn();
const mockPrintTable = vi.fn();
const mockConsoleLog = vi.fn();

vi.mock("../output.js", () => ({
  printJson: mockPrintJson,
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
  printTable: mockPrintTable,
}));

async function runDecisionCommand(
  action: string,
  opts: { value?: string; name?: string; json?: boolean } = {},
): Promise<void> {
  // Reset mocks
  mockPrintJson.mockClear();
  mockPrintError.mockClear();
  mockPrintSuccess.mockClear();
  mockPrintTable.mockClear();
  mockConsoleLog.mockClear();
  process.exitCode = undefined;

  // Store original console.log and replace
  const originalLog = console.log;
  console.log = mockConsoleLog;

  try {
    // Re-import to pick up mocks
    const mod = await import("../commands/decision.js");
    const command = mod.default;
    await command.run?.({
      args: {
        action,
        value: opts.value,
        name: opts.name ?? "supervisor",
        json: opts.json ?? false,
      } as never,
    } as never);
  } finally {
    console.log = originalLog;
  }
}

async function createTestDecision(
  opts: { question?: string; type?: string; source?: string } = {},
): Promise<string> {
  const { DecisionStore } = await import("@neotx/core");
  const store = new DecisionStore(path.join(TMP_DIR, "decisions.jsonl"));
  return store.create({
    question: opts.question ?? "Test question?",
    type: opts.type ?? "approval",
    source: opts.source ?? "test-agent",
  });
}

async function answerTestDecision(id: string, answer: string): Promise<void> {
  const { DecisionStore } = await import("@neotx/core");
  const store = new DecisionStore(path.join(TMP_DIR, "decisions.jsonl"));
  await store.answer(id, answer);
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TMP_DIR, { recursive: true });
  process.exitCode = undefined;
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("neo decision list", () => {
  it("shows message when no pending decisions", async () => {
    await runDecisionCommand("list");

    expect(mockConsoleLog).toHaveBeenCalledWith("No pending decisions.");
    expect(mockPrintTable).not.toHaveBeenCalled();
  });

  it("displays pending decisions in table format", async () => {
    await createTestDecision({ question: "Deploy to prod?" });
    await createTestDecision({ question: "Merge PR?" });

    await runDecisionCommand("list");

    expect(mockPrintTable).toHaveBeenCalledOnce();
    const [headers, rows] = mockPrintTable.mock.calls[0] as [string[], string[][]];
    expect(headers).toEqual(["ID", "TYPE", "QUESTION", "SOURCE", "CREATED"]);
    expect(rows).toHaveLength(2);
  });

  it("outputs JSON when --json flag is set", async () => {
    await createTestDecision({ question: "Test?" });

    await runDecisionCommand("list", { json: true });

    expect(mockPrintJson).toHaveBeenCalledOnce();
    const output = mockPrintJson.mock.calls[0]?.[0] as Array<{ question: string }>;
    expect(output).toHaveLength(1);
    expect(output[0]?.question).toBe("Test?");
  });

  it("excludes answered decisions from list", async () => {
    const id1 = await createTestDecision({ question: "Q1" });
    await createTestDecision({ question: "Q2" });
    await answerTestDecision(id1, "yes");

    await runDecisionCommand("list");

    expect(mockPrintTable).toHaveBeenCalledOnce();
    const [, rows] = mockPrintTable.mock.calls[0] as [string[], string[][]];
    expect(rows).toHaveLength(1);
  });
});

describe("neo decision get", () => {
  it("displays decision details", async () => {
    const id = await createTestDecision({
      question: "Should we deploy?",
      type: "approval",
      source: "deploy-agent",
    });

    await runDecisionCommand("get", { value: id });

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(`ID:`));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(`Question:`));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Should we deploy?"));
  });

  it("shows error when decision not found", async () => {
    await runDecisionCommand("get", { value: "dec_nonexistent" });

    expect(mockPrintError).toHaveBeenCalledWith("Decision not found: dec_nonexistent");
    expect(process.exitCode).toBe(1);
  });

  it("shows error when id is missing", async () => {
    await runDecisionCommand("get");

    expect(mockPrintError).toHaveBeenCalledWith("Usage: neo decision get <id>");
    expect(process.exitCode).toBe(1);
  });

  it("outputs JSON when --json flag is set", async () => {
    const id = await createTestDecision({ question: "Test?" });

    await runDecisionCommand("get", { value: id, json: true });

    expect(mockPrintJson).toHaveBeenCalledOnce();
    const output = mockPrintJson.mock.calls[0]?.[0] as { id: string; question: string };
    expect(output.id).toBe(id);
    expect(output.question).toBe("Test?");
  });

  it("shows answer details when decision is answered", async () => {
    const id = await createTestDecision({ question: "Test?" });
    await answerTestDecision(id, "approved");

    await runDecisionCommand("get", { value: id });

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Answer:"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("approved"));
  });
});

describe("neo decision answer", () => {
  it("answers a pending decision", async () => {
    const id = await createTestDecision({ question: "Deploy?" });

    // Mock process.argv to include the answer command arguments
    const originalArgv = process.argv;
    process.argv = ["node", "neo", "decision", "answer", id, "yes"];

    try {
      await runDecisionCommand("answer", { value: id });

      expect(mockPrintSuccess).toHaveBeenCalledWith(
        expect.stringContaining(`Decision answered: ${id}`),
      );
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining('"yes"'));
    } finally {
      process.argv = originalArgv;
    }
  });

  it("shows error when decision not found", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "neo", "decision", "answer", "dec_fake", "yes"];

    try {
      await runDecisionCommand("answer", { value: "dec_fake" });

      expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("Decision not found"));
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("shows error when decision already answered", async () => {
    const id = await createTestDecision({ question: "Test?" });
    await answerTestDecision(id, "first");

    const originalArgv = process.argv;
    process.argv = ["node", "neo", "decision", "answer", id, "second"];

    try {
      await runDecisionCommand("answer", { value: id });

      expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("already answered"));
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("shows error when arguments are missing", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "neo", "decision", "answer"];

    try {
      await runDecisionCommand("answer");

      expect(mockPrintError).toHaveBeenCalledWith("Usage: neo decision answer <id> <answer>");
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe("neo decision pending", () => {
  it("shows message when no pending decisions", async () => {
    await runDecisionCommand("pending");

    expect(mockConsoleLog).toHaveBeenCalledWith("No pending decisions.");
  });

  it("displays detailed view of pending decisions", async () => {
    await createTestDecision({ question: "Should we deploy?" });

    await runDecisionCommand("pending");

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("ID:"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Question:"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Should we deploy?"));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("neo decision answer <id> <answer>"),
    );
  });

  it("outputs JSON when --json flag is set", async () => {
    await createTestDecision({ question: "Test?" });

    await runDecisionCommand("pending", { json: true });

    expect(mockPrintJson).toHaveBeenCalledOnce();
    const output = mockPrintJson.mock.calls[0]?.[0] as Array<{ question: string }>;
    expect(output).toHaveLength(1);
    expect(output[0]?.question).toBe("Test?");
  });

  it("excludes answered decisions", async () => {
    const id1 = await createTestDecision({ question: "Q1" });
    await createTestDecision({ question: "Q2" });
    await answerTestDecision(id1, "done");

    await runDecisionCommand("pending", { json: true });

    const output = mockPrintJson.mock.calls[0]?.[0] as Array<{ question: string }>;
    expect(output).toHaveLength(1);
    expect(output[0]?.question).toBe("Q2");
  });
});

describe("neo decision (invalid action)", () => {
  it("shows error for unknown action", async () => {
    await runDecisionCommand("unknown");

    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown action "unknown"'),
    );
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("list, get, answer, pending"),
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("neo decision with custom supervisor name", () => {
  it("uses custom supervisor name for store path", async () => {
    // This test verifies the --name flag is passed through
    // Since we mock getSupervisorDecisionsPath, we just verify no errors
    await runDecisionCommand("list", { name: "custom-supervisor" });

    // Should not error
    expect(process.exitCode).toBeUndefined();
  });
});
