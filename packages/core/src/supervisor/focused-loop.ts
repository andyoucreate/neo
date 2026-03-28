import { randomUUID } from "node:crypto";
import type { AIAdapter } from "./ai-adapter.js";
import type { SupervisorStore } from "./store.js";
import {
  SUPERVISOR_BLOCKED_TOOL,
  SUPERVISOR_COMPLETE_TOOL,
  type SupervisorBlockedInput,
  type SupervisorCompleteInput,
  supervisorBlockedSchema,
  supervisorCompleteSchema,
} from "./supervisor-tools.js";

export interface FocusedLoopOptions {
  supervisorId: string;
  objective: string;
  acceptanceCriteria: string[];
  adapter: AIAdapter;
  store: SupervisorStore;
  onComplete: (result: SupervisorCompleteInput) => void | Promise<void>;
  onBlocked: (blocked: SupervisorBlockedInput) => void | Promise<void>;
  onProgress: (summary: string, costDelta: number) => void | Promise<void>;
  tickIntervalMs?: number;
  systemPrompt?: string;
}

/**
 * Runs a persistent SDK conversation focused on a single objective.
 * Loops via runOnce() until supervisor_complete or supervisor_blocked is called,
 * or until stop() is called.
 */
export class FocusedLoop {
  private readonly options: FocusedLoopOptions;
  private stopping = false;
  private injectedContext: string[] = [];

  constructor(options: FocusedLoopOptions) {
    this.options = options;
  }

  /** Inject context from parent supervisor (via IPC inject message). */
  injectContext(context: string): void {
    this.injectedContext.push(context);
  }

  /** Signal the loop to stop after the current turn. */
  stop(): void {
    this.stopping = true;
  }

  /**
   * Execute one turn of the focused loop.
   * Returns true if the loop should continue, false if it should stop.
   */
  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;

    const { supervisorId, objective, acceptanceCriteria, adapter, store } = this.options;

    const existingSessionId = await store.getSessionId(supervisorId);
    if (existingSessionId) {
      adapter.restoreSession({ provider: "claude", sessionId: existingSessionId });
    }

    const recentActivity = await store.getRecentActivity(supervisorId, 20);
    const injected = this.injectedContext.splice(0);

    const prompt = buildFocusedPrompt({
      objective,
      acceptanceCriteria,
      recentActivity: recentActivity.map((e) => e.summary),
      injectedContext: injected,
    });

    const queryOptions = {
      prompt,
      tools: [SUPERVISOR_COMPLETE_TOOL, SUPERVISOR_BLOCKED_TOOL],
      ...(this.options.systemPrompt !== undefined && { systemPrompt: this.options.systemPrompt }),
    };

    for await (const message of adapter.query(queryOptions)) {
      const handle = adapter.getSessionHandle();
      if (handle?.provider === "claude") {
        await store.saveSessionId(supervisorId, handle.sessionId);
      }

      if (message.kind === "tool_use") {
        const terminal = await this.handleToolUse(message.toolName, message.toolInput);
        if (terminal) return false;
      } else if (message.kind === "text" && message.text) {
        await store.appendActivity(supervisorId, {
          id: randomUUID(),
          type: "thinking",
          summary: message.text.slice(0, 200),
          timestamp: new Date().toISOString(),
        });
      }
    }

    await this.options.onProgress("Turn complete", 0);
    return !this.stopping;
  }

  /**
   * Run the full loop until complete, blocked, or stopped.
   */
  async run(): Promise<void> {
    const tickMs = this.options.tickIntervalMs ?? 30_000;

    while (!this.stopping) {
      const shouldContinue = await this.runOnce();
      if (!shouldContinue) break;
      if (tickMs > 0) await sleep(tickMs);
    }
  }

  // ─── Private helpers ──────────────────────────────────────

  /** Returns true if the tool call is terminal (complete or blocked). */
  private async handleToolUse(toolName: string | undefined, toolInput: unknown): Promise<boolean> {
    const { supervisorId, store } = this.options;

    if (toolName === "supervisor_complete") {
      const parsed = supervisorCompleteSchema.safeParse(toolInput);
      if (parsed.success) {
        await store.appendActivity(supervisorId, {
          id: randomUUID(),
          type: "action",
          summary: `supervisor_complete: ${parsed.data.summary}`,
          timestamp: new Date().toISOString(),
        });
        await this.options.onComplete(parsed.data);
        return true;
      }
    }

    if (toolName === "supervisor_blocked") {
      const parsed = supervisorBlockedSchema.safeParse(toolInput);
      if (parsed.success) {
        await store.appendActivity(supervisorId, {
          id: randomUUID(),
          type: "decision",
          summary: `supervisor_blocked: ${parsed.data.reason}`,
          timestamp: new Date().toISOString(),
        });
        await this.options.onBlocked(parsed.data);
        return true;
      }
    }

    return false;
  }
}

// ─── Prompt builder ───────────────────────────────────────

function buildFocusedPrompt(opts: {
  objective: string;
  acceptanceCriteria: string[];
  recentActivity: string[];
  injectedContext: string[];
}): string {
  const criteria =
    opts.acceptanceCriteria.length > 0
      ? opts.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
      : "- No specific criteria — use your judgment";

  const activity =
    opts.recentActivity.length > 0
      ? opts.recentActivity.slice(-10).join("\n")
      : "No previous activity";

  const injected =
    opts.injectedContext.length > 0
      ? `\n### Context from parent supervisor\n${opts.injectedContext.join("\n")}\n`
      : "";

  return `## Your objective
${opts.objective}

## Acceptance criteria (defined at dispatch — you must meet ALL of these)
${criteria}

## Recent activity
${activity}
${injected}
## Instructions
Assess current progress toward the objective. Dispatch agents as needed.
When ALL acceptance criteria are verifiably met, call \`supervisor_complete\` with evidence.
If you cannot proceed without a decision, call \`supervisor_blocked\`.
Do NOT call \`supervisor_complete\` unless you have objective evidence.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
