// ─── Embedder interface ──────────────────────────────────

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

// ─── Local embedder (Transformers.js) ────────────────────

let extractorPromise: Promise<unknown> | null = null;

function getExtractor(): Promise<unknown> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "fp32",
      });
    })();
  }
  return extractorPromise;
}

export class LocalEmbedder implements Embedder {
  readonly dimensions = 384;

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = (await getExtractor()) as (
      texts: string[],
      opts: { pooling: string; normalize: boolean },
    ) => Promise<{ tolist(): number[][] }>;
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

// ─── Cosine similarity ──────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) * (a[i] ?? 0);
    normB += (b[i] ?? 0) * (b[i] ?? 0);
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
