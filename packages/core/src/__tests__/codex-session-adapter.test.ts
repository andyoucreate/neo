import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const jsonlLines = `${[
      JSON.stringify({ type: "session.start", id: "codex-session-1" }),
      JSON.stringify({
        type: "message.completed",
        message: { content: [{ type: "text", text: "fixed the bug" }] },
      }),
      JSON.stringify({
        type: "session.completed",
        usage: { total_cost_usd: 0.03, turns: 2 },
      }),
    ].join("\n")}\n`;

    const stdout = Readable.from([jsonlLines]);
    const child = {
      stdout,
      stderr: Readable.from([]),
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") {
          setTimeout(() => cb(0), 10);
        }
        return child;
      }),
      kill: vi.fn(),
    };
    return child;
  }),
}));

import { CodexSessionAdapter } from "@/runner/adapters/codex-session";
import type { SDKStreamMessage } from "@/sdk-types";

describe("CodexSessionAdapter", () => {
  it("maps codex exec JSONL output to SDKStreamMessages", async () => {
    const adapter = new CodexSessionAdapter();
    const messages: SDKStreamMessage[] = [];

    const stream = adapter.runSession({
      prompt: "fix the bug",
      cwd: "/tmp/test-repo",
      sandboxConfig: {
        allowedTools: ["Bash", "Read"],
        readablePaths: [],
        writablePaths: [],
        writable: false,
      },
    });

    for await (const msg of stream) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(messages[1]).toMatchObject({ type: "assistant" });
    expect(messages[2]).toMatchObject({ type: "result" });
  });
});
