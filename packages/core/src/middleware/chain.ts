import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  HookEvent as SDKHookEvent,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  HookEvent,
  Middleware,
  MiddlewareContext,
  MiddlewareEvent,
  MiddlewareResult,
} from "../types.js";

export interface MiddlewareChain {
  execute(
    event: MiddlewareEvent,
    context: MiddlewareContext,
  ): Promise<MiddlewareResult>;
}

function matchesTool(
  match: string | string[] | undefined,
  toolName: string | undefined,
): boolean {
  if (match === undefined) return true;
  if (toolName === undefined) return false;
  if (Array.isArray(match)) return match.includes(toolName);
  return match === toolName;
}

export function buildMiddlewareChain(
  middleware: Middleware[],
): MiddlewareChain {
  return {
    async execute(
      event: MiddlewareEvent,
      context: MiddlewareContext,
    ): Promise<MiddlewareResult> {
      let lastAsync: MiddlewareResult | undefined;

      for (const mw of middleware) {
        // Hook event matching
        if (mw.on !== event.hookEvent) continue;

        // Tool name matching
        if (!matchesTool(mw.match, event.toolName)) continue;

        const result = await mw.handler(event, context);

        // Block stops the chain
        if ("decision" in result && result.decision === "block") {
          return result;
        }

        // Track async results — continue chain but remember the result
        if ("async" in result && result.async === true) {
          lastAsync = result;
        }
      }

      // Return async result if any middleware was async, otherwise pass-through
      return lastAsync ?? {};
    },
  };
}

/**
 * SDK hooks type — maps hook event names to callback matchers.
 */
export type SDKHooks = Partial<Record<SDKHookEvent, HookCallbackMatcher[]>>;

/**
 * Convert a middleware chain to Agent SDK hooks format.
 *
 * Creates one HookCallbackMatcher per supported event (PreToolUse, PostToolUse, Notification).
 * The matcher delegates to the chain's execute method, translating SDK input to our
 * MiddlewareEvent format.
 */
export function buildSDKHooks(
  chain: MiddlewareChain,
  context: MiddlewareContext,
): SDKHooks {
  function makeCallback(hookEvent: HookEvent): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const event: MiddlewareEvent = {
        hookEvent,
        sessionId: input.session_id,
        toolName:
          "tool_name" in input ? (input.tool_name as string) : undefined,
        input:
          "tool_input" in input
            ? (input.tool_input as Record<string, unknown>)
            : undefined,
        output:
          "tool_response" in input ? String(input.tool_response) : undefined,
        message: "message" in input ? (input.message as string) : undefined,
      };

      const result = await chain.execute(event, context);

      // Convert our MiddlewareResult to SDK HookJSONOutput
      if ("decision" in result && result.decision === "block") {
        return { decision: "block", reason: result.reason };
      }

      if ("async" in result && result.async === true) {
        return { async: true, asyncTimeout: result.asyncTimeout };
      }

      // Pass-through
      return {};
    };
  }

  const hooks: SDKHooks = {};
  const events: HookEvent[] = ["PreToolUse", "PostToolUse", "Notification"];

  for (const hookEvent of events) {
    hooks[hookEvent] = [{ hooks: [makeCallback(hookEvent)] }];
  }

  return hooks;
}
