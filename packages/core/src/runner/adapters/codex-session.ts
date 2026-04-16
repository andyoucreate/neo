import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { SDKStreamMessage } from "@/sdk-types";
import type { SessionAdapter, SessionRunOptions } from "@/supervisor/ai-adapter";

interface CodexJsonlEvent {
  type: string;
  id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  usage?: {
    total_cost_usd?: number;
    turns?: number;
  };
}

function mapCodexEvent(event: CodexJsonlEvent): SDKStreamMessage {
  switch (event.type) {
    case "session.start":
      return {
        type: "system",
        subtype: "init",
        session_id: event.id ?? "unknown",
      } as SDKStreamMessage;

    case "message.completed":
      return {
        type: "assistant",
        message: { content: event.message?.content ?? [] },
      } as SDKStreamMessage;

    case "session.completed":
      return {
        type: "result",
        subtype: "success",
        session_id: event.id ?? "unknown",
        result: "",
        total_cost_usd: event.usage?.total_cost_usd ?? 0,
        num_turns: event.usage?.turns ?? 0,
      } as SDKStreamMessage;

    default:
      return { type: event.type } as SDKStreamMessage;
  }
}

export class CodexSessionAdapter implements SessionAdapter {
  async *runSession(options: SessionRunOptions): AsyncIterable<SDKStreamMessage> {
    const args = ["exec", "--json", "--full-auto"];

    if (!options.sandboxConfig.writable) {
      args.push("--sandbox", "read-only");
    } else {
      args.push("--sandbox", "workspace-write");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    args.push(options.prompt);

    const child = execFile("codex", args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });

    if (!child.stdout) {
      throw new Error("codex exec: stdout is null");
    }

    const rl = createInterface({ input: child.stdout });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CodexJsonlEvent;
        yield mapCodexEvent(event);
      } catch {
        // Skip non-JSON lines
      }
    }

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`codex exec exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  }
}
