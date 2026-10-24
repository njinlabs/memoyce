import { RecordId } from "surrealdb";

// Id record dibuat acak dan buram. Tanpa tanda minus supaya representasi teksnya bersih.
export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

// Bentuk teks id untuk pertukaran dengan AI pemanggil: "entity:abc123".
export function idToString(id: RecordId): string {
  return `${id.table.name}:${String(id.id)}`;
}

export function parseId(table: string, text: string): RecordId | undefined {
  const prefix = `${table}:`;
  if (!text.startsWith(prefix) || text.length === prefix.length) return undefined;
  return new RecordId(table, text.slice(prefix.length));
}
