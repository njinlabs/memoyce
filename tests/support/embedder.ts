import type { Embedder, EmbedKind } from "../../src/core/embedder";

// Embedder palsu: bag-of-words yang di-hash ke vektor berdimensi tetap lalu dinormalisasi.
// Teks yang berbagi kata punya kemiripan tinggi; teks tanpa kata sama mendekati 0. Ini BUKAN
// semantik sungguhan (sinonim tidak dikenali), jadi hanya cocok untuk menguji mekanisme.
export interface FakeEmbedder extends Embedder {
  calls: { texts: string[]; kind: EmbedKind }[];
  // Mengatur perilaku panggilan berikutnya.
  failNext(error?: Error): void;
  returnNext(vectors: number[][]): void;
}

const tokens = (text: string): string[] =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function embedText(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (const token of tokens(text)) {
    const index = fnv1a(token) % dimension;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

export function createFakeEmbedder(
  options: { model?: string; dimension?: number; maxBatch?: number } = {},
): FakeEmbedder {
  const dimension = options.dimension ?? 256;
  let failure: Error | undefined;
  let forced: number[][] | undefined;

  const embedder: FakeEmbedder = {
    model: options.model ?? "fake-bow",
    dimension,
    maxBatch: options.maxBatch,
    calls: [],
    failNext: (error = new Error("embedder mati")) => {
      failure = error;
    },
    returnNext: (vectors) => {
      forced = vectors;
    },
    async embed(texts, { kind }) {
      embedder.calls.push({ texts, kind });
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      if (forced) {
        const vectors = forced;
        forced = undefined;
        return vectors;
      }
      return texts.map((text) => embedText(text, dimension));
    },
  };
  return embedder;
}
