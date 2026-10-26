import { DateTime, RecordId } from "surrealdb";
import type { Attribute } from "./attributes.ts";

// Pemecah kata untuk mengukur kecocokan istilah: huruf kecil, tanpa tanda diakritik, dipisah pada
// apa pun selain huruf/angka. Mendekati analyzer full-text (blank, class, punct + ascii, lowercase).
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Normalisasi daftar kata dari aplikasi (huruf kecil, tanpa diakritik) menjadi himpunan.
export const termSet = (list: readonly string[]): Set<string> => new Set(list.flatMap(tokenize));

// Istilah query yang membawa makna, tanpa kata yang dinyatakan aplikasi sebagai kata fungsi
// (`retrieval.stopwords`). Library tidak membawa daftar bahasa apa pun; tanpa daftar, semua istilah
// dipakai. Bila semuanya kata fungsi, semua istilah dipakai.
export function contentTerms(query: string, stopwords: ReadonlySet<string> = new Set()): string[] {
  const all = [...new Set(tokenize(query))];
  const content = all.filter((term) => !stopwords.has(term));
  return content.length > 0 ? content : all;
}

// Teks tampilan nilai untuk fakta (dipakai full-text dan embedding).
export function displayValue(value: unknown, refName?: string): string {
  if (refName !== undefined) return refName;
  if (typeof value === "string") return value;
  if (value instanceof DateTime) return displayValue(value.toDate());
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (value instanceof RecordId) return String(value.id);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

// "PT Maju · anggaran (rupiah): 75000000 — Budget naik jadi 75 juta". Kalimat ini yang di-embed
// dan diindeks BM25; kutipan menambah konteks bahasa alami.
export function renderFactText(input: {
  entity: string;
  attribute: Pick<Attribute, "description">;
  value: string;
  quote?: string;
}): string {
  const base = `${input.entity} · ${input.attribute.description}: ${input.value}`;
  return input.quote ? `${base} — ${input.quote}` : base;
}
