import { createHash } from "node:crypto";
import type { SurrealSession } from "surrealdb";

// Vektor disimpan per scope, satu tabel + satu index HNSW per scope. Alasannya terukur:
// KNN dengan filter scope di SurrealDB berbiaya linier terhadap ukuran scope (0,3-2 detik
// pada 90 ribu baris), sedangkan KNN tanpa filter di dalam partisi tidak terpengaruh scope
// lain. Data ini turunan: boleh dibangun ulang kapan saja (reindex).
export type VectorKind = "fvec" | "evec";

const EFC = 150;
const M = 12;

export function partitionTable(kind: VectorKind, scope: string): string {
  return `${kind}_${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
}

export function partitionDdl(kind: VectorKind, table: string, dimension: number): string {
  const target = kind === "fvec" ? "fact" : "entity";
  const validity =
    kind === "fvec"
      ? `DEFINE FIELD IF NOT EXISTS valid_from ON ${table} TYPE datetime;
         DEFINE FIELD IF NOT EXISTS valid_to ON ${table} TYPE option<datetime>;`
      : "";
  return `
    DEFINE TABLE IF NOT EXISTS ${table} SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS ref ON ${table} TYPE record<${target}>;
    DEFINE FIELD IF NOT EXISTS scope ON ${table} TYPE string;
    DEFINE FIELD IF NOT EXISTS embedding ON ${table} TYPE array<float>;
    ${validity}
    DEFINE INDEX IF NOT EXISTS ${table}_hnsw ON ${table} FIELDS embedding
      HNSW DIMENSION ${dimension} DIST COSINE TYPE F32 EFC ${EFC} M ${M};`;
}

export interface VectorStore {
  dimension: number;
  // Membuat partisi bila belum ada (idempoten, hanya sekali per proses per scope).
  ensure(kind: VectorKind, scope: string): Promise<string>;
  // Melupakan cache partisi (setelah partisi dihapus oleh reindex).
  reset(): void;
}

export function createVectorStore(db: SurrealSession, dimension: number): VectorStore {
  const ready = new Map<string, Promise<void>>();
  return {
    dimension,
    async ensure(kind, scope) {
      const table = partitionTable(kind, scope);
      let pending = ready.get(table);
      if (!pending) {
        pending = db
          .query(partitionDdl(kind, table, dimension))
          .collect()
          .then(() => {});
        ready.set(table, pending);
        pending.catch(() => ready.delete(table));
      }
      await pending;
      return table;
    },
    reset: () => ready.clear(),
  };
}
