import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_directive_test__");

// Mock getSupervisorDir to use our temp directory
vi.mock("@neotx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neotx/core")>();
  return {
    ...actual,
    getSupervisorDir: () => TMP_DIR,
  };
});

// Mock output functions to capture output
const mockPrintError = vi.fn();
const mockPrintSuccess = vi.fn();
const mockPrintTable = vi.fn();
const mockConsoleLog = vi.fn();

vi.mock("../output.js", () => ({
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
  printTable: mockPrintTable,
}));

async function runDirectiveCommand(
  action: string,
  opts: {
    value?: string;
    trigger?: string;
    duration?: string;
    priority?: string;
    description?: string;
    name?: string;
  } = {},
): Promise<void> {
  // Reset mocks
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
    const mod = await import("../commands/directive.js");
    const command = mod.default;
    await command.run?.({
      args: {
        action,
        value: opts.value,
        trigger: opts.trigger ?? "idle",
        duration: opts.duration,
        priority: opts.priority ?? "0",
        description: opts.description,
        name: opts.name ?? "supervisor",
      } as never,
    } as never);
  } finally {
    console.log = originalLog;
  }
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

describe("neo directive create", () => {
  it("creates a directive with default trigger", async () => {
    await runDirectiveCommand("create", { value: "launch scout" });

    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining("Directive created:"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Trigger: idle"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Action: launch scout"));
  });

  it("creates a directive with time-bounded duration", async () => {
    await runDirectiveCommand("create", { value: "run tests", duration: "2h" });

    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining("Directive created:"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Duration:"));
  });

  it("creates a directive with priority", async () => {
    await runDirectiveCommand("create", { value: "check CI", priority: "10" });

    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining("Directive created:"));
  });

  it("shows error when action is missing", async () => {
    await runDirectiveCommand("create");

    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(process.exitCode).toBe(1);
  });

  it("shows error for invalid trigger", async () => {
    await runDirectiveCommand("create", { value: "test", trigger: "invalid" });

    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("Invalid trigger"));
    expect(process.exitCode).toBe(1);
  });

  it("shows error for invalid duration format", async () => {
    await runDirectiveCommand("create", { value: "test", duration: "xyz" });

    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("Invalid --duration"));
    expect(process.exitCode).toBe(1);
  });
});

describe("neo directive list", () => {
  it("shows message when no directives", async () => {
    await runDirectiveCommand("list");

    expect(mockConsoleLog).toHaveBeenCalledWith("No directives found.");
    expect(mockPrintTable).not.toHaveBeenCalled();
  });

  it("displays directives in table format", async () => {
    await runDirectiveCommand("create", { value: "action 1" });
    await runDirectiveCommand("create", { value: "action 2" });

    await runDirectiveCommand("list");

    expect(mockPrintTable).toHaveBeenCalledOnce();
    const [headers, rows] = mockPrintTable.mock.calls[0] as [string[], string[][]];
    expect(headers).toEqual(["ID", "TRIGGER", "STATUS", "EXPIRES", "PRIORITY", "ACTION"]);
    expect(rows).toHaveLength(2);
  });

  it("shows expired status for expired directives", async () => {
    // Create directive with past expiry (this is a manual test scenario)
    const { DirectiveStore } = await import("@neotx/core");
    const store = new DirectiveStore(path.join(TMP_DIR, "directives.jsonl"));
    await store.create({
      trigger: "idle",
      action: "expired action",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await runDirectiveCommand("list");

    expect(mockPrintTable).toHaveBeenCalledOnce();
    const [, rows] = mockPrintTable.mock.calls[0] as [string[], string[][]];
    expect(rows[0]).toContain("expired");
  });
});

function extractId(message: string): string {
  const match = message.match(/dir_[a-f0-9-]+/);
  if (!match) throw new Error(`No ID found in: ${message}`);
  return match[0];
}

describe("neo directive delete", () => {
  it("deletes a directive", async () => {
    // Create a directive first
    await runDirectiveCommand("create", { value: "to delete" });
    const successCall = mockPrintSuccess.mock.calls[0]?.[0] as string;
    const id = extractId(successCall);

    mockPrintSuccess.mockClear();
    await runDirectiveCommand("delete", { value: id });

    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining("Directive deleted:"));
  });

  it("shows error when id is missing", async () => {
    await runDirectiveCommand("delete");

    expect(mockPrintError).toHaveBeenCalledWith("Usage: neo directive delete <id>");
    expect(process.exitCode).toBe(1);
  });

  it("shows error when directive not found", async () => {
    await runDirectiveCommand("delete", { value: "dir_nonexistent" });

    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(process.exitCode).toBe(1);
  });
});

describe("neo directive toggle", () => {
  it("toggles a directive off", async () => {
    // Create a directive first
    await runDirectiveCommand("create", { value: "to toggle" });
    const successCall = mockPrintSuccess.mock.calls[0]?.[0] as string;
    const id = extractId(successCall);

    // Clear and toggle off
    mockPrintSuccess.mockClear();
    await runDirectiveCommand("toggle", { value: id });
    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("toggles a directive on after being disabled", async () => {
    // Create and disable
    await runDirectiveCommand("create", { value: "to toggle" });
    const successCall = mockPrintSuccess.mock.calls[0]?.[0] as string;
    const id = extractId(successCall);
    await runDirectiveCommand("toggle", { value: id }); // off

    // Clear and toggle on
    mockPrintSuccess.mockClear();
    await runDirectiveCommand("toggle", { value: id });
    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringContaining("enabled"));
  });

  it("shows error when id is missing", async () => {
    await runDirectiveCommand("toggle");

    expect(mockPrintError).toHaveBeenCalledWith("Usage: neo directive toggle <id>");
    expect(process.exitCode).toBe(1);
  });

  it("shows error when directive not found", async () => {
    await runDirectiveCommand("toggle", { value: "dir_nonexistent" });

    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(process.exitCode).toBe(1);
  });
});

describe("neo directive show", () => {
  it("displays directive details without error", async () => {
    await runDirectiveCommand("create", { value: "detailed action", description: "Test desc" });
    const successCall = mockPrintSuccess.mock.calls[0]?.[0] as string;
    const id = extractId(successCall);

    // Clear mocks and run show
    mockPrintError.mockClear();

    // Run show - should not error
    await runDirectiveCommand("show", { value: id });

    // No error should be printed
    expect(mockPrintError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("shows error when id is missing", async () => {
    await runDirectiveCommand("show");

    expect(mockPrintError).toHaveBeenCalledWith("Usage: neo directive show <id>");
    expect(process.exitCode).toBe(1);
  });

  it("shows error when directive not found", async () => {
    await runDirectiveCommand("show", { value: "dir_nonexistent" });

    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(process.exitCode).toBe(1);
  });
});

describe("neo directive (invalid action)", () => {
  it("shows error for unknown action", async () => {
    await runDirectiveCommand("unknown");

    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown action "unknown"'),
    );
    expect(process.exitCode).toBe(1);
  });
});
