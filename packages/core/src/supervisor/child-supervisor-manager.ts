import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ChildSupervisorConfig } from "@/config/child-supervisor-schema.js";
import { isProcessAlive } from "@/shared/process.js";
import {
  type ChildHeartbeat,
  type ChildSupervisorState,
  type ChildSupervisorStatus,
  readChildHeartbeat,
  readChildState,
  writeChildState,
} from "./child-supervisor-protocol.js";

export interface ChildSupervisorManagerOptions {
  /** Name of the parent supervisor */
  parentName: string;
  /** Directory where child supervisor data is stored */
  childrenDir: string;
  /** Path to neo CLI executable (defaults to "neo") */
  neoBin?: string;
}

export interface ChildHealthStatus {
  name: string;
  status: ChildSupervisorStatus;
  isStalled: boolean;
  lastHeartbeat: ChildHeartbeat | null;
  state: ChildSupervisorState | null;
  isProcessAlive: boolean;
}

export interface CheckHealthOptions {
  /** How long since last heartbeat before considered stalled (ms) */
  stallThresholdMs: number;
}

/**
 * Manages lifecycle of child supervisor processes.
 * Handles spawn, stop, health monitoring, and budget enforcement.
 */
export class ChildSupervisorManager {
  private readonly parentName: string;
  private readonly childrenDir: string;
  private readonly neoBin: string;
  private readonly configs = new Map<string, ChildSupervisorConfig>();
  private readonly processes = new Map<string, ChildProcess>();

  constructor(options: ChildSupervisorManagerOptions) {
    this.parentName = options.parentName;
    this.childrenDir = options.childrenDir;
    this.neoBin = options.neoBin ?? "neo";
  }

  /**
   * Register a child supervisor configuration.
   * Does not start the child — call spawn() for that.
   */
  async register(config: ChildSupervisorConfig): Promise<void> {
    this.configs.set(config.name, config);
    const childDir = path.join(this.childrenDir, config.name);
    await mkdir(childDir, { recursive: true });
  }

  /**
   * Unregister and stop a child supervisor.
   */
  async unregister(name: string): Promise<void> {
    await this.stop(name);
    this.configs.delete(name);
  }

  /**
   * Get configuration for a child supervisor.
   */
  get(name: string): ChildSupervisorConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * List all registered child supervisor configurations.
   */
  list(): ChildSupervisorConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Spawn a child supervisor process.
   */
  async spawn(name: string): Promise<void> {
    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Unknown child supervisor: ${name}`);
    }

    if (!config.enabled) {
      return;
    }

    const childDir = path.join(this.childrenDir, name);
    await mkdir(childDir, { recursive: true });

    // Build spawn command args
    const args = [
      "supervise",
      "--detach",
      `--name=${name}`,
      `--child-of=${this.parentName}`,
      `--repo=${config.repo}`,
      `--type=${config.type}`,
      `--budget=${config.budget.dailyCapUsd}`,
    ];

    if (config.objective) {
      args.push(`--objective=${config.objective}`);
    }

    if (config.instructionsPath) {
      args.push(`--instructions=${config.instructionsPath}`);
    }

    // Spawn detached process
    const { spawn } = await import("node:child_process");
    const child = spawn(this.neoBin, args, {
      detached: true,
      stdio: "ignore",
      cwd: config.repo,
    });

    child.unref();
    this.processes.set(name, child);

    // Write initial state
    const state: ChildSupervisorState = {
      name,
      pid: child.pid ?? 0,
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      costTodayUsd: 0,
      taskCount: 0,
    };
    await writeChildState(childDir, state);
  }

  /**
   * Stop a child supervisor process.
   */
  async stop(name: string): Promise<void> {
    const child = this.processes.get(name);
    if (child?.pid && isProcessAlive(child.pid)) {
      process.kill(child.pid, "SIGTERM");
    }
    this.processes.delete(name);

    // Update state to stopped
    const childDir = path.join(this.childrenDir, name);
    const state = await readChildState(childDir);
    if (state) {
      state.status = "stopped";
      await writeChildState(childDir, state);
    }
  }

  /**
   * Stop all child supervisors.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.configs.keys());
    await Promise.all(names.map((name) => this.stop(name)));
  }

  /**
   * Check health of a child supervisor.
   */
  async checkHealth(name: string, options: CheckHealthOptions): Promise<ChildHealthStatus> {
    const childDir = path.join(this.childrenDir, name);
    const state = await readChildState(childDir);
    const heartbeat = await readChildHeartbeat(childDir);

    // Check if process is still alive
    const processAlive = state?.pid ? isProcessAlive(state.pid) : false;

    // Check if heartbeat is stale
    let isStalled = false;
    if (heartbeat) {
      const lastHeartbeatTime = new Date(heartbeat.timestamp).getTime();
      const now = Date.now();
      isStalled = now - lastHeartbeatTime > options.stallThresholdMs;
    } else if (state?.status === "running") {
      // No heartbeat file but state says running — stalled
      isStalled = true;
    }

    // Determine effective status
    let status: ChildSupervisorStatus = state?.status ?? "stopped";
    if (!processAlive && status === "running") {
      status = "failed";
    }
    if (isStalled && status === "running") {
      status = "stalled";
    }

    return {
      name,
      status,
      isStalled,
      lastHeartbeat: heartbeat,
      state,
      isProcessAlive: processAlive,
    };
  }

  /**
   * Restart a child supervisor (stop then spawn).
   */
  async restart(name: string): Promise<void> {
    await this.stop(name);
    // Brief delay to ensure process cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.spawn(name);
  }
}
