import { afterAll, beforeAll, expect, test } from "bun:test";
import { type DateTime, RecordId } from "surrealdb";
import { db } from "../../src/core/db";
import { assertFact, createEntity, createSource, factsAt } from "../../src/core/fact";
import { applySchema } from "../../src/core/schema";
import { setupTestDb } from "../support/db";

let teardown: () => Promise<void>;

beforeAll(async () => {
  teardown = await setupTestDb();
});

afterAll(() => teardown());

test("applySchema idempoten", async () => {
  await applySchema();
  await applySchema();
});

const d = (s: string) => new Date(s);

test("update menutup fakta lama, tidak menghapus, dan mendukung query as-of", async () => {
  const budi = await createEntity("Budi", "person");
  const s1 = await createSource("Budi kerja di Acme");
  const s2 = await createSource("Budi pindah ke Globex");

  const a = await assertFact({
    entity: budi,
    attribute: "employer",
    value: "Acme",
    source: s1,
    at: d("2024-01-01"),
  });
  expect(a.status).toBe("created");

  const same = await assertFact({
    entity: budi,
    attribute: "employer",
    value: "Acme",
    source: s2,
    at: d("2024-03-01"),
  });
  expect(same.status).toBe("unchanged");
  expect(same.id.toString()).toBe(a.id.toString());

  const b = await assertFact({
    entity: budi,
    attribute: "employer",
    value: "Globex",
    source: s2,
    at: d("2025-01-01"),
  });
  expect(b.status).toBe("updated");

  const [all] = await db
    .query<[unknown[]]>("SELECT * FROM fact WHERE entity = $e", { e: budi })
    .collect();
  expect(all).toHaveLength(2);

  const past = await factsAt(budi, d("2024-06-01"));
  expect(past.map((f) => f.value)).toEqual(["Acme"]);
  const now = await factsAt(budi, d("2025-06-01"));
  expect(now.map((f) => f.value)).toEqual(["Globex"]);
  expect(await factsAt(budi, d("2023-01-01"))).toHaveLength(0);
});

test("fakta tanpa source valid ditolak", async () => {
  const e = await createEntity("Siti", "person");
  const ghost = new RecordId("source", "tidak-ada");
  await expect(
    assertFact({ entity: e, attribute: "city", value: "Bandung", source: ghost }),
  ).rejects.toThrow();
  const [rows] = await db
    .query<[unknown[]]>("SELECT * FROM fact WHERE entity = $e", { e })
    .collect();
  expect(rows).toHaveLength(0);
});

test("waktu mundur dari fakta berlaku ditolak dan tidak mengubah data", async () => {
  const e = await createEntity("Rina", "person");
  const s = await createSource("Rina di Jakarta");
  await assertFact({
    entity: e,
    attribute: "city",
    value: "Jakarta",
    source: s,
    at: d("2025-01-01"),
  });
  await expect(
    assertFact({
      entity: e,
      attribute: "city",
      value: "Medan",
      source: s,
      at: d("2024-01-01"),
    }),
  ).rejects.toThrow();
  const now = await factsAt(e, d("2025-06-01"));
  expect(now.map((f) => f.value)).toEqual(["Jakarta"]);
});

test("entity yang tidak ada ditolak", async () => {
  const s = await createSource("teks");
  await expect(
    assertFact({
      entity: new RecordId("entity", "tidak-ada"),
      attribute: "city",
      value: "Bandung",
      source: s,
    }),
  ).rejects.toThrow("entity tidak ditemukan");
});

test("atribut berbeda tidak saling menutup", async () => {
  const e = await createEntity("Dewi", "person");
  const s = await createSource("Dewi di Bali, usia 30");
  const at = d("2025-01-01");
  await assertFact({ entity: e, attribute: "city", value: "Bali", source: s, at });
  await assertFact({ entity: e, attribute: "age", value: 30, source: s, at });
  const facts = await factsAt(e, d("2025-02-01"));
  expect(facts.map((f) => f.attribute).sort()).toEqual(["age", "city"]);
});

test("nilai objek dan array dibandingkan secara struktural", async () => {
  const e = await createEntity("Toko", "organization");
  const s = await createSource("alamat toko");
  const at = d("2025-01-01");
  const value = { jalan: "Merdeka", no: 1, tags: ["a", "b"] };
  const first = await assertFact({ entity: e, attribute: "address", value, source: s, at });
  const again = await assertFact({
    entity: e,
    attribute: "address",
    value: { ...value, tags: [...value.tags] },
    source: s,
    at: d("2025-02-01"),
  });
  expect(again.status).toBe("unchanged");
  expect(again.id.toString()).toBe(first.id.toString());
  const changed = await assertFact({
    entity: e,
    attribute: "address",
    value: { ...value, no: 2 },
    source: s,
    at: d("2025-03-01"),
  });
  expect(changed.status).toBe("updated");
});

test("tanpa `at`, memakai waktu sekarang; factsAt default juga sekarang", async () => {
  const e = await createEntity("Eko", "person");
  const s = await createSource("Eko di Solo", { channel: "chat" });
  const before = Date.now();
  await assertFact({ entity: e, attribute: "city", value: "Solo", source: s });
  const [fact] = await factsAt(e);
  expect(fact?.value).toBe("Solo");
  expect(fact?.valid_from.toDate().getTime()).toBeGreaterThanOrEqual(before - 1000);
});

test("createSource menyimpan meta dan received_at", async () => {
  const at = d("2024-05-05");
  const id = await createSource("halo", { channel: "chat" }, at);
  const [rows] = await db
    .query<[{ meta: unknown; received_at: DateTime }[]]>("SELECT meta, received_at FROM ONLY $id", {
      id,
    })
    .collect();
  expect(rows).toMatchObject({ meta: { channel: "chat" } });
  expect((rows as unknown as { received_at: DateTime }).received_at.toDate()).toEqual(at);
});
