import { z } from "zod";
import { MemoryError } from "./errors";

export type EmbedKind = "document" | "query";

// Disediakan aplikasi pemakai; library tidak membawa kode penyedia apa pun. `kind` ada karena
// banyak model (e5, Voyage, Cohere) memperlakukan query dan dokumen secara berbeda.
export interface Embedder {
  model: string;
  dimension: number;
  // Batas jumlah teks per panggilan; teks dipecah otomatis (default 64).
  maxBatch?: number;
  embed(texts: string[], options: { kind: EmbedKind }): Promise<number[][]>;
}

export const embedderSchema = z.custom<Embedder>((v) => {
  const e = v as Partial<Embedder> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.model === "string" &&
    e.model.length > 0 &&
    Number.isInteger(e.dimension) &&
    (e.dimension as number) > 0 &&
    typeof e.embed === "function" &&
    (e.maxBatch === undefined || (Number.isInteger(e.maxBatch) && e.maxBatch > 0))
  );
}, "embedder harus berisi model, dimension (bilangan bulat > 0), dan fungsi embed");

const DEFAULT_BATCH = 64;

// Kegagalan embedder adalah galat infrastruktur: dilempar sebagai MemoryError("embedder"),
// dan karena embedding dibuat sebelum penulisan, tidak ada data setengah tertulis.
export async function embedTexts(
  embedder: Embedder,
  texts: string[],
  kind: EmbedKind,
): Promise<number[][]> {
  const size = embedder.maxBatch ?? DEFAULT_BATCH;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    let result: number[][];
    try {
      result = await embedder.embed(batch, { kind });
    } catch (cause) {
      throw new MemoryError("embedder", `embedder gagal: ${String(cause)}`, {
        cause: String(cause),
      });
    }
    const valid =
      Array.isArray(result) &&
      result.length === batch.length &&
      result.every(
        (v) =>
          Array.isArray(v) &&
          v.length === embedder.dimension &&
          v.every((x) => typeof x === "number" && Number.isFinite(x)),
      );
    if (!valid) {
      throw new MemoryError(
        "embedder",
        `embedder mengembalikan ${batch.length} vektor berdimensi ${embedder.dimension} yang valid; hasil tidak sesuai`,
        { expectedDimension: embedder.dimension, expectedCount: batch.length },
      );
    }
    vectors.push(...result);
  }
  return vectors;
}
