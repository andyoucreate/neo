import type { ChildProcess } from "node:child_process";
import { writeChildrenFile } from "./children-file.js";
import type { ChildHandle, ChildToParentMessage, ParentToChildMessage } from "./schemas.js";

export interface ChildRegistryOptions {
  onMessage: (message: ChildToParentMessage) => void;
  stallTimeoutMs?: number;
  /** If provided, children.json is written here after every mutation. */
  childrenFilePath?: string;
}

/**
 * Tracks all active focused supervisor child processes.
 * Handles IPC message routing, budget enforcement, and stall detection.
 */
export class ChildRegistry {
  private readonly handles = new Map<string, ChildHandle>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly stopCallbacks = new Map<string, () => void>();
  private readonly stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onMessage: (message: ChildToParentMessage) => void;
  private readonly stallTimeoutMs: number;
  private readonly childrenFilePath: string | undefined;

  constructor(options: ChildRegistryOptions) {
    this.onMessage = options.onMessage;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 10 * 60 * 1000;
    this.childrenFilePath = options.childrenFilePath;
  }

  /**
   * Register a child handle.
   */
  register(handle: ChildHandle, stopCallback?: () => void, childProcess?: ChildProcess): void {
    this.handles.set(handle.supervisorId, { ...handle });
    if (stopCallback) this.stopCallbacks.set(handle.supervisorId, stopCallback);
    if (childProcess) this.processes.set(handle.supervisorId, childProcess);
    this.resetStallTimer(handle.supervisorId);
    this.persistChildren();
  }

  get(supervisorId: string): ChildHandle | undefined {
    return this.handles.get(supervisorId);
  }

  list(): ChildHandle[] {
    return Array.from(this.handles.values());
  }

  /**
   * Send a message to a child via IPC.
   */
  send(supervisorId: string, message: ParentToChildMessage): void {
    const proc = this.processes.get(supervisorId);
    if (proc?.connected) {
      proc.send(message);
    }
  }

  /**
   * Handle an incoming IPC message from a child.
   * Updates state, enforces budget, forwards to caller.
   */
  handleMessage(message: ChildToParentMessage): void {
    const handle = this.handles.get(message.supervisorId);
    if (!handle) return;

    switch (message.type) {
      case "progress": {
        handle.costUsd += message.costDelta;
        handle.lastProgressAt = new Date().toISOString();
        this.resetStallTimer(message.supervisorId);
        if (handle.maxCostUsd !== undefined && handle.costUsd >= handle.maxCostUsd) {
          this.stopChild(message.supervisorId);
          return;
        }
        break;
      }
      case "session": {
        handle.sessionId = message.sessionId;
        break;
      }
      case "complete": {
        handle.status = "complete";
        this.clearStallTimer(message.supervisorId);
        break;
      }
      case "blocked": {
        handle.status = "blocked";
        this.clearStallTimer(message.supervisorId);
        break;
      }
      case "failed": {
        handle.status = "failed";
        this.clearStallTimer(message.supervisorId);
        break;
      }
    }

    this.persistChildren();
    this.onMessage(message);
  }

  /**
   * Remove a child from the registry and clean up.
   */
  remove(supervisorId: string): void {
    this.handles.delete(supervisorId);
    this.processes.delete(supervisorId);
    this.stopCallbacks.delete(supervisorId);
    this.clearStallTimer(supervisorId);
    this.persistChildren();
  }

  /**
   * Send stop to all children (called on daemon shutdown).
   */
  stopAll(): void {
    for (const supervisorId of this.handles.keys()) {
      this.send(supervisorId, { type: "stop" });
      this.clearStallTimer(supervisorId);
    }
  }

  private stopChild(supervisorId: string): void {
    const handle = this.handles.get(supervisorId);
    if (handle) {
      handle.status = "failed";
    }
    this.send(supervisorId, { type: "stop" });
    this.clearStallTimer(supervisorId);
    const stopCb = this.stopCallbacks.get(supervisorId);
    if (stopCb) stopCb();
    this.persistChildren();
    this.onMessage({
      type: "failed",
      supervisorId,
      error: "Budget exceeded",
    });
  }

  private persistChildren(): void {
    if (!this.childrenFilePath) return;
    const handles = this.list();
    // fire-and-forget — TUI polling is tolerant of brief inconsistency
    writeChildrenFile(this.childrenFilePath, handles).catch(() => {});
  }

  private resetStallTimer(supervisorId: string): void {
    this.clearStallTimer(supervisorId);
    const timer = setTimeout(() => {
      const handle = this.handles.get(supervisorId);
      if (handle?.status === "running") {
        handle.status = "stalled";
        this.persistChildren();
        this.onMessage({
          type: "failed",
          supervisorId,
          error: `Stall detected: no progress for ${this.stallTimeoutMs}ms`,
        });
      }
    }, this.stallTimeoutMs);
    this.stallTimers.set(supervisorId, timer);
  }

  private clearStallTimer(supervisorId: string): void {
    const timer = this.stallTimers.get(supervisorId);
    if (timer) {
      clearTimeout(timer);
      this.stallTimers.delete(supervisorId);
    }
  }
}
