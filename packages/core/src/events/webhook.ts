import { createHmac } from "node:crypto";
import type { NeoConfig } from "@/config";
import type { NeoEvent } from "@/types";

type WebhookConfig = NeoConfig["webhooks"][number];

interface WebhookPayload {
  version: 1;
  event: string;
  payload: Record<string, unknown>;
  source: "neo";
  deliveredAt: string;
}

/**
 * Fire-and-forget webhook dispatcher for NeoEvents.
 *
 * - Matches events against per-webhook filters (exact or wildcard like "session:*")
 * - Excludes gate:waiting events (contain non-serializable callbacks)
 * - Signs payloads with HMAC-SHA256 when a secret is configured
 * - Never throws — errors are silently swallowed (consistent with EventJournal)
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

      // Fire-and-forget — never awaited, errors swallowed
      fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(webhook.timeoutMs),
      }).catch(() => {});
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
