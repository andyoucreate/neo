import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_memory_test__");

// Mock getSupervisorDir to use our temp directory
vi.mock("@neotx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neotx/core")>();
  return {
    ...actual,
    getSupervisorDir: () => TMP_DIR,
  };
});

// Track output calls
const mockPrintError = vi.fn();
const mockPrintSuccess = vi.fn();

vi.mock("../output.js", () => ({
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
  printTable: vi.fn(),
}));

async function runMemoryCommand(args: Record<string, unknown>): Promise<void> {
  // Re-import to pick up mocks
  const mod = await import("../commands/memory.js");
  const command = mod.default;
  await command.run?.({ args: args as never } as never);
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TMP_DIR, { recursive: true });
  mockPrintError.mockClear();
  mockPrintSuccess.mockClear();
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("neo memory write", () => {
  describe("legacy type aliases", () => {
    it("accepts --type fact and maps to knowledge with subtype fact", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test fact content",
        type: "fact",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });

    it("accepts --type procedure and maps to knowledge with subtype procedure", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test procedure content",
        type: "procedure",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });

    it("accepts --type feedback and maps to warning", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test feedback content",
        type: "feedback",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });
  });

  describe("new type format", () => {
    it("accepts --type knowledge --subtype fact", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test knowledge fact",
        type: "knowledge",
        subtype: "fact",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });

    it("accepts --type knowledge --subtype procedure", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test knowledge procedure",
        type: "knowledge",
        subtype: "procedure",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });

    it("accepts --type warning directly", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test warning content",
        type: "warning",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });

    it("accepts --type focus directly", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test focus content",
        type: "focus",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });
  });

  describe("type validation", () => {
    it("rejects invalid types", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test content",
        type: "invalid_type",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid_type"'),
      );
      expect(process.exitCode).toBe(1);
    });

    it("rejects invalid subtype for knowledge type", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test content",
        type: "knowledge",
        subtype: "invalid_subtype",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid subtype "invalid_subtype"'),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe("legacy type with subtype override", () => {
    it("allows --type fact --subtype procedure to override the default", async () => {
      await runMemoryCommand({
        action: "write",
        value: "Test content with override",
        type: "fact",
        subtype: "procedure",
        scope: "global",
        source: "user",
        name: "supervisor",
      });

      expect(mockPrintError).not.toHaveBeenCalled();
      expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Memory written: mem_/));
    });
  });
});
