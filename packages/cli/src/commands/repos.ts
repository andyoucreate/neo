import path from "node:path";
import {
  addRepoToGlobalConfig,
  listReposFromGlobalConfig,
  removeRepoFromGlobalConfig,
  toRepoSlug,
} from "@neotx/core";
import { defineCommand } from "citty";
import { detectDefaultBranch, isGitRepo } from "../git-utils.js";
import { printError, printJson, printSuccess, printTable } from "../output.js";

async function listRepos(jsonOutput: boolean): Promise<void> {
  const repos = await listReposFromGlobalConfig();

  if (jsonOutput) {
    printJson(repos.map((r) => ({ ...r, slug: toRepoSlug(r) })));
    return;
  }

  if (repos.length === 0) {
    console.log("No repos registered. Run 'neo repos add' or 'neo init'.");
    return;
  }

  printTable(
    ["NAME", "PATH", "BRANCH", "REMOTE"],
    repos.map((r) => [toRepoSlug(r), r.path, r.defaultBranch, r.pushRemote]),
  );
}

async function addRepo(args: {
  repoPath: string;
  name: string | undefined;
  branch: string | undefined;
}): Promise<void> {
  const repoPath = path.resolve(args.repoPath);

  if (!(await isGitRepo(repoPath))) {
    printError(`Not a git repository: ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  const defaultBranch = args.branch ?? (await detectDefaultBranch(repoPath));

  await addRepoToGlobalConfig({
    path: repoPath,
    name: args.name,
    defaultBranch,
  });

  const slug = toRepoSlug({ name: args.name, path: repoPath });
  printSuccess(`Registered repo "${slug}" at ${repoPath} (branch: ${defaultBranch})`);
}

async function removeRepo(nameOrPath: string): Promise<void> {
  const removed = await removeRepoFromGlobalConfig(nameOrPath);
  if (removed) {
    printSuccess(`Removed repo "${nameOrPath}"`);
  } else {
    printError(`Repo not found: ${nameOrPath}`);
    process.exitCode = 1;
  }
}

export default defineCommand({
  meta: {
    name: "repos",
    description: "Manage registered repositories (list, add, remove)",
  },
  args: {
    action: {
      type: "positional",
      description:
        "Action to perform: 'add' to register a repo, 'remove' to unregister (omit to list all repos)",
      required: false,
    },
    target: {
      type: "positional",
      description:
        "Repository path for 'add' (default: current directory), or name/path for 'remove'",
      required: false,
    },
    name: {
      type: "string",
      description: "Custom display name for the repo (add only, defaults to directory name)",
    },
    branch: {
      type: "string",
      description: "Default branch override (add only, auto-detected from git if omitted)",
    },
    output: {
      type: "string",
      description: "Output format: 'json' for structured output (default: human-readable table)",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";

    switch (args.action) {
      case "add":
        await addRepo({
          repoPath: (args.target as string) ?? ".",
          name: args.name,
          branch: args.branch,
        });
        break;

      case "remove":
        if (!args.target) {
          printError("Usage: neo repos remove <name-or-path>");
          process.exitCode = 1;
          return;
        }
        await removeRepo(args.target as string);
        break;

      case undefined:
        await listRepos(jsonOutput);
        break;

      default:
        printError(`Unknown action: ${args.action}. Use: add, remove, or omit to list.`);
        process.exitCode = 1;
    }
  },
});
