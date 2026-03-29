// ─── Embedder interface ──────────────────────────────────
// Vector embedding support removed (ADR-cleanup).
// FTS5 full-text search is sufficient for memory queries.

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}
