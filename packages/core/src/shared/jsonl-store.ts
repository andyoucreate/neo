import { createReadStream } from "node:fs";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { z } from "zod";
import { ensureDir } from "@/shared/fs";

/** Maximum file size for operations that read entire file into memory (100MB) */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Generic append-only JSONL store with versioned updates.
 * Replaces full-file rewrites (O(N²)) with append-only mutations (O(1)).
 *
 * @template T - The type of records stored (must have an `id` field)
 *
 * @example
 * ```ts
 * const store = new JsonlStore({
 *   filePath: "/tmp/events.jsonl",
 *   schema: eventSchema,
 *   idField: "id"
 * });
 *
 * // Append new record
 * await store.append({ id: "evt_1", type: "click" });
 *
 * // Update existing record (appends mutation with _version)
 * await store.update("evt_1", { type: "submit" });
 *
 * // Read all records (merges versions by ID)
 * const events = await store.readAll();
 * ```
 */
export class JsonlStore<T extends Record<string, unknown>> {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly dirCache = new Set<string>();
  private readonly schema: z.ZodSchema<T>;
  private readonly idField: keyof T;

  /** Promise-based mutex to serialize write operations */
  private writeLock: Promise<void> = Promise.resolve();

  /** In-memory index tracking latest version per ID */
  private index = new Map<string, number>();

  /** Flag to track if index has been initialized from disk */
  private indexInitialized = false;

  constructor(options: {
    filePath: string;
    schema: z.ZodSchema<T>;
    idField: keyof T;
  }) {
    this.filePath = options.filePath;
    this.dir = path.dirname(options.filePath);
    this.schema = options.schema;
    this.idField = options.idField;
  }

  /**
   * Append a new record to the JSONL file.
   * Records are written with _version: 1 (initial version).
   *
   * @throws Error if a record with the same ID already exists
   */
  async append(record: T): Promise<void> {
    await this.withWriteLock(async () => {
      await ensureDir(this.dir, this.dirCache);

      const id = String(record[this.idField]);

      // Ensure index is initialized from disk before checking for duplicates
      if (!this.indexInitialized) {
        await this.rebuildIndex();
        this.indexInitialized = true;
      }

      // Check if ID already exists in index to prevent duplicate version 1
      if (this.index.has(id)) {
        throw new Error(
          `Record with id "${id}" already exists. Use update() to modify existing records.`,
        );
      }

      const versioned = { ...record, _version: 1 };

      await appendFile(this.filePath, `${JSON.stringify(versioned)}\n`, "utf-8");

      // Update index
      this.index.set(id, 1);
    });
  }

  /**
   * Update an existing record by appending a mutation.
   * The update is merged with the existing record on read.
   * Increments the _version field to track mutation order.
   *
   * @param id - The ID of the record to update
   * @param patch - Partial updates to apply
   */
  async update(id: string, patch: Partial<T>): Promise<void> {
    await this.withWriteLock(async () => {
      // Ensure directory exists
      await ensureDir(this.dir, this.dirCache);

      // Get current version from index (or read from file if index is stale)
      let currentVersion = this.index.get(id);
      if (currentVersion === undefined) {
        // Index miss — rebuild from file
        await this.rebuildIndex();
        currentVersion = this.index.get(id);

        if (currentVersion === undefined) {
          throw new Error(`Record not found: ${id}`);
        }
      }

      const nextVersion = currentVersion + 1;
      const mutation = {
        ...patch,
        [this.idField]: id,
        _version: nextVersion,
      };

      await appendFile(this.filePath, `${JSON.stringify(mutation)}\n`, "utf-8");

      // Update index
      this.index.set(id, nextVersion);
    });
  }

  /**
   * Read all records from the JSONL file, merging versions by ID.
   * Returns the latest version of each record.
   *
   * Uses streaming line-by-line parsing to handle large files.
   * Skips malformed JSONL lines with console.debug warning.
   */
  async readAll(): Promise<T[]> {
    const records = await this.streamAndMergeRecords();
    // Mark index as initialized after first read
    this.indexInitialized = true;
    return this.validateAndStripVersions(records);
  }

  /**
   * Stream JSONL file and merge record versions by ID.
   * Returns a Map of the latest version of each record.
   */
  private async streamAndMergeRecords(): Promise<Map<string, T>> {
    const records = new Map<string, T>();

    try {
      const stream = createReadStream(this.filePath, { encoding: "utf-8" });
      const rl = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        this.parseAndMergeLine(line, records);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet — return empty map
        return records;
      }
      throw error;
    }

    return records;
  }

  /**
   * Parse a single JSONL line and merge it into the records map.
   */
  private parseAndMergeLine(line: string, records: Map<string, T>): void {
    try {
      const parsed = JSON.parse(line) as T & { _version?: number };
      const id = String(parsed[this.idField]);

      // Merge with existing record (if any)
      const existing = records.get(id);
      if (existing) {
        // Apply patch — newer version wins
        records.set(id, { ...existing, ...parsed });
      } else {
        records.set(id, parsed);
      }

      // Update index with latest version
      if (parsed._version !== undefined) {
        const currentVersion = this.index.get(id) ?? 0;
        if (parsed._version > currentVersion) {
          this.index.set(id, parsed._version);
        }
      }
    } catch (error) {
      // Skip malformed JSONL line
      // biome-ignore lint/suspicious/noConsole: Intentional warning for parse failures
      console.debug(
        `[JsonlStore] Skipping malformed JSONL line: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /**
   * Validate records and strip internal _version field.
   */
  private validateAndStripVersions(records: Map<string, T>): T[] {
    const result: T[] = [];
    for (const record of records.values()) {
      try {
        // Strip internal fields before validation
        const { _version, ...data } = record as T & { _version?: number };
        const validated = this.schema.parse(data);
        result.push(validated);
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: Intentional warning for validation failures
        console.debug(
          `[JsonlStore] Skipping invalid record: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    return result;
  }

  /**
   * Rebuild the in-memory index from the JSONL file.
   * Scans all records and tracks the latest version per ID.
   */
  private async rebuildIndex(): Promise<void> {
    this.index.clear();

    try {
      // Guard against OOM on large files
      const stats = await stat(this.filePath);
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `File size (${stats.size} bytes) exceeds maximum (${MAX_FILE_SIZE_BYTES} bytes). Use compact() to reduce file size.`,
        );
      }

      const content = await readFile(this.filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as T & { _version?: number };
          const id = String(parsed[this.idField]);
          const version = parsed._version ?? 1;

          const currentVersion = this.index.get(id) ?? 0;
          if (version > currentVersion) {
            this.index.set(id, version);
          }
        } catch (error) {
          // Skip malformed lines during index rebuild
          // biome-ignore lint/suspicious/noConsole: Intentional warning for parse failures
          console.debug(
            `[JsonlStore] Skipping malformed line during index rebuild: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet — index remains empty
        return;
      }
      throw error;
    }
  }

  /**
   * Acquire the write lock and execute a callback.
   * Serializes all write operations to prevent race conditions.
   */
  private async withWriteLock<R>(fn: () => Promise<R>): Promise<R> {
    // Chain onto the existing lock
    const release = this.writeLock;
    let releaseLock: () => void = () => {};
    this.writeLock = new Promise((r) => {
      releaseLock = r;
    });

    try {
      // Wait for previous operation to complete
      await release;
      return await fn();
    } finally {
      // Release the lock for the next operation
      releaseLock();
    }
  }

  /**
   * Compact the JSONL file by removing old versions of records.
   * Rewrites the file with only the latest version of each record.
   *
   * This is an O(N) operation that should be called periodically
   * to prevent unbounded file growth.
   */
  async compact(): Promise<void> {
    await this.withWriteLock(async () => {
      // Guard against OOM on corrupted/malicious files
      try {
        const stats = await stat(this.filePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(
            `File size (${stats.size} bytes) exceeds maximum (${MAX_FILE_SIZE_BYTES} bytes). Cannot compact oversized file.`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        // File doesn't exist yet — nothing to compact
        return;
      }

      const records = await this.readAll();

      await ensureDir(this.dir, this.dirCache);

      // Rewrite file with only latest versions
      const lines = records.map((record) => {
        const version = this.index.get(String(record[this.idField])) ?? 1;
        return JSON.stringify({ ...record, _version: version });
      });

      await writeFile(this.filePath, `${lines.join("\n")}\n`, "utf-8");

      // Index remains valid after compaction
    });
  }
}
