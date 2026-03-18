import type { Decision } from "@neotx/core";
import { DecisionStore, getSupervisorDecisionsPath } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess, printTable } from "../output.js";

interface ParsedArgs {
  value: string | undefined;
  name: string;
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

function openStore(name: string): DecisionStore {
  const filePath = getSupervisorDecisionsPath(name);
  return new DecisionStore(filePath);
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
      description: "Action: list, get, answer, pending",
      required: true,
    },
    value: {
      type: "positional",
      description: "Decision ID (for get/answer)",
      required: false,
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
      value: args.value as string | undefined,
      name: args.name as string,
      json: args.json as boolean,
    };

    switch (action) {
      case "list":
        return handleList(parsed);
      case "get":
        return handleGet(parsed);
      case "answer":
        return handleAnswer(parsed);
      case "pending":
        return handlePending(parsed);
      default:
        printError(`Unknown action "${action}". Must be one of: list, get, answer, pending`);
        process.exitCode = 1;
    }
  },
});
