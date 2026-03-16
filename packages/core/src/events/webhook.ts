import { createHmac, randomUUID } from "node:crypto";
import type { NeoConfig } from "@/config";
import type { NeoEvent } from "@/types";

type WebhookConfig = NeoConfig["webhooks"][number];

interface WebhookPayload {
  id: string;
  version: 1;
  event: string;
  payload: Record<string, unknown>;
  source: "neo";
  deliveredAt: string;
}

/** Event types that get retry on failure (terminal events the supervisor must see). */
const RETRY_EVENT_TYPES = new Set(["session:complete", "session:fail", "budget:alert"]);

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Webhook dispatcher for NeoEvents.
 *
 * - Matches events against per-webhook filters (exact or wildcard like "session:*")
 * - Excludes gate:waiting events (contain non-serializable callbacks)
 * - Signs payloads with HMAC-SHA256 when a secret is configured
 * - Terminal events (session:complete, session:fail, budget:alert) are retried
 *   with exponential backoff on failure
 * - Non-terminal events remain fire-and-forget
 */
export class WebhookDispatcher {
  private readonly webhooks: WebhookConfig[];

  constructor(webhooks: WebhookConfig[]) {
    this.webhooks = webhooks;
  }

  dispatch(event: NeoEvent): void {
    // gate:waiting contains non-serializable callbacks (approve/reject)
    if (event.type === "gate:waiting") return;

    for (const webhook of this.webhooks) {
      if (!matchesFilter(event.type, webhook.events)) continue;

      const payload: WebhookPayload = {
        id: randomUUID(),
        version: 1,
        event: event.type,
        payload: toSerializable(event),
        source: "neo",
        deliveredAt: new Date().toISOString(),
      };

      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (webhook.secret) {
        headers["X-Neo-Signature"] = sign(body, webhook.secret);
      }

      if (RETRY_EVENT_TYPES.has(event.type)) {
        // Terminal events: retry with exponential backoff
        sendWithRetry(webhook.url, headers, body, webhook.timeoutMs).catch(() => {});
      } else {
        // Non-terminal: fire-and-forget
        fetch(webhook.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(webhook.timeoutMs),
        }).catch(() => {});
      }
    }
  }
}

/**
 * Send a webhook POST with exponential backoff retry.
 * Retries up to RETRY_MAX_ATTEMPTS times with delays of 500ms, 1s, 2s.
 */
async function sendWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<void> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
      // Non-2xx: treat as failure, retry
    } catch {
      // Network error or timeout: retry
    }

    if (attempt < RETRY_MAX_ATTEMPTS) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Check if an event type matches a filter list.
 * Supports exact matches and wildcard prefixes (e.g. "session:*").
 * No filter (undefined) means all events match.
 */
export function matchesFilter(eventType: string, filters?: string[]): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.some((f) => {
    if (f.endsWith(":*")) return eventType.startsWith(f.slice(0, -1));
    return f === eventType;
  });
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function toSerializable(event: NeoEvent): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value !== "function") {
      obj[key] = value;
    }
  }
  return obj;
}
