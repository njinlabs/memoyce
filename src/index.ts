import { type ContextInput, type ContextResult, memoryContext } from "./core/briefing.ts";
import { createContext } from "./core/context.ts";
import type { MemoryOptions } from "./core/options.ts";
import { type RecallInput, type RecallResult, recall } from "./core/recall.ts";
import { reindex } from "./core/reindex.ts";
import { type RememberInput, type RememberResult, remember } from "./core/remember.ts";
import { createTools, type MemoryTool, type ToolsOptions } from "./core/tools.ts";

export type { ContextInput, ContextResult } from "./core/briefing.ts";
export type { Embedder, EmbedKind } from "./core/embedder.ts";
export { MemoryError, type MemoryErrorCode } from "./core/errors.ts";
export type { AttributeDef, MemoryOptions } from "./core/options.ts";
export type { EntityRefInfo, RecallInput, RecallItem, RecallResult } from "./core/recall.ts";
export type {
  EntityInfo,
  FactResult,
  RememberError,
  RememberInput,
  RememberResult,
} from "./core/remember.ts";
export type { MemoryTool, ToolsOptions } from "./core/tools.ts";

export interface Memory {
  // Menyimpan teks sumber dan fakta terstruktur. Kegagalan yang bisa diperbaiki pemanggil
  // dikembalikan sebagai data (`ok: false`), tidak dilempar.
  remember(input: RememberInput): Promise<RememberResult>;
  // Mencari memori relevan (vektor + kata kunci + graf). `found: false` berarti tidak tahu.
  recall(input: RecallInput): Promise<RecallResult>;
  // Konteks siap suntik ke prompt (system prompt atau pesan awal sesi), tanpa AI perlu memanggil
  // tool. Tanpa query: briefing fakta berlaku terbaru, sehingga AI bisa berinisiatif melanjutkan
  // konteks. Dengan query: fakta relevan. Selalu menyatakan tegas bila kosong/tidak tahu.
  context(input: ContextInput): Promise<ContextResult>;
  // Membangun ulang semua vektor dan mengisi teks fakta yang belum ada. Perlu embedder.
  reindex(): Promise<{ entities: number; facts: number }>;
  // Tool untuk AI aplikasi (memory_remember, memory_recall, memory_list_attributes), terikat
  // pada scope yang ditentukan APLIKASI: AI tidak bisa memilih atau mengubah scope.
  tools(options: ToolsOptions): MemoryTool[];
  // Menutup koneksi yang dibuka library. Koneksi milik aplikasi (storage.db) tidak ditutup.
  close(): Promise<void>;
}

export async function createMemory(options: MemoryOptions): Promise<Memory> {
  const { ctx, close } = await createContext(options);
  return {
    remember: (input) => remember(ctx, input),
    recall: (input) => recall(ctx, input),
    context: (input) => memoryContext(ctx, input),
    reindex: () => reindex(ctx),
    tools: (options) => createTools(ctx, options),
    close,
  };
}
