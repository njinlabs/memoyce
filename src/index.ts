import { createContext } from "./core/context";
import type { MemoryOptions } from "./core/options";
import { type RecallInput, type RecallResult, recall } from "./core/recall";
import { reindex } from "./core/reindex";
import { type RememberInput, type RememberResult, remember } from "./core/remember";

export type { Embedder, EmbedKind } from "./core/embedder";
export { MemoryError, type MemoryErrorCode } from "./core/errors";
export type { AttributeDef, MemoryOptions } from "./core/options";
export type { EntityRefInfo, RecallInput, RecallItem, RecallResult } from "./core/recall";
export type {
  EntityInfo,
  FactResult,
  RememberError,
  RememberInput,
  RememberResult,
} from "./core/remember";

export interface Memory {
  // Menyimpan teks sumber dan fakta terstruktur. Kegagalan yang bisa diperbaiki pemanggil
  // dikembalikan sebagai data (`ok: false`), tidak dilempar.
  remember(input: RememberInput): Promise<RememberResult>;
  // Mencari memori relevan (vektor + kata kunci + graf). `found: false` berarti tidak tahu.
  recall(input: RecallInput): Promise<RecallResult>;
  // Membangun ulang semua vektor dan mengisi teks fakta yang belum ada. Perlu embedder.
  reindex(): Promise<{ entities: number; facts: number }>;
  // Menutup koneksi yang dibuka library. Koneksi milik aplikasi (storage.db) tidak ditutup.
  close(): Promise<void>;
}

export async function createMemory(options: MemoryOptions): Promise<Memory> {
  const { ctx, close } = await createContext(options);
  return {
    remember: (input) => remember(ctx, input),
    recall: (input) => recall(ctx, input),
    reindex: () => reindex(ctx),
    close,
  };
}
