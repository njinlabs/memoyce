import type { DateTime, RecordId } from "surrealdb";
import { checkValue } from "./attributes";
import type { Ctx } from "./context";
import { MemoryError, type MemoryErrorCode } from "./errors";

export type FactStatus = "created" | "updated" | "unchanged";

export interface Fact {
  id: RecordId;
  scope: string;
  entity: RecordId;
  attribute: string;
  value: unknown;
  valid_from: DateTime;
  valid_to?: DateTime;
  source: RecordId;
}

interface AssertResult {
  status: FactStatus;
  id: RecordId;
}

const thrownMessages: Record<string, (what: string) => string> = {
  not_found: (what) => `${what} tidak ditemukan`,
  scope_mismatch: (what) => `${what} berada di scope lain`,
  stale_time: () => "waktu lebih awal dari fakta yang sedang berlaku",
};

// THROW di dalam transaksi berformat "kode:detail"; diubah kembali menjadi MemoryError.
function mapThrown(error: unknown): never {
  const text = String(error instanceof Error ? error.message : error);
  const thrown = /(not_found|scope_mismatch|stale_time):([a-z_]+)/.exec(text);
  const code = thrown?.[1];
  const what = thrown?.[2] ?? "";
  const message = code ? thrownMessages[code]?.(what) : undefined;
  if (code && message) throw new MemoryError(code as MemoryErrorCode, message, { what });
  throw error;
}

// Pembaruan nilai = tutup fakta lama + buat fakta baru, satu transaksi. Fakta tanpa source
// (di scope yang sama) ditolak. Atribut bernilai tunggal: nilai baru menutup nilai lama.
// Atribut multi: nilai ditambahkan, nilai lain tidak disentuh (gunakan retractFact).
export async function assertFact(
  ctx: Ctx,
  input: {
    scope: string;
    entity: RecordId;
    attribute: string;
    value: unknown;
    source: RecordId;
    at?: Date;
  },
): Promise<AssertResult> {
  const attribute = ctx.registry.resolve(input.attribute);
  checkValue(attribute, input.value);
  const at = input.at ?? new Date();

  let results: unknown[];
  try {
    results = await ctx.db
      .query<unknown[]>(
        `BEGIN;
         LET $src = (SELECT VALUE scope FROM ONLY $source);
         IF $src = NONE { THROW "not_found:source"; };
         IF $src != $scope { THROW "scope_mismatch:source"; };
         LET $ent = (SELECT VALUE scope FROM ONLY $entity);
         IF $ent = NONE { THROW "not_found:entity"; };
         IF $ent != $scope { THROW "scope_mismatch:entity"; };
         IF $ref != NONE {
           LET $refScope = (SELECT VALUE scope FROM ONLY $ref);
           IF $refScope = NONE { THROW "not_found:value"; };
           IF $refScope != $scope { THROW "scope_mismatch:value"; };
         };
         LET $cur = (SELECT * FROM fact
           WHERE scope = $scope AND entity = $entity AND attribute = $attribute
             AND valid_to = NONE);
         LET $head = IF $multi { $cur[WHERE value = $value][0] } ELSE { $cur[0] };
         IF !$multi AND $head != NONE AND $head.valid_from > $at { THROW "stale_time:fact"; };
         LET $same = $head != NONE AND $head.value = $value;
         IF !$same AND !$multi {
           UPDATE fact SET valid_to = $at
             WHERE scope = $scope AND entity = $entity AND attribute = $attribute
               AND valid_to = NONE;
         };
         LET $new = IF $same { NONE } ELSE {
           (CREATE ONLY fact SET scope = $scope, entity = $entity, attribute = $attribute,
             value = $value, valid_from = $at, source = $source)
         };
         RETURN {
           status: IF $same { "unchanged" } ELSE IF $head = NONE OR $multi { "created" }
             ELSE { "updated" },
           id: IF $same { $head.id } ELSE { $new.id }
         };
         COMMIT;`,
        {
          scope: input.scope,
          entity: input.entity,
          attribute: attribute.key,
          value: input.value,
          source: input.source,
          ref: attribute.type === "entity" ? input.value : undefined,
          multi: attribute.cardinality === "multi",
          at,
        },
      )
      .collect();
  } catch (error) {
    mapThrown(error);
  }

  // Transaksi mengembalikan satu entri per statement; ambil hasil RETURN.
  const result = results.find((r) => r && typeof r === "object" && "status" in r);
  if (!result) throw new MemoryError("storage", "assertFact tidak mengembalikan hasil");
  return result as AssertResult;
}

// Menutup fakta yang sedang berlaku (bukan menghapus). Tanpa `value`, semua nilai yang
// sedang berlaku untuk atribut itu ditutup. Mengembalikan jumlah fakta yang ditutup.
export async function retractFact(
  ctx: Ctx,
  input: {
    scope: string;
    entity: RecordId;
    attribute: string;
    value?: unknown;
    at?: Date;
  },
): Promise<number> {
  const attribute = ctx.registry.resolve(input.attribute);
  const hasValue = input.value !== undefined;
  if (hasValue) checkValue(attribute, input.value);

  let closed: unknown[];
  try {
    [closed = []] = await ctx.db
      .query<[unknown[]]>(
        `UPDATE fact SET valid_to = $at
           WHERE scope = $scope AND entity = $entity AND attribute = $attribute
             AND valid_to = NONE AND ($any OR value = $value)
           RETURN VALUE id`,
        {
          scope: input.scope,
          entity: input.entity,
          attribute: attribute.key,
          value: input.value,
          any: !hasValue,
          at: input.at ?? new Date(),
        },
      )
      .collect();
  } catch (error) {
    // Penutupan sebelum valid_from melanggar ASSERT valid_to pada skema.
    throw new MemoryError("stale_time", thrownMessages.stale_time?.("") ?? "stale_time", {
      cause: String(error),
    });
  }
  if (closed.length === 0) {
    throw new MemoryError("not_found", "tidak ada fakta berlaku yang cocok", {
      attribute: attribute.key,
    });
  }
  return closed.length;
}

// Fakta yang benar pada waktu `at` (default: sekarang), terbatas pada scope yang diminta.
export async function factsAt(
  ctx: Ctx,
  input: { scope: string | string[]; entity: RecordId; at?: Date },
): Promise<Fact[]> {
  const [rows] = await ctx.db
    .query<[Fact[]]>(
      `SELECT * FROM fact
       WHERE scope IN $scopes AND entity = $entity AND valid_from <= $at
         AND (valid_to = NONE OR valid_to > $at)`,
      {
        scopes: Array.isArray(input.scope) ? input.scope : [input.scope],
        entity: input.entity,
        at: input.at ?? new Date(),
      },
    )
    .collect();
  return rows ?? [];
}
