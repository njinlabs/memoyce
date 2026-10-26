import type { SurrealSession } from "surrealdb";
import { type AttributeRegistry, createRegistry, syncAttributes } from "./attributes.ts";
import type { Embedder } from "./embedder.ts";
import { migrate } from "./migrations.ts";
import { type MemoryOptions, parseOptions, type Retrieval } from "./options.ts";
import { checkEmbedding } from "./reindex.ts";
import { openStorage } from "./storage.ts";
import { createVectorStore, type VectorStore } from "./vectors.ts";

// Semua state satu instance memory. Tidak ada state global: aplikasi bebas membuat
// beberapa instance (tenant, tes) dengan penyimpanan berbeda.
export interface Ctx {
  db: SurrealSession;
  registry: AttributeRegistry;
  retrieval: Retrieval;
  // Keduanya ada atau tidak ada bersamaan (bergantung pada opsi `embedder`).
  embedder?: Embedder;
  vectors?: VectorStore;
}

export async function createContext(
  input: MemoryOptions,
): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const options = parseOptions(input);
  const storage = await openStorage(options.storage);

  try {
    await migrate(storage.db, options.migrate);
    if (options.migrate !== "off") await syncAttributes(storage.db, options.attributes);

    const ctx: Ctx = {
      db: storage.db,
      registry: createRegistry(options.attributes, options.vocabulary),
      retrieval: options.retrieval,
    };
    if (options.embedder) {
      ctx.embedder = options.embedder;
      ctx.vectors = createVectorStore(storage.db, options.embedder.dimension);
      await checkEmbedding(ctx, options.onEmbedderChange);
    }
    return { ctx, close: storage.close };
  } catch (error) {
    await storage.close().catch(() => {});
    throw error;
  }
}
