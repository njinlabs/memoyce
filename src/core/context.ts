import type { SurrealSession } from "surrealdb";
import { type AttributeRegistry, createRegistry, syncAttributes } from "./attributes";
import { migrate } from "./migrations";
import { type MemoryOptions, parseOptions } from "./options";
import { openStorage } from "./storage";

// Semua state satu instance memory. Tidak ada state global: aplikasi bebas membuat
// beberapa instance (tenant, tes) dengan penyimpanan berbeda.
export interface Ctx {
  db: SurrealSession;
  registry: AttributeRegistry;
}

export async function createContext(
  input: MemoryOptions,
): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const options = parseOptions(input);
  const storage = await openStorage(options.storage);

  try {
    await migrate(storage.db, options.migrate);
    if (options.migrate !== "off") await syncAttributes(storage.db, options.attributes);
  } catch (error) {
    await storage.close().catch(() => {});
    throw error;
  }

  return {
    ctx: { db: storage.db, registry: createRegistry(options.attributes, options.vocabulary) },
    close: storage.close,
  };
}
