import { afterEach, describe, expect, it, vi } from "vitest";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd, _args, callback) => {
    callback?.(null, "", "");
    return { unref: vi.fn() };
  }),
}));

// Import after mocking
const { notify, shouldNotify, notifyRunComplete, notifyRunFailed } = await import(
  "@/supervisor/notify"
);

describe("notify", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("shouldNotify", () => {
    it("returns false when stdout is TTY", () => {
      expect(shouldNotify(true)).toBe(false);
    });

    it("returns true when stdout is not TTY (daemon mode)", () => {
      expect(shouldNotify(false)).toBe(true);
    });
  });

  describe("notify", () => {
    it("calls osascript on macOS", async () => {
      const { execFile } = await import("node:child_process");

      await notify("Neo ✓", "Task completed");

      expect(execFile).toHaveBeenCalledWith(
        "osascript",
        expect.arrayContaining(["-e"]),
        expect.any(Function),
      );
    });

    it("does not throw on error", async () => {
      const { execFile } = await import("node:child_process");
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error) => void) => {
          callback(new Error("osascript not found"));
          return { unref: vi.fn() };
        },
      );

      // Should not throw
      await expect(notify("Title", "Message")).resolves.toBeUndefined();
    });
  });

  describe("notifyRunComplete", () => {
    it("sends success notification", async () => {
      const { execFile } = await import("node:child_process");

      await notifyRunComplete("run_123", "All tests passed");

      expect(execFile).toHaveBeenCalled();
    });
  });

  describe("notifyRunFailed", () => {
    it("sends failure notification", async () => {
      const { execFile } = await import("node:child_process");

      await notifyRunFailed("run_123", "Build failed");

      expect(execFile).toHaveBeenCalled();
    });
  });
});
