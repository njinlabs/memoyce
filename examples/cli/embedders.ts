import type { GoogleGenAI } from "@google/genai";
import type { Embedder } from "../../src/index";

// Dua contoh embedder. Library tidak membawa kode penyedia; aplikasi yang menulisnya.
// Nama model memuat dimensi supaya mengganti dimensi terdeteksi sebagai model berbeda (reindex).

export function openAiEmbedder(options: {
  apiKey: string;
  model?: string;
  dimension?: number;
  fetchImpl?: typeof fetch;
}): Embedder {
  const model = options.model ?? "text-embedding-3-small";
  const dimension = options.dimension ?? 768;
  const request = options.fetchImpl ?? fetch;
  return {
    model: `openai:${model}@${dimension}`,
    dimension,
    maxBatch: 100,
    async embed(texts) {
      const response = await request("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts, dimensions: dimension }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI embeddings ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

export function geminiEmbedder(options: {
  ai: Pick<GoogleGenAI, "models">;
  model?: string;
  dimension?: number;
}): Embedder {
  const model = options.model ?? "gemini-embedding-001";
  const dimension = options.dimension ?? 768;
  return {
    model: `gemini:${model}@${dimension}`,
    dimension,
    maxBatch: 100,
    async embed(texts, { kind }) {
      const result = await options.ai.models.embedContent({
        model,
        contents: texts,
        config: {
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: dimension,
        },
      });
      return (result.embeddings ?? []).map((e) => e.values ?? []);
    },
  };
}
