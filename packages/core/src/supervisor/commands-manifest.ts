/**
 * NEO CLI commands manifest — single source of truth for CLI documentation.
 *
 * This module provides:
 * - Typed command definitions (CommandFlag, CommandDefinition, CommandSection)
 * - NEO_COMMANDS manifest describing all supervisor CLI commands
 * - Generator functions to produce markdown documentation from the manifest
 */

// ─── Type definitions ────────────────────────────────────

/**
 * Flag definition for a CLI command.
 */
export interface CommandFlag {
  name: string;
  required: "always" | "optional";
  description: string;
}

/**
 * Command definition for the NEO CLI.
 */
export interface CommandDefinition {
  name: string;
  syntax: string;
  description: string;
  flags?: CommandFlag[];
  /** Additional notes rendered after the command block */
  notes?: string;
  /** One-liner syntax for compact mode */
  compactSyntax?: string;
}

/**
 * Section grouping related commands.
 */
export interface CommandSection {
  title: string;
  commands: CommandDefinition[];
  /** Prose before the command listing */
  preamble?: string;
  /** Notes rendered after all commands in the section */
  sectionNotes?: string;
}

// ─── Commands manifest ───────────────────────────────────

/**
 * NEO_COMMANDS manifest — single source of truth for CLI documentation.
 * Exported so other modules can extend or reference it.
 */
export const NEO_COMMANDS: CommandSection[] = [
  {
    title: "Dispatching agents",
    commands: [
      {
        name: "neo run",
        syntax:
          "neo run <agent> --prompt \"...\" --repo <path> --branch <name> [--priority critical|high|medium|low] [--meta '<json>']",
        description: "Dispatch an agent to work on a task",
        flags: [
          { name: "--prompt", required: "always", description: "Task description for the agent" },
          { name: "--repo", required: "always", description: "Target repository path" },
          {
            name: "--branch",
            required: "always",
            description: "Branch name for the isolated clone",
          },
          {
            name: "--priority",
            required: "optional",
            description: "`critical`, `high`, `medium`, `low`",
          },
          {
            name: "--meta",
            required: "always",
            description: 'JSON with `"label"` for identification + `"ticketId"`, `"stage"`, etc.',
          },
        ],
        notes:
          'All agents require `--branch`. Each agent session runs in an isolated clone on that branch.\nAlways include `--meta \'{"label":"T1-auth-middleware","ticketId":"YC-42","stage":"develop"}\'` so you can identify runs later.',
        compactSyntax:
          'neo run <agent> --prompt "..." --repo <path> --branch <name> --meta \'{"label":"T1-auth",...}\'',
      },
    ],
  },
  {
    title: "Monitoring & reading agent output",
    commands: [
      {
        name: "neo runs --short",
        syntax: "neo runs --short",
        description: "check recent runs",
        compactSyntax: "neo runs [--short | <runId>]",
      },
      {
        name: "neo runs --status",
        syntax: "neo runs --short --status running",
        description: "check active runs are alive",
        compactSyntax: "neo runs --short --status running",
      },
      {
        name: "neo runs <runId>",
        syntax: "neo runs <runId>",
        description: "full run details + agent output (MUST READ on completion)",
      },
      {
        name: "neo cost",
        syntax: "neo cost --short [--all]",
        description: "check budget",
        compactSyntax: "neo cost --short",
      },
    ],
    sectionNotes:
      "`neo runs <runId>` returns the agent's full output. **ALWAYS read it when a run completes** — it contains the agent's results that you need to decide next steps per SUPERVISOR.md routing rules.",
  },
  {
    title: "Memory",
    commands: [
      {
        name: "neo memory write (fact)",
        syntax:
          'neo memory write --type knowledge --subtype fact --scope /path "Stable fact about repo"',
        description: "Write a stable fact about a repository",
      },
      {
        name: "neo memory write (procedure)",
        syntax: 'neo memory write --type knowledge --subtype procedure --scope /path "How to do X"',
        description: "Write a procedure",
      },
      {
        name: "neo memory write (warning)",
        syntax: 'neo memory write --type warning --scope /path "Recurring issue to watch for"',
        description: "Write a warning about recurring issues",
      },
      {
        name: "neo memory write (focus)",
        syntax: 'neo memory write --type focus --expires 2h "Current working context"',
        description: "Write current working context",
      },
      {
        name: "neo task create",
        syntax:
          'neo task create --scope /path --priority high --context "neo runs <id>" "Task description"',
        description: "Create a new task",
      },
      {
        name: "neo task update",
        syntax: "neo task update <id> --status in_progress|done|blocked|abandoned",
        description: "Update task status",
      },
      {
        name: "neo memory forget",
        syntax: "neo memory forget <id>",
        description: "Forget a memory entry",
      },
      {
        name: "neo memory search",
        syntax: 'neo memory search "keyword"',
        description: "Search memory entries",
      },
      {
        name: "neo memory list",
        syntax: "neo memory list --type fact",
        description: "List memory entries by type",
      },
    ],
  },
  {
    title: "Decisions",
    preamble: "When you need human input on something that cannot be decided autonomously:",
    commands: [
      {
        name: "neo decision create",
        syntax:
          'neo decision create "<question>" --options "key1:label1,key2:label2:description" [--default <key>] [--expires-in 24h] [--context "..."]',
        description: "Create a decision requiring human input",
        compactSyntax: 'neo decision create "<question>" --options "..." [--default <key>]',
      },
      {
        name: "neo decision list",
        syntax: "neo decision list",
        description: "show pending decisions",
        compactSyntax: "neo decision list",
      },
      {
        name: "neo decision answer",
        syntax: "neo decision answer <id> <answer>",
        description: "answer a decision (usually done by human via TUI)",
      },
    ],
    sectionNotes:
      "The decision ID is returned by `create`. If no answer arrives before expiration, the `--default` answer is applied automatically (or the decision expires without resolution).",
  },
  {
    title: "Config",
    commands: [
      {
        name: "neo config get",
        syntax: "neo config get <key>",
        description: "Get a config value",
        compactSyntax: "neo config get <key>",
      },
      {
        name: "neo config set",
        syntax: "neo config set <key> <value> --global",
        description: "Set a config value",
        compactSyntax: "neo config set <key> <value> --global",
      },
      {
        name: "neo config list",
        syntax: "neo config list",
        description: "List config values",
        compactSyntax: "neo config list",
      },
    ],
  },
  {
    title: "Child Supervisors",
    commands: [
      {
        name: "neo child spawn",
        syntax:
          'neo child spawn --objective "..." --criteria "..." [--budget <usd>] [--supervisor <name>]',
        description: "Spawn a child supervisor for a self-contained objective",
        compactSyntax: 'neo child spawn --objective "..." --criteria "..." [--budget <usd>]',
      },
    ],
  },
  {
    title: "Reporting",
    commands: [
      {
        name: "neo log",
        syntax: 'neo log <type> "<message>"',
        description: "visible in TUI only",
        compactSyntax: 'neo log <type> "<msg>"',
      },
    ],
  },
];

// ─── Generator functions ─────────────────────────────────

/**
 * Build the full commands reference block from the manifest.
 * Produces markdown with code blocks, flag tables, and section notes.
 */
export function buildCommandsSection(commands: CommandSection[]): string {
  const sections: string[] = [];

  for (const section of commands) {
    const lines: string[] = [`### ${section.title}`];

    // Commands with flags get their own code block + table
    const tableCommands = section.commands.filter((cmd) => cmd.flags);
    // Simple commands are grouped in a single code block
    const codeBlockCommands = section.commands.filter((cmd) => !cmd.flags);

    // Render commands with flags (code block + table format)
    for (const cmd of tableCommands) {
      lines.push("```bash");
      lines.push(cmd.syntax);
      lines.push("```");
      lines.push("");

      if (cmd.flags && cmd.flags.length > 0) {
        lines.push("| Flag | Required | Description |");
        lines.push("|------|----------|-------------|");
        for (const flag of cmd.flags) {
          const reqLabel = flag.required === "always" ? "always" : "optional";
          // Special formatting for --meta flag
          const reqDisplay =
            flag.required === "always" && flag.name === "--meta" ? "**always**" : reqLabel;
          lines.push(`| \`${flag.name}\` | ${reqDisplay} | ${flag.description} |`);
        }
        lines.push("");
      }

      if (cmd.notes) {
        lines.push(cmd.notes);
        lines.push("");
      }
    }

    // Render simple commands (grouped code block format)
    if (codeBlockCommands.length > 0) {
      if (section.preamble) {
        lines.push(section.preamble);
      }
      lines.push("```bash");
      for (const cmd of codeBlockCommands) {
        // Pad syntax to align comments
        const padding = cmd.description ? cmd.syntax.padEnd(36) : cmd.syntax;
        lines.push(cmd.description ? `${padding}# ${cmd.description}` : cmd.syntax);
      }
      lines.push("```");
    }

    if (section.sectionNotes) {
      lines.push(section.sectionNotes);
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * Build the compact commands reference (one-liner per command group).
 * Used after the first few heartbeats to save tokens.
 */
export function buildCommandsCompact(commands: CommandSection[]): string {
  const lines: string[] = ["### Commands (reference)"];

  // Group 1: Dispatching
  const dispatchSection = commands.find((s) => s.title === "Dispatching agents");
  if (dispatchSection) {
    const runCmd = dispatchSection.commands.find((c) => c.name === "neo run");
    if (runCmd?.compactSyntax) {
      lines.push(`\`${runCmd.compactSyntax}\``);
    }
  }

  // Group 2: Monitoring
  const monitorSection = commands.find((s) => s.title === "Monitoring & reading agent output");
  if (monitorSection) {
    const compactMonitor = monitorSection.commands
      .filter((c) => c.compactSyntax)
      .map((c) => `\`${c.compactSyntax}\``)
      .join(" \u00b7 ");
    if (compactMonitor) {
      lines.push(compactMonitor);
    }
  }

  // Group 3: Memory + Reporting
  const memorySection = commands.find((s) => s.title === "Memory");
  const reportingSection = commands.find((s) => s.title === "Reporting");
  const memoryCompact: string[] = [];
  if (memorySection) {
    memoryCompact.push("`neo memory write|update|forget|search|list`");
  }
  if (reportingSection) {
    const logCmd = reportingSection.commands.find((c) => c.name === "neo log");
    if (logCmd?.compactSyntax) {
      memoryCompact.push(`\`${logCmd.compactSyntax}\``);
    }
  }
  if (memoryCompact.length > 0) {
    lines.push(memoryCompact.join(" \u00b7 "));
  }

  // Group 4: Config
  const configSection = commands.find((s) => s.title === "Config");
  if (configSection) {
    const compactConfig = configSection.commands
      .filter((c) => c.compactSyntax)
      .map((c) => `\`${c.compactSyntax}\``)
      .join(" \u00b7 ");
    if (compactConfig) {
      lines.push(compactConfig);
    }
  }

  // Group 5: Decisions
  const decisionSection = commands.find((s) => s.title === "Decisions");
  if (decisionSection) {
    const compactDecisions = decisionSection.commands
      .filter((c) => c.compactSyntax)
      .map((c) => `\`${c.compactSyntax}\``)
      .join(" \u00b7 ");
    if (compactDecisions) {
      lines.push(compactDecisions);
    }
  }

  // Group 6: Child Supervisors
  const childSection = commands.find((s) => s.title === "Child Supervisors");
  if (childSection) {
    const compactChild = childSection.commands
      .filter((c) => c.compactSyntax)
      .map((c) => `\`${c.compactSyntax}\``)
      .join(" \u00b7 ");
    if (compactChild) {
      lines.push(compactChild);
    }
  }

  return lines.join("\n");
}
