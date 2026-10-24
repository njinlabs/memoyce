import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DateTime, RecordId } from "surrealdb";
import { assertFact, factsAt, retractFact } from "../../src/core/fact";
import { createEntity, createSource } from "../../src/core/records";
import { openTestContext, type TestContext } from "../support/context";

// Skenario ujung ke ujung lewat API internal (remember/recall publik menyusul bersama modulnya):
// riwayat bertemporal, provenance, dan isolasi scope.

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

const d = (s: string) => new Date(s);

const rows = async (entity: RecordId) => {
  const [r] = await t.ctx.db
    .query<[{ value: unknown; valid_from: DateTime; valid_to?: DateTime; source: RecordId }[]]>(
      "SELECT * FROM fact WHERE entity = $entity ORDER BY valid_from",
      { entity },
    )
    .collect();
  return r ?? [];
};

test("riwayat pekerjaan: fakta lama ditutup, tidak pernah hilang, dan bisa ditanya per tanggal", async () => {
  const scope = "org:1";
  const budi = await createEntity(t.ctx, {
    scope,
    name: "Budi",
    kind: "person",
    aliases: ["Pak Budi"],
  });
  const jobs = [
    ["Acme", "2022-01-01"],
    ["Globex", "2023-06-01"],
    ["Initech", "2025-02-01"],
  ] as const;

  for (const [company, at] of jobs) {
    const source = await createSource(t.ctx, {
      scope,
      content: `Budi bekerja di ${company}`,
      receivedAt: d(at),
    });
    await assertFact(t.ctx, {
      scope,
      entity: budi,
      attribute: "employer",
      value: company,
      source,
      at: d(at),
    });
  }

  const history = await rows(budi);
  expect(history.map((r) => r.value)).toEqual(["Acme", "Globex", "Initech"]);
  expect(history[0]?.valid_to?.toDate()).toEqual(d("2023-06-01"));
  expect(history[1]?.valid_to?.toDate()).toEqual(d("2025-02-01"));
  expect(history[2]?.valid_to).toBeUndefined();

  const employerAt = async (date: string) =>
    (await factsAt(t.ctx, { scope, entity: budi, at: d(date) })).map((f) => f.value);
  expect(await employerAt("2021-12-31")).toEqual([]);
  expect(await employerAt("2022-01-01")).toEqual(["Acme"]);
  expect(await employerAt("2023-05-31")).toEqual(["Acme"]);
  expect(await employerAt("2023-06-01")).toEqual(["Globex"]);
  expect(await employerAt("2026-01-01")).toEqual(["Initech"]);
});

test("setiap fakta menunjuk ke teks asalnya", async () => {
  const scope = "org:1";
  const siti = await createEntity(t.ctx, { scope, name: "Siti", kind: "person" });
  const content = "Siti pindah ke Bandung bulan lalu";
  const source = await createSource(t.ctx, { scope, content });
  await assertFact(t.ctx, { scope, entity: siti, attribute: "city", value: "Bandung", source });

  const [found] = await t.ctx.db
    .query<[{ value: string; source: { content: string } }[]]>(
      "SELECT `value`, source.* AS source FROM fact WHERE entity = $siti",
      { siti },
    )
    .collect();
  expect(found).toEqual([{ value: "Bandung", source: expect.objectContaining({ content }) }]);
});

test("pernyataan ulang yang sama tidak menggandakan fakta", async () => {
  const scope = "org:1";
  const rina = await createEntity(t.ctx, { scope, name: "Rina", kind: "person" });
  for (let i = 0; i < 3; i++) {
    const source = await createSource(t.ctx, { scope, content: `Rina tinggal di Medan (${i})` });
    await assertFact(t.ctx, {
      scope,
      entity: rina,
      attribute: "city",
      value: "Medan",
      source,
      at: d(`2025-0${i + 1}-01`),
    });
  }
  expect(await rows(rina)).toHaveLength(1);
});

test("atribut multi: tambah dan cabut nilai tanpa kehilangan riwayat", async () => {
  const scope = "org:1";
  const ani = await createEntity(t.ctx, { scope, name: "Ani", kind: "person" });
  const source = await createSource(t.ctx, { scope, content: "hobi Ani" });
  const hobby = (value: string, at: string) =>
    assertFact(t.ctx, {
      scope,
      entity: ani,
      attribute: "hobby",
      value,
      source,
      at: d(at),
    });
  await hobby("catur", "2025-01-01");
  await hobby("renang", "2025-01-01");
  await retractFact(t.ctx, {
    scope,
    entity: ani,
    attribute: "hobby",
    value: "catur",
    at: d("2025-06-01"),
  });

  const at = async (date: string) =>
    (await factsAt(t.ctx, { scope, entity: ani, at: d(date) })).map((f) => f.value).sort();
  expect(await at("2025-03-01")).toEqual(["catur", "renang"]);
  expect(await at("2025-07-01")).toEqual(["renang"]);
});

test("isolasi scope: nama sama di dua pemilik adalah dua entitas terpisah", async () => {
  const a = await createEntity(t.ctx, { scope: "tenant:a", name: "Budi", kind: "person" });
  const b = await createEntity(t.ctx, { scope: "tenant:b", name: "Budi", kind: "person" });
  const sourceA = await createSource(t.ctx, { scope: "tenant:a", content: "Budi di Acme" });
  const sourceB = await createSource(t.ctx, { scope: "tenant:b", content: "Budi di Globex" });
  const at = d("2025-01-01");

  await assertFact(t.ctx, {
    scope: "tenant:a",
    entity: a,
    attribute: "employer",
    value: "Acme",
    source: sourceA,
    at,
  });
  await assertFact(t.ctx, {
    scope: "tenant:b",
    entity: b,
    attribute: "employer",
    value: "Globex",
    source: sourceB,
    at,
  });

  const read = async (scope: string | string[], entity: RecordId) =>
    (await factsAt(t.ctx, { scope, entity, at: d("2025-02-01") })).map((f) => f.value);

  expect(await read("tenant:a", a)).toEqual(["Acme"]);
  expect(await read("tenant:b", b)).toEqual(["Globex"]);
  // Mengetahui id entitas milik scope lain tidak cukup untuk membacanya.
  expect(await read("tenant:a", b)).toEqual([]);
  expect(await read("tenant:b", a)).toEqual([]);
  // Pembacaan lintas scope harus diminta eksplisit.
  expect(await read(["tenant:a", "tenant:b"], a)).toEqual(["Acme"]);
});

test("isolasi scope: tidak bisa menulis fakta scope A dengan sumber atau entitas scope B", async () => {
  const entityA = await createEntity(t.ctx, { scope: "tenant:a", name: "X", kind: "person" });
  const sourceB = await createSource(t.ctx, { scope: "tenant:b", content: "rahasia B" });
  await expect(
    assertFact(t.ctx, {
      scope: "tenant:a",
      entity: entityA,
      attribute: "city",
      value: "Bogor",
      source: sourceB,
    }),
  ).rejects.toMatchObject({ code: "scope_mismatch" });
  expect(await rows(entityA)).toHaveLength(0);
});
