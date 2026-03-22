import { EventEmitter } from "node:events";
import type { NeoEvent } from "@/types";

/**
 * Safe EventEmitter wrapper (ADR-022).
 *
 * - Catches listener errors to prevent cascading crashes
 * - Emits on both the specific event type and the wildcard "*" channel
 * - Swallows errors from the error handler itself to guarantee stability
 */
export class NeoEventEmitter {
  private readonly emitter = new EventEmitter();

  emit(event: NeoEvent): void {
    this.safeEmit(event.type, event);
    this.safeEmit("*", event);
  }

  on(eventType: string, listener: (event: NeoEvent) => void): this {
    this.emitter.on(eventType, listener);
    return this;
  }

  off(eventType: string, listener: (event: NeoEvent) => void): this {
    this.emitter.off(eventType, listener);
    return this;
  }

  once(eventType: string, listener: (event: NeoEvent) => void): this {
    this.emitter.once(eventType, listener);
    return this;
  }

  removeAllListeners(eventType?: string): this {
    this.emitter.removeAllListeners(eventType);
    return this;
  }

  private safeEmit(eventType: string, event: NeoEvent): void {
    try {
      this.emitter.emit(eventType, event);
    } catch (error) {
      if (eventType !== "error") {
        try {
          this.emitter.emit("error", error);
        } catch (nestedErr) {
          // Swallow — prevent crash even if error handler throws
          // This is a last-resort safety net to prevent infinite error loops
          console.error(
            "[emitter] Error handler threw:",
            nestedErr instanceof Error ? nestedErr.message : String(nestedErr),
          );
        }
      }
    }
  }
}
