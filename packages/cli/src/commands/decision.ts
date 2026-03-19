import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Decision, DecisionOption, InboxMessage } from "@neotx/core";
import { DecisionStore, getSupervisorDecisionsPath, getSupervisorDir } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess, printTable } from "../output.js";

const DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ParsedArgs {
  action: string;
  value: string | undefined;
  question: string | undefined;
  options: string | undefined;
  defaultAnswer: string | undefined;
  expiresIn: string | undefined;
  type: string | undefined;
  context: string | undefined;
  name: string;
  id: string | undefined;
  answer: string | undefined;
  json: boolean;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatStatus(decision: Decision): string {
  if (decision.answer !== undefined) {
    return "answered";
  }
  if (decision.expiredAt !== undefined) {
    return "expired";
  }
  if (decision.expiresAt && decision.expiresAt < new Date().toISOString()) {
    return "expired";
  }
  return "pending";
}

function formatTimeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function parseDurationMs(input: string): number | undefined {
  const match = input.match(/^(\d+)(h|m|d)$/);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    default:
      return undefined;
  }
}

function parseOptions(optionsArg: string): DecisionOption[] | undefined {
  // Format: "key1:label1,key2:label2" or "key1:label1:description1,key2:label2:description2"
  if (!optionsArg.trim()) return undefined;

  const options: DecisionOption[] = [];
  const parts = optionsArg.split(",");

  for (const part of parts) {
    const segments = part.trim().split(":");
    const key = segments[0];
    const label = segments[1];
    if (!key || !label) {
      throw new Error(
        `Invalid option format: "${part}". Expected "key:label" or "key:label:description"`,
      );
    }
    const descParts = segments.slice(2);
    options.push({
      key: key.trim(),
      label: label.trim(),
      description: descParts.length > 0 ? descParts.join(":").trim() : undefined,
    });
  }

  return options.length > 0 ? options : undefined;
}

function openStore(name: string): DecisionStore {
  const filePath = getSupervisorDecisionsPath(name);
  return new DecisionStore(filePath);
}

async function handleCreate(args: ParsedArgs): Promise<void> {
  if (!args.question) {
    printError(
      "Usage: neo decision create <question> --options 'key1:label1,key2:label2' [--default <key>] [--expires-in 24h]",
    );
    process.exitCode = 1;
    return;
  }

  let options: DecisionOption[] | undefined;
  if (args.options) {
    try {
      options = parseOptions(args.options);
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  let expiresAt: string | undefined;
  if (args.expiresIn) {
    const ms = parseDurationMs(args.expiresIn);
    if (!ms) {
      printError('Invalid --expires-in format. Use e.g. "24h", "30m", or "7d".');
      process.exitCode = 1;
      return;
    }
    expiresAt = new Date(Date.now() + ms).toISOString();
  } else {
    // Default to 24 hours
    expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_MS).toISOString();
  }

  const store = openStore(args.name);
  try {
    const id = await store.create({
      question: args.question,
      options,
      defaultAnswer: args.defaultAnswer,
      expiresAt,
      type: args.type ?? "generic",
      source: "supervisor",
      context: args.context,
    });
    printSuccess(`Decision created: ${id}`);
    console.log(id); // Output just the ID for easy parsing in scripts
  } catch (error) {
    printError(
      `Failed to create decision: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function handleList(args: ParsedArgs): Promise<void> {
  const store = openStore(args.name);
  const pending = await store.pending();

  if (args.json) {
    printJson(pending);
    return;
  }

  if (pending.length === 0) {
    console.log("No pending decisions.");
    return;
  }

  printTable(
    ["ID", "TYPE", "QUESTION", "SOURCE", "CREATED"],
    pending.map((d) => [
      d.id.slice(0, 12),
      d.type,
      truncate(d.question, 50),
      d.source,
      formatTimeAgo(d.createdAt),
    ]),
  );
}

async function handleGet(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo decision get <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  const decision = await store.get(args.value);

  if (!decision) {
    printError(`Decision not found: ${args.value}`);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    printJson(decision);
    return;
  }

  const status = formatStatus(decision);
  console.log(`ID:       ${decision.id}`);
  console.log(`Status:   ${status}`);
  console.log(`Type:     ${decision.type}`);
  console.log(`Source:   ${decision.source}`);
  console.log(`Created:  ${decision.createdAt}`);
  console.log();
  console.log(`Question: ${decision.question}`);
  if (decision.context) {
    console.log();
    console.log(`Context:\n${decision.context}`);
  }
  if (decision.options && decision.options.length > 0) {
    console.log();
    console.log("Options:");
    for (const opt of decision.options) {
      console.log(`  [${opt.key}] ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`);
    }
  }
  if (decision.answer !== undefined) {
    console.log();
    console.log(`Answer:   ${decision.answer}`);
    if (decision.answeredAt) {
      console.log(`Answered: ${decision.answeredAt}`);
    }
  }
  if (decision.defaultAnswer !== undefined) {
    console.log(`Default:  ${decision.defaultAnswer}`);
  }
  if (decision.expiresAt) {
    console.log(`Expires:  ${decision.expiresAt}`);
  }
}

async function handleAnswer(args: ParsedArgs): Promise<void> {
  // Parse positional args from process.argv
  const argv = process.argv;
  const answerIdx = argv.indexOf("answer");
  const idArg = argv[answerIdx + 1];
  const answerArg = argv[answerIdx + 2];

  if (!idArg || !answerArg) {
    printError("Usage: neo decision answer <id> <answer>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);

  try {
    await store.answer(idArg, answerArg);

    // Wake up the supervisor heartbeat by appending to inbox.jsonl
    const dir = getSupervisorDir(args.name);
    const inboxMessage: InboxMessage = {
      id: randomUUID(),
      from: "external",
      text: `decision:answer ${idArg} ${answerArg}`,
      timestamp: new Date().toISOString(),
    };
    const inboxPath = path.join(dir, "inbox.jsonl");
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(inboxPath, `${JSON.stringify(inboxMessage)}\n`, "utf-8");
    } catch (error) {
      // Log but don't fail the answer operation - the decision was still recorded
      console.error(
        `Warning: Failed to write to inbox: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    printSuccess(`Decision answered: ${idArg} → "${answerArg}"`);
  } catch (error) {
    printError(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  }
}

async function handlePending(args: ParsedArgs): Promise<void> {
  const store = openStore(args.name);
  const pending = await store.pending();

  if (args.json) {
    printJson(pending);
    return;
  }

  if (pending.length === 0) {
    console.log("No pending decisions.");
    return;
  }

  // Show more detailed view for pending decisions
  for (const d of pending) {
    console.log(`─────────────────────────────────────────`);
    console.log(`ID: ${d.id}  (${formatTimeAgo(d.createdAt)})`);
    console.log(`Question: ${d.question}`);
    if (d.options && d.options.length > 0) {
      console.log("Options:");
      for (const opt of d.options) {
        console.log(`  [${opt.key}] ${opt.label}`);
      }
    }
    if (d.defaultAnswer) {
      console.log(`Default: ${d.defaultAnswer}`);
    }
    console.log();
  }
  console.log(`─────────────────────────────────────────`);
  console.log(`\nAnswer with: neo decision answer <id> <answer>`);
}

export default defineCommand({
  meta: {
    name: "decision",
    description: "Manage supervisor decision gates",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: create, list, get, answer, pending",
      required: true,
    },
    value: {
      type: "positional",
      description: "Decision ID (for get/answer) or question text (for create)",
      required: false,
    },
    options: {
      type: "string",
      alias: "o",
      description:
        'Options in format "key1:label1,key2:label2" or "key1:label1:desc1,key2:label2:desc2"',
    },
    "default-answer": {
      type: "string",
      alias: "d",
      description: "Default answer key (used if decision expires)",
    },
    "expires-in": {
      type: "string",
      alias: "e",
      description: "Expiration duration (e.g. 24h, 30m, 7d). Default: 24h",
    },
    type: {
      type: "string",
      alias: "t",
      description: "Decision type (default: generic)",
    },
    context: {
      type: "string",
      alias: "c",
      description: "Additional context for the decision",
    },
    name: {
      type: "string",
      description: "Supervisor name",
      default: "supervisor",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const action = args.action as string;
    const parsed: ParsedArgs = {
      action,
      value: args.value as string | undefined,
      question: args.value as string | undefined, // For create action
      options: args.options as string | undefined,
      defaultAnswer: args["default-answer"] as string | undefined,
      expiresIn: args["expires-in"] as string | undefined,
      type: args.type as string | undefined,
      context: args.context as string | undefined,
      name: args.name as string,
      id: args.value as string | undefined, // For get/answer actions
      answer: undefined,
      json: args.json as boolean,
    };

    switch (action) {
      case "create":
        return handleCreate(parsed);
      case "list":
        return handleList(parsed);
      case "get":
        return handleGet(parsed);
      case "answer":
        return handleAnswer(parsed);
      case "pending":
        return handlePending(parsed);
      default:
        printError(
          `Unknown action "${action}". Must be one of: create, list, get, answer, pending`,
        );
        process.exitCode = 1;
    }
  },
});
