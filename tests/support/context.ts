import { type Ctx, createContext } from "../../src/core/context";
import type { AttributeDef, MemoryOptions } from "../../src/core/options";

// Kosakata contoh untuk tes; library sendiri tidak membawa kosakata domain.
export const testAttributes: AttributeDef[] = [
  { key: "employer", description: "tempat bekerja", aliases: ["company", "works_at"] },
  { key: "city", description: "kota tinggal", aliases: ["kota"] },
  { key: "age", description: "usia", type: "number" },
  { key: "hobby", description: "hobi", cardinality: "multi" },
  { key: "is_vip", description: "pelanggan VIP", type: "boolean" },
  { key: "birthday", description: "tanggal lahir", type: "date" },
  { key: "works_for", description: "organisasi tempat bekerja", type: "entity" },
  { key: "knows", description: "kenalan", type: "entity", cardinality: "multi" },
  { key: "profile", description: "profil bebas", type: "json" },
];

export interface TestContext {
  ctx: Ctx;
  close(): Promise<void>;
}

// Penyimpanan mem:// (cepat, tanpa file); satu instance per file tes.
export async function openTestContext(options: Partial<MemoryOptions> = {}): Promise<TestContext> {
  const { ctx, close } = await createContext({
    storage: { url: "mem://" },
    attributes: testAttributes,
    ...options,
  });
  return { ctx, close };
}
