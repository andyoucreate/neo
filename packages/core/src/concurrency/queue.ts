import type { Priority } from "../types.js";

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface QueueItem<T> {
  value: T;
  priority: Priority;
  insertionOrder: number;
}

/**
 * FIFO priority queue. Items with higher priority (critical > high > medium > low)
 * are dequeued first. Within the same priority level, FIFO order is maintained.
 */
export class PriorityQueue<T> {
  private readonly items: QueueItem<T>[] = [];
  private readonly maxSize: number;
  private insertionCounter = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  enqueue(value: T, priority: Priority): void {
    // Reset counter when queue is empty to prevent overflow after prolonged use
    if (this.items.length === 0) {
      this.insertionCounter = 0;
    }

    if (this.items.length >= this.maxSize) {
      throw new Error(`Queue full (${this.maxSize} items). Cannot enqueue.`);
    }

    const item: QueueItem<T> = {
      value,
      priority,
      insertionOrder: this.insertionCounter++,
    };

    // Insert in sorted position (binary search would be overkill for queue sizes ≤ 50)
    let inserted = false;
    for (let i = 0; i < this.items.length; i++) {
      const existing = this.items[i];
      if (existing && this.comparePriority(item, existing) < 0) {
        this.items.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.items.push(item);
    }
  }

  dequeue(): T | undefined {
    const item = this.items.shift();
    return item?.value;
  }

  peek(): T | undefined {
    return this.items[0]?.value;
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  remove(predicate: (item: T) => boolean): boolean {
    const index = this.items.findIndex((entry) => predicate(entry.value));
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  /** Dequeue the first item matching the predicate (respects priority order). */
  dequeueWhere(predicate: (item: T) => boolean): T | undefined {
    const index = this.items.findIndex((entry) => predicate(entry.value));
    if (index === -1) return undefined;
    const removed = this.items.splice(index, 1)[0];
    if (!removed) return undefined;
    return removed.value;
  }

  /** Compare by priority first, then by insertion order (FIFO within same priority). */
  private comparePriority(a: QueueItem<T>, b: QueueItem<T>): number {
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.insertionOrder - b.insertionOrder;
  }
}
