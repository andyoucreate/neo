import type { WebhookEntry, WebhookTestResult } from "@neotx/core";
import { addWebhook, listWebhooks, removeWebhook, testWebhooks } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess, printTable } from "../output.js";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatWebhooksTable(webhooks: WebhookEntry[]): void {
  printTable(
    ["URL", "EVENTS", "TIMEOUT", "CREATED"],
    webhooks.map((w) => [
      truncate(w.url, 50),
      w.events?.join(", ") || "*",
      `${w.timeoutMs}ms`,
      w.createdAt.split("T")[0] ?? "",
    ]),
  );
}

function formatTestResultsTable(results: WebhookTestResult[]): void {
  printTable(
    ["URL", "STATUS", "CODE", "TIME"],
    results.map((r) => [
      truncate(r.url, 50),
      r.success ? "✓ OK" : `✗ ${r.error ?? "Failed"}`,
      r.statusCode?.toString() ?? "-",
      `${r.durationMs}ms`,
    ]),
  );
}

async function handleAdd(url: string, jsonOutput: boolean): Promise<void> {
  try {
    new URL(url);
  } catch (err) {
    console.debug(
      `[webhooks] Invalid URL parse: ${err instanceof Error ? err.message : String(err)}`,
    );
    printError(`Invalid URL: ${url}`);
    process.exitCode = 1;
    return;
  }

  const entry = await addWebhook({ url });

  if (jsonOutput) {
    printJson(entry);
    return;
  }

  printSuccess(`Webhook added: ${entry.url}`);
}

async function handleRemove(url: string): Promise<void> {
  const removed = await removeWebhook(url);

  if (removed) {
    printSuccess(`Webhook removed: ${url}`);
  } else {
    printError(`Webhook not found: ${url}`);
    process.exitCode = 1;
  }
}

async function handleList(jsonOutput: boolean): Promise<void> {
  const webhooks = await listWebhooks();

  if (jsonOutput) {
    printJson(webhooks);
    return;
  }

  if (webhooks.length === 0) {
    console.log("No webhooks configured. Run 'neo webhooks add <url>' to register one.");
    return;
  }

  formatWebhooksTable(webhooks);
}

async function handleTest(jsonOutput: boolean): Promise<void> {
  const webhooks = await listWebhooks();

  if (webhooks.length === 0) {
    console.log("No webhooks configured. Run 'neo webhooks add <url>' to register one.");
    return;
  }

  console.log(`Testing ${webhooks.length} webhook(s)...\n`);

  const results = await testWebhooks();

  if (jsonOutput) {
    printJson(results);
    return;
  }

  formatTestResultsTable(results);

  const successful = results.filter((r) => r.success).length;
  const failed = results.length - successful;

  console.log();
  if (failed === 0) {
    printSuccess(`All ${successful} webhook(s) responded successfully`);
  } else {
    printError(`${failed}/${results.length} webhook(s) failed`);
    process.exitCode = 1;
  }
}

export default defineCommand({
  meta: {
    name: "webhooks",
    description: "Manage webhook endpoints (add, remove, list, test)",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: add, remove, test (omit to list)",
      required: false,
    },
    url: {
      type: "positional",
      description: "Webhook URL (for add/remove)",
      required: false,
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";

    switch (args.action) {
      case "add":
        if (!args.url) {
          printError("Usage: neo webhooks add <url>");
          process.exitCode = 1;
          return;
        }
        await handleAdd(args.url as string, jsonOutput);
        break;

      case "remove":
        if (!args.url) {
          printError("Usage: neo webhooks remove <url>");
          process.exitCode = 1;
          return;
        }
        await handleRemove(args.url as string);
        break;

      case "test":
        await handleTest(jsonOutput);
        break;

      case undefined:
        await handleList(jsonOutput);
        break;

      default:
        printError(`Unknown action: ${args.action}. Use: add, remove, test, or omit to list.`);
        process.exitCode = 1;
    }
  },
});
