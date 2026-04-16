import type { AIProvider, SessionAdapter } from "@/supervisor/ai-adapter";
import { ClaudeSessionAdapter } from "./claude-session.js";
import { CodexSessionAdapter } from "./codex-session.js";

export function createSessionAdapter(provider: AIProvider): SessionAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeSessionAdapter();
    case "codex":
      return new CodexSessionAdapter();
  }
}

export { ClaudeSessionAdapter } from "./claude-session.js";
export { CodexSessionAdapter } from "./codex-session.js";
