import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Check if tmux binary is available. */
export async function isTmuxInstalled(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

/** Get tmux version string, or null if not installed. */
export async function getTmuxVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["-V"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Check if a tmux session with the given name exists. */
export async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

/** Create a new detached tmux session running the given command.
 *  Sets remain-on-exit so the pane stays alive when the process exits. */
export async function tmuxNewSession(
  name: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command, ...args]);
  // Keep the pane alive when the process exits so we can respawn it
  await execFileAsync("tmux", ["set-option", "-t", name, "remain-on-exit", "on"]);
}

/** Check if the first pane in the session has a dead process. */
export async function tmuxPaneDead(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-panes",
      "-t",
      name,
      "-F",
      "#{pane_dead}",
    ]);
    return stdout.trim() === "1";
  } catch {
    return false;
  }
}

/** Respawn the dead pane in a session with a new command. */
export async function tmuxRespawnPane(
  name: string,
  command: string,
  args: string[],
): Promise<void> {
  await execFileAsync("tmux", ["respawn-pane", "-t", name, "-k", command, ...args]);
}

/** Attach the current terminal to an existing tmux session. */
export function tmuxAttach(name: string): void {
  spawnSync("tmux", ["attach-session", "-t", name], { stdio: "inherit" });
}

/** Kill a tmux session by name. */
export async function tmuxKill(name: string): Promise<void> {
  await execFileAsync("tmux", ["kill-session", "-t", name]);
}

export interface TmuxSessionInfo {
  created: string;
  windows: number;
}

/** Get session info, or null if the session does not exist. */
export async function tmuxSessionInfo(name: string): Promise<TmuxSessionInfo | null> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-sessions",
      "-F",
      "#{session_created} #{session_windows}",
      "-f",
      `#{==:#{session_name},${name}}`,
    ]);
    const line = stdout.trim();
    if (!line) return null;

    const [timestamp, windows] = line.split(" ");
    const epoch = Number(timestamp);
    return {
      created: Number.isNaN(epoch) ? "unknown" : new Date(epoch * 1000).toISOString(),
      windows: Number(windows) || 1,
    };
  } catch {
    return null;
  }
}
