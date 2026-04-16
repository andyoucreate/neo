import type { AIAdapter, AIProvider } from "../ai-adapter.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export function createSupervisorAdapter(provider: AIProvider): AIAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      // CodexAdapter defers the actual @openai/codex-sdk import to the first
      // query() call, so construction is safe even without the SDK installed.
      return new CodexAdapter();
  }
}

export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
