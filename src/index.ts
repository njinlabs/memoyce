import { createContext } from "./core/context";
import type { MemoryOptions } from "./core/options";

export { MemoryError, type MemoryErrorCode } from "./core/errors";
export type { AttributeDef, MemoryOptions } from "./core/options";

export interface Memory {
  // Menutup koneksi yang dibuka library. Koneksi milik aplikasi (storage.db) tidak ditutup.
  close(): Promise<void>;
}

export async function createMemory(options: MemoryOptions): Promise<Memory> {
  const { close } = await createContext(options);
  return { close };
}
