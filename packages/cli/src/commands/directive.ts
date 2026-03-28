import path from "node:path";
import {
  DirectiveStore,
  type DirectiveTrigger,
  getSupervisorDir,
  parseDirectiveDuration,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess, printTable } from "../output.js";

const VALID_TRIGGERS = ["idle", "startup", "shutdown"] as const;

interface ParsedArgs {
  action: string;
  value: string | undefined;
  trigger: string;
  duration: string | undefined;
  priority: string | undefined;
  description: string | undefined;
  name: string;
}

function openStore(name: string): DirectiveStore {
  const dir = getSupervisorDir(name);
  return new DirectiveStore(path.join(dir, "directives.jsonl"));
}

function formatExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return "∞";
  const date = new Date(expiresAt);
  const now = new Date();
  if (date < now) return "expired";

  const diffMs = date.getTime() - now.getTime();
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

async function handleCreate(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError('Usage: neo directive create "<action>" [--trigger idle] [--duration "2h"]');
    process.exitCode = 1;
    return;
  }

  const trigger = args.trigger as DirectiveTrigger;
  if (!VALID_TRIGGERS.includes(trigger)) {
    printError(`Invalid trigger "${trigger}". Must be one of: ${VALID_TRIGGERS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  let expiresAt: string | undefined;
  if (args.duration) {
    expiresAt = parseDirectiveDuration(args.duration);
    // parseDirectiveDuration returns undefined for "indefinitely" which is valid
    // But if user provided something and we got undefined, it might be invalid format
    // Check against known indefinite keywords
    const isIndefinite = ["indefinitely", "forever", ""].includes(
      args.duration.toLowerCase().trim(),
    );
    if (expiresAt === undefined && !isIndefinite) {
      printError(
        `Invalid --duration format "${args.duration}". Use: "2h", "30m", "for 2 hours", "until midnight", "until 18:00", or "indefinitely"`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const store = openStore(args.name);
  const input: Parameters<typeof store.create>[0] = {
    trigger,
    action: args.value,
  };
  if (args.description) {
    input.description = args.description;
  }
  if (args.priority) {
    input.priority = Number(args.priority);
  }
  if (expiresAt) {
    input.expiresAt = expiresAt;
  }
  const id = await store.create(input);

  const expiryLabel = expiresAt ? formatExpiry(expiresAt) : "indefinitely";
  printSuccess(`Directive created: ${id}`);
  console.log(`  Trigger: ${trigger}`);
  console.log(`  Action: ${args.value}`);
  console.log(`  Duration: ${expiryLabel}`);
}

async function handleList(args: ParsedArgs): Promise<void> {
  const store = openStore(args.name);
  const directives = await store.list();

  if (directives.length === 0) {
    console.log("No directives found.");
    return;
  }

  printTable(
    ["ID", "TRIGGER", "STATUS", "EXPIRES", "PRIORITY", "ACTION"],
    directives.map((d) => {
      const now = new Date().toISOString();
      let status = d.enabled ? "active" : "disabled";
      if (d.expiresAt && d.expiresAt < now) {
        status = "expired";
      }

      return [
        d.id,
        d.trigger,
        status,
        formatExpiry(d.expiresAt),
        String(d.priority),
        d.action.length > 40 ? `${d.action.slice(0, 37)}...` : d.action,
      ];
    }),
  );
}

async function handleDelete(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo directive delete <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    await store.delete(args.value);
    printSuccess(`Directive deleted: ${args.value}`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function handleToggle(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo directive toggle <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    const directive = await store.get(args.value);
    if (!directive) {
      printError(`Directive not found: ${args.value}`);
      process.exitCode = 1;
      return;
    }

    const newState = !directive.enabled;
    await store.toggle(args.value, newState);
    printSuccess(`Directive ${args.value} ${newState ? "enabled" : "disabled"}`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function handleShow(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo directive show <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  const directive = await store.get(args.value);

  if (!directive) {
    printError(`Directive not found: ${args.value}`);
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  let status = directive.enabled ? "active" : "disabled";
  if (directive.expiresAt && directive.expiresAt < now) {
    status = "expired";
  }

  console.log(`ID:          ${directive.id}`);
  console.log(`Trigger:     ${directive.trigger}`);
  console.log(`Status:      ${status}`);
  console.log(`Priority:    ${directive.priority}`);
  console.log(`Action:      ${directive.action}`);
  if (directive.description) {
    console.log(`Description: ${directive.description}`);
  }
  console.log(`Created:     ${directive.createdAt}`);
  if (directive.expiresAt) {
    console.log(`Expires:     ${directive.expiresAt} (${formatExpiry(directive.expiresAt)})`);
  } else {
    console.log(`Expires:     never (indefinite)`);
  }
  if (directive.lastTriggeredAt) {
    console.log(`Last triggered: ${directive.lastTriggeredAt}`);
  }
}

export default defineCommand({
  meta: {
    name: "directive",
    description: "Manage persistent supervisor directives",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: create, list, delete, toggle, show",
      required: true,
    },
    value: {
      type: "positional",
      description: "Action text or directive ID",
      required: false,
    },
    trigger: {
      type: "string",
      alias: "t",
      description: "Trigger type: idle, startup, shutdown",
      default: "idle",
    },
    duration: {
      type: "string",
      alias: "d",
      description: 'Duration: "2h", "until midnight", "for 2 hours", "indefinitely"',
    },
    priority: {
      type: "string",
      alias: "p",
      description: "Priority (higher = execute first)",
      default: "0",
    },
    description: {
      type: "string",
      description: "Human-readable description",
    },
    name: {
      type: "string",
      description: "Supervisor name",
      default: "supervisor",
    },
  },
  async run({ args }) {
    const action = args.action as string;
    const parsed: ParsedArgs = {
      action,
      value: args.value as string | undefined,
      trigger: args.trigger as string,
      duration: args.duration as string | undefined,
      priority: args.priority as string | undefined,
      description: args.description as string | undefined,
      name: args.name as string,
    };

    switch (action) {
      case "create":
        return handleCreate(parsed);
      case "list":
        return handleList(parsed);
      case "delete":
        return handleDelete(parsed);
      case "toggle":
        return handleToggle(parsed);
      case "show":
        return handleShow(parsed);
      default:
        printError(
          `Unknown action "${action}". Must be one of: create, list, delete, toggle, show`,
        );
        process.exitCode = 1;
    }
  },
});
