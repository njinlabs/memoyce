import { RecordId, type SurrealSession } from "surrealdb";
import { MemoryError } from "./errors";
import { normalizeName, type ResolvedAttribute } from "./options";

export type Attribute = ResolvedAttribute;

export interface AttributeRegistry {
  vocabulary: "strict" | "open";
  all(): Attribute[];
  // Nama atau alias menjadi definisi kanonik. Strict: atribut tak dikenal ditolak dengan saran.
  // Open: atribut tak dikenal diterima sebagai atribut json bernilai tunggal.
  resolve(name: string): Attribute;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

export function createRegistry(
  attributes: Attribute[],
  vocabulary: "strict" | "open",
): AttributeRegistry {
  const byName = new Map<string, Attribute>();
  for (const attribute of attributes) {
    for (const name of [attribute.key, ...attribute.aliases]) {
      byName.set(normalizeName(name), attribute);
    }
  }

  function suggest(name: string): string[] {
    return [...byName.entries()]
      .map(([candidate, attribute]) => ({
        key: attribute.key,
        score: candidate.includes(name) || name.includes(candidate) ? 0 : distance(name, candidate),
      }))
      .filter((c) => c.score <= Math.max(2, Math.floor(name.length / 3)))
      .sort((a, b) => a.score - b.score)
      .map((c) => c.key)
      .filter((key, i, all) => all.indexOf(key) === i)
      .slice(0, 3);
  }

  return {
    vocabulary,
    all: () => attributes,
    resolve(name) {
      const normalized = normalizeName(name);
      const found = byName.get(normalized);
      if (found) return found;
      if (vocabulary === "open" && /^[a-z][a-z0-9_]*$/.test(normalized)) {
        return {
          key: normalized,
          description: normalized,
          type: "json",
          cardinality: "single",
          aliases: [],
        };
      }
      const suggestions = suggest(normalized);
      throw new MemoryError(
        "unknown_attribute",
        `atribut "${name}" tidak terdaftar` +
          (suggestions.length > 0 ? `; maksud Anda: ${suggestions.join(", ")}?` : ""),
        { attribute: name, suggestions, valid: attributes.map((a) => a.key) },
      );
    },
  };
}

// Nilai literal diperiksa terhadap tipe atribut. Pemeriksaan keberadaan dan scope untuk nilai
// bertipe entity dilakukan di dalam transaksi assertFact.
export function checkValue(attribute: Attribute, value: unknown): void {
  const ok = {
    string: typeof value === "string" && value.length > 0,
    number: typeof value === "number" && Number.isFinite(value),
    boolean: typeof value === "boolean",
    date: value instanceof Date && !Number.isNaN(value.getTime()),
    entity: value instanceof RecordId && value.table.name === "entity",
    json: value !== null && value !== undefined,
  }[attribute.type];
  if (!ok) {
    throw new MemoryError(
      "invalid_value",
      `nilai untuk atribut "${attribute.key}" harus bertipe ${attribute.type}`,
      { attribute: attribute.key, expected: attribute.type },
    );
  }
}

// Registri di DB hanya cermin dari konfigurasi aplikasi, supaya isi database bisa dibaca
// sendiri (tipe dan kardinalitas) tanpa kode aplikasi. Atribut yang sudah tidak ada di
// konfigurasi ditandai tidak aktif, tidak dihapus, karena fakta lama masih memakainya.
export async function syncAttributes(db: SurrealSession, attributes: Attribute[]): Promise<void> {
  await db.query(
    `BEGIN;
     UPDATE attribute SET active = false;
     FOR $a IN $attributes {
       UPSERT type::record("attribute", $a.key) CONTENT {
         description: $a.description, type: $a.type, cardinality: $a.cardinality,
         aliases: $a.aliases, active: true
       };
     };
     COMMIT;`,
    { attributes },
  );
}
