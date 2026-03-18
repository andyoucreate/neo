import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getDataDir } from "@/paths";

// ─── Webhook Entry Schema ───────────────────────────────

export const webhookEntrySchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).optional(),
  secret: z.string().optional(),
  timeoutMs: z.number().default(5000),
  createdAt: z.string().default(() => new Date().toISOString()),
});

export type WebhookEntry = z.infer<typeof webhookEntrySchema>;
export type WebhookEntryInput = z.input<typeof webhookEntrySchema>;

// ─── Webhooks Config Schema ─────────────────────────────

const webhooksConfigSchema = z.object({
  webhooks: z.array(webhookEntrySchema).default([]),
});

type WebhooksConfig = z.infer<typeof webhooksConfigSchema>;

// ─── File Path ──────────────────────────────────────────

function getWebhooksConfigPath(): string {
  return path.join(getDataDir(), "webhooks.json");
}

// ─── Loaders ────────────────────────────────────────────

async function loadWebhooksConfig(): Promise<WebhooksConfig> {
  const configPath = getWebhooksConfigPath();

  if (!existsSync(configPath)) {
    return { webhooks: [] };
  }

  const raw = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  return webhooksConfigSchema.parse(parsed);
}

async function saveWebhooksConfig(config: WebhooksConfig): Promise<void> {
  const configPath = getWebhooksConfigPath();
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ─── CRUD Operations ────────────────────────────────────

/**
 * Add a webhook endpoint to ~/.neo/webhooks.json.
 * Deduplicates by URL.
 */
export async function addWebhook(input: WebhookEntryInput): Promise<WebhookEntry> {
  const config = await loadWebhooksConfig();
  const entry = webhookEntrySchema.parse(input);

  const existing = config.webhooks.findIndex((w) => w.url === entry.url);
  if (existing >= 0) {
    config.webhooks[existing] = entry;
  } else {
    config.webhooks.push(entry);
  }

  await saveWebhooksConfig(config);
  return entry;
}

/**
 * Remove a webhook endpoint by URL.
 * Returns true if removed, false if not found.
 */
export async function removeWebhook(url: string): Promise<boolean> {
  const config = await loadWebhooksConfig();
  const initialLength = config.webhooks.length;

  config.webhooks = config.webhooks.filter((w) => w.url !== url);

  if (config.webhooks.length === initialLength) {
    return false;
  }

  await saveWebhooksConfig(config);
  return true;
}

/**
 * List all configured webhooks.
 */
export async function listWebhooks(): Promise<WebhookEntry[]> {
  const config = await loadWebhooksConfig();
  return config.webhooks;
}

// ─── Test Webhook Payload ───────────────────────────────

export interface WebhookTestPayload {
  type: "test";
  timestamp: string;
  runId: string;
  status: "test";
  summary: string;
}

export interface WebhookTestResult {
  url: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  durationMs: number;
}

/**
 * Send a test payload to all configured webhooks.
 * Returns results for each endpoint.
 */
export async function testWebhooks(): Promise<WebhookTestResult[]> {
  const webhooks = await listWebhooks();

  if (webhooks.length === 0) {
    return [];
  }

  const payload: WebhookTestPayload = {
    type: "test",
    timestamp: new Date().toISOString(),
    runId: `test-${Date.now()}`,
    status: "test",
    summary: "Test webhook from neo CLI",
  };

  const results = await Promise.all(
    webhooks.map(async (webhook): Promise<WebhookTestResult> => {
      const start = Date.now();
      const body = JSON.stringify(payload);

      try {
        const response = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(webhook.timeoutMs),
        });

        return {
          url: webhook.url,
          success: response.ok,
          statusCode: response.status,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return {
          url: webhook.url,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        };
      }
    }),
  );

  return results;
}
