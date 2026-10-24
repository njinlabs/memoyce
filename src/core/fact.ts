import { type DateTime, type RecordId, RecordId as Rid } from "surrealdb";
import { db } from "./db";

export type FactStatus = "created" | "updated" | "unchanged";

export interface Fact {
  id: RecordId;
  entity: RecordId;
  attribute: string;
  value: unknown;
  valid_from: DateTime;
  valid_to?: DateTime;
  source: RecordId;
}

export async function createSource(
  content: string,
  meta?: Record<string, unknown>,
  receivedAt: Date = new Date(),
): Promise<RecordId> {
  const row = await db
    .create<{ id: RecordId }>(new Rid("source", crypto.randomUUID()))
    .content({ content, received_at: receivedAt, meta });
  return row.id;
}

export async function createEntity(
  name: string,
  kind: string,
  aliases: string[] = [],
): Promise<RecordId> {
  const row = await db
    .create<{ id: RecordId }>(new Rid("entity", crypto.randomUUID()))
    .content({ name, kind, aliases });
  return row.id;
}

// Pembaruan nilai = tutup fakta lama + buat fakta baru, satu transaksi.
// Fakta tanpa source ditolak. Atribut diperlakukan bernilai tunggal per entitas.
export async function assertFact(input: {
  entity: RecordId;
  attribute: string;
  value: unknown;
  source: RecordId;
  at?: Date;
}): Promise<{ status: FactStatus; id: RecordId }> {
  const at = input.at ?? new Date();
  // Transaksi mengembalikan satu entri per statement; ambil hasil RETURN.
  const results = await db
    .query<({ status: FactStatus; id: RecordId } | null)[]>(
      `BEGIN;
       IF !(SELECT VALUE id FROM ONLY $source) { THROW "source tidak ditemukan"; };
       IF !(SELECT VALUE id FROM ONLY $entity) { THROW "entity tidak ditemukan"; };
       LET $cur = (SELECT * FROM fact
         WHERE entity = $entity AND attribute = $attribute AND valid_to = NONE);
       LET $head = $cur[0];
       IF $head != NONE AND $head.valid_from > $at {
         THROW "waktu lebih awal dari fakta yang sedang berlaku";
       };
       LET $same = $head != NONE AND $head.value = $value;
       IF !$same {
         UPDATE fact SET valid_to = $at
           WHERE entity = $entity AND attribute = $attribute AND valid_to = NONE;
       };
       LET $new = IF $same { NONE } ELSE {
         (CREATE ONLY fact SET entity = $entity, attribute = $attribute,
           value = $value, valid_from = $at, source = $source)
       };
       RETURN {
         status: IF $same { "unchanged" } ELSE IF $head = NONE { "created" } ELSE { "updated" },
         id: IF $same { $head.id } ELSE { $new.id }
       };
       COMMIT;`,
      {
        entity: input.entity,
        attribute: input.attribute,
        value: input.value,
        source: input.source,
        at,
      },
    )
    .collect();
  const result = results.find((r) => r && "status" in r);
  if (!result) throw new Error("assertFact tidak mengembalikan hasil");
  return result;
}

// Fakta yang benar pada waktu `at` (default: sekarang).
export async function factsAt(entity: RecordId, at: Date = new Date()): Promise<Fact[]> {
  const [rows] = await db
    .query<[Fact[]]>(
      `SELECT * FROM fact
       WHERE entity = $entity AND valid_from <= $at
         AND (valid_to = NONE OR valid_to > $at)`,
      { entity, at },
    )
    .collect();
  return rows ?? [];
}
