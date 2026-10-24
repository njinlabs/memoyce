import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DateTime, RecordId } from "surrealdb";
import { db } from "../../src/core/db";
import { assertFact, createEntity, createSource, factsAt } from "../../src/core/fact";
import { setupTestDb } from "../support/db";

// Skenario ujung ke ujung dari prinsip desain 1-3 lewat API publik.
// Prinsip 4-5 (retrieval hibrida, "tidak tahu") menyusul bersama modulnya.

let teardown: () => Promise<void>;

beforeAll(async () => {
  teardown = await setupTestDb();
});

afterAll(() => teardown());

const d = (s: string) => new Date(s);

async function allFacts(entity: RecordId) {
  const [rows] = await db
    .query<[{ value: unknown; valid_from: DateTime; valid_to?: DateTime; source: RecordId }[]]>(
      "SELECT * FROM fact WHERE entity = $entity ORDER BY valid_from",
      { entity },
    )
    .collect();
  return rows ?? [];
}

test("riwayat pekerjaan: fakta lama ditutup, tidak pernah hilang, dan bisa ditanya per tanggal", async () => {
  const budi = await createEntity("Budi", "person", ["Pak Budi"]);
  const jobs = [
    ["Acme", "2022-01-01"],
    ["Globex", "2023-06-01"],
    ["Initech", "2025-02-01"],
  ] as const;

  for (const [company, at] of jobs) {
    const source = await createSource(`Budi bekerja di ${company}`, undefined, d(at));
    await assertFact({ entity: budi, attribute: "employer", value: company, source, at: d(at) });
  }

  const rows = await allFacts(budi);
  expect(rows.map((r) => r.value)).toEqual(["Acme", "Globex", "Initech"]);
  expect(rows[0]?.valid_to?.toDate()).toEqual(d("2023-06-01"));
  expect(rows[1]?.valid_to?.toDate()).toEqual(d("2025-02-01"));
  expect(rows[2]?.valid_to).toBeUndefined();

  const employerAt = async (date: string) => (await factsAt(budi, d(date))).map((f) => f.value);
  expect(await employerAt("2021-12-31")).toEqual([]);
  expect(await employerAt("2022-01-01")).toEqual(["Acme"]);
  expect(await employerAt("2023-05-31")).toEqual(["Acme"]);
  expect(await employerAt("2023-06-01")).toEqual(["Globex"]);
  expect(await employerAt("2026-01-01")).toEqual(["Initech"]);
});

test("setiap fakta menunjuk ke teks asalnya", async () => {
  const siti = await createEntity("Siti", "person");
  const text = "Siti pindah ke Bandung bulan lalu";
  const source = await createSource(text);
  await assertFact({ entity: siti, attribute: "city", value: "Bandung", source });

  const [rows] = await db
    .query<[{ value: string; source: { content: string } }[]]>(
      "SELECT `value`, source.* AS source FROM fact WHERE entity = $siti",
      { siti },
    )
    .collect();
  expect(rows).toEqual([{ value: "Bandung", source: expect.objectContaining({ content: text }) }]);
});

test("pernyataan ulang yang sama tidak menggandakan fakta", async () => {
  const rina = await createEntity("Rina", "person");
  for (let i = 0; i < 3; i++) {
    const source = await createSource(`Rina tinggal di Medan (${i})`);
    await assertFact({
      entity: rina,
      attribute: "city",
      value: "Medan",
      source,
      at: d(`2025-0${i + 1}-01`),
    });
  }
  expect(await allFacts(rina)).toHaveLength(1);
});

test("entitas berbeda dengan atribut sama tidak saling memengaruhi", async () => {
  const a = await createEntity("Ani", "person");
  const b = await createEntity("Bayu", "person");
  const s = await createSource("Ani dan Bayu");
  const at = d("2025-01-01");
  await assertFact({ entity: a, attribute: "city", value: "Jakarta", source: s, at });
  await assertFact({ entity: b, attribute: "city", value: "Surabaya", source: s, at });
  await assertFact({
    entity: a,
    attribute: "city",
    value: "Bogor",
    source: s,
    at: d("2025-06-01"),
  });

  expect((await factsAt(b, d("2025-07-01"))).map((f) => f.value)).toEqual(["Surabaya"]);
  expect((await factsAt(a, d("2025-07-01"))).map((f) => f.value)).toEqual(["Bogor"]);
});
