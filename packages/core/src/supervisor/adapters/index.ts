import type { AIAdapter, AIProvider } from "../ai-adapter.js";
import { ClaudeAdapter } from "./claude.js";

export function createSupervisorAdapter(provider: AIProvider): AIAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      throw new Error("CodexAdapter is not yet implemented. It will be added in Task 8.");
  }
}

export { ClaudeAdapter } from "./claude.js";
