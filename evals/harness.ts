import type { Embedder, Memory } from "../src/index";
import type { EvalQuestion, SeedStep } from "./dataset";
import { type Score, type SweepPoint, scoreQuestion, summarize } from "./metrics";

// Mengisi memori dengan korpus (urut waktu, seperti percakapan sungguhan). Berhenti dengan galat
// bila ada langkah yang ditolak: itu berarti dataset-nya rusak, bukan hasil evaluasi.
export async function seed(memory: Memory, steps: SeedStep[]): Promise<number> {
  const ordered = [...steps].sort((a, b) =>
    (a.source.received_at ?? "").localeCompare(b.source.received_at ?? ""),
  );
  let facts = 0;
  for (const [index, step] of ordered.entries()) {
    const result = await memory.remember(step);
    if (!result.ok && result.stage === "validation") {
      throw new Error(`seed langkah ${index} ditolak: ${JSON.stringify(result.errors)}`);
    }
    const failed = result.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      throw new Error(`seed langkah ${index} gagal menulis: ${JSON.stringify(failed)}`);
    }
    facts += result.results.length;
  }
  return facts;
}

export interface Thresholds {
  min_similarity?: number;
  min_keyword_coverage?: number;
}

export async function evaluate(
  memory: Memory,
  questions: EvalQuestion[],
  thresholds: Thresholds = {},
): Promise<Score[]> {
  const scores: Score[] = [];
  for (const question of questions) {
    const result = await memory.recall({
      scope: question.scope,
      query: question.query,
      as_of: question.as_of,
      ...thresholds,
    });
    scores.push(scoreQuestion(question, result));
  }
  return scores;
}

export async function sweep(
  memory: Memory,
  questions: EvalQuestion[],
  grid: { similarities: number[]; coverages: number[] },
): Promise<SweepPoint[]> {
  const points: SweepPoint[] = [];
  for (const minSimilarity of grid.similarities) {
    for (const minKeywordCoverage of grid.coverages) {
      const scores = await evaluate(memory, questions, {
        min_similarity: minSimilarity,
        min_keyword_coverage: minKeywordCoverage,
      });
      points.push({ minSimilarity, minKeywordCoverage, summary: summarize(scores) });
    }
  }
  return points;
}

// Membatasi laju panggilan dan mengulang saat kena batas kuota (429), mis. Gemini tier gratis:
// 100 permintaan per menit. Ini urusan aplikasi/harness, bukan library.
export function throttleEmbedder(
  embedder: Embedder,
  options: {
    minIntervalMs?: number;
    retries?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Embedder {
  const { minIntervalMs = 700, retries = 6, retryDelayMs = 15_000 } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 0;
  return {
    model: embedder.model,
    dimension: embedder.dimension,
    maxBatch: embedder.maxBatch,
    async embed(texts, opts) {
      for (let attempt = 0; ; attempt++) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try {
          return await embedder.embed(texts, opts);
        } catch (error) {
          const quota = /429|RESOURCE_EXHAUSTED/.test(String(error));
          if (!quota || attempt >= retries) throw error;
          await sleep(retryDelayMs);
        }
      }
    },
  };
}

// Embedding query yang sama dipakai ulang antar titik sapuan, supaya sapuan tidak memanggil API
// ratusan kali. Embedding dokumen tidak di-cache (hanya dipanggil saat seed).
export function cacheQueryEmbeddings(embedder: Embedder): Embedder {
  const cache = new Map<string, number[]>();
  return {
    model: embedder.model,
    dimension: embedder.dimension,
    maxBatch: embedder.maxBatch,
    async embed(texts, options) {
      if (options.kind !== "query") return embedder.embed(texts, options);
      const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
      if (missing.length > 0) {
        const vectors = await embedder.embed(missing, options);
        for (const [i, text] of missing.entries()) cache.set(text, vectors[i] as number[]);
      }
      return texts.map((t) => cache.get(t) as number[]);
    },
  };
}
