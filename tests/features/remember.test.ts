import { afterAll, beforeAll, expect, test } from "bun:test";
import { createNodeEngines } from "@surrealdb/node";
import { type DateTime, Surreal } from "surrealdb";
import { createMemory, type Memory } from "../../src/index";

// Percakapan sales dua hari lewat API publik. Koneksi Surreal dimiliki "aplikasi"
// (storage.db); pembacaan memakai koneksi itu juga karena recall belum dibuat.

const NS = "app_ns";
const DB = "app_db";

let host: Surreal;
let memory: Memory;

beforeAll(async () => {
  host = new Surreal({ engines: createNodeEngines() });
  await host.connect("mem://");
  memory = await createMemory({
    storage: { db: host, namespace: NS, database: DB },
    attributes: [
      { key: "stage", description: "tahap penjualan" },
      { key: "budget", description: "anggaran (rupiah)", type: "number" },
      { key: "decision_maker", description: "pengambil keputusan", type: "entity" },
      { key: "works_for", description: "organisasi tempat bekerja", type: "entity" },
      { key: "pain_point", description: "masalah calon pelanggan", cardinality: "multi" },
    ],
  });
  await host.use({ namespace: NS, database: DB });
});

afterAll(async () => {
  await memory.close();
  await host.close();
});

interface Row {
  attribute: string;
  value: unknown;
  valid_from: DateTime;
  valid_to?: DateTime;
  quote: string;
  source: { content: string };
}

const factsOf = async (scope: string, name: string): Promise<Row[]> => {
  const [rows] = await host
    .query<[Row[]]>(
      `SELECT attribute, value, valid_from, valid_to, quote, source.* AS source FROM fact
       WHERE scope = $scope AND entity IN (SELECT VALUE id FROM entity WHERE scope = $scope AND keys CONTAINS $key)
       ORDER BY valid_from`,
      { scope, key: name.toLowerCase() },
    )
    .collect();
  return rows ?? [];
};

const entityCount = async (scope: string, name: string): Promise<number> => {
  const [rows] = await host
    .query<[unknown[]]>("SELECT id FROM entity WHERE scope = $scope AND keys CONTAINS $key", {
      scope,
      key: name.toLowerCase(),
    })
    .collect();
  return rows?.length ?? 0;
};

const at = (rows: Row[], attribute: string, date: string): unknown[] =>
  rows
    .filter(
      (r) =>
        r.attribute === attribute &&
        r.valid_from.toDate() <= new Date(date) &&
        (!r.valid_to || r.valid_to.toDate() > new Date(date)),
    )
    .map((r) => r.value);

test("percakapan sales dua hari: sumber, kutipan, dan riwayat tahap/anggaran terjaga", async () => {
  const scope = "org:1/lead:maju";

  const day1 = await memory.remember({
    scope,
    source: {
      content:
        "Budi dari PT Maju menanyakan paket Pro. Budget sekitar 50 juta. " +
        "Keputusan di tangan Ibu Sari. Mereka kesulitan dengan laporan manual.",
      received_at: "2025-01-10T09:00:00Z",
      meta: { channel: "whatsapp" },
    },
    facts: [
      { entity: "Budi", attribute: "works_for", value: "PT Maju", quote: "Budi dari PT Maju" },
      {
        entity: { name: "PT Maju", kind: "organization" },
        attribute: "stage",
        value: "discovery",
        quote: "menanyakan paket Pro",
      },
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 50_000_000,
        quote: "Budget sekitar 50 juta",
      },
      {
        entity: "PT Maju",
        attribute: "decision_maker",
        value: { name: "Sari", kind: "person" },
        quote: "Ibu Sari",
      },
      {
        entity: "PT Maju",
        attribute: "pain_point",
        value: "laporan manual",
        quote: "laporan manual",
      },
    ],
  });
  expect(day1.ok).toBe(true);

  const day2 = await memory.remember({
    scope,
    source: {
      content: "Update: PT Maju setuju demo. Budget naik jadi 75 juta.",
      received_at: "2025-01-20T09:00:00Z",
    },
    facts: [
      { entity: "PT Maju", attribute: "stage", value: "demo", quote: "PT Maju setuju demo" },
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 75_000_000,
        quote: "Budget naik jadi 75 juta",
      },
    ],
  });
  expect(day2.ok).toBe(true);
  if (!day2.ok) return;
  expect(day2.results.map((r) => (r.ok ? r.status : "error"))).toEqual(["updated", "updated"]);

  // PT Maju tetap satu entitas di kedua hari.
  expect(await entityCount(scope, "PT Maju")).toBe(1);

  const maju = await factsOf(scope, "PT Maju");
  expect(at(maju, "stage", "2025-01-15")).toEqual(["discovery"]);
  expect(at(maju, "stage", "2025-01-25")).toEqual(["demo"]);
  expect(at(maju, "budget", "2025-01-15")).toEqual([50_000_000]);
  expect(at(maju, "budget", "2025-01-25")).toEqual([75_000_000]);
  expect(at(maju, "pain_point", "2025-01-25")).toEqual(["laporan manual"]);
  // Tidak ada fakta yang hilang: 2 tahap + 2 anggaran + pengambil keputusan + 1 pain point.
  expect(maju).toHaveLength(6);

  // Setiap fakta menunjuk ke teks asal dan kutipan yang benar-benar ada di dalamnya.
  for (const row of maju) {
    expect(row.source.content.toLowerCase()).toContain(row.quote.toLowerCase());
  }
  const budget75 = maju.find((r) => r.value === 75_000_000);
  expect(budget75?.source.content).toStartWith("Update:");

  // Relasi tersimpan sebagai fakta bernilai referensi ke entitas lain.
  expect(await entityCount(scope, "Sari")).toBe(1);
  expect(await entityCount(scope, "Budi")).toBe(1);
  expect((await factsOf(scope, "Budi")).map((r) => r.attribute)).toEqual(["works_for"]);
});

test("pemilik lain dengan nama perusahaan sama tidak tercampur", async () => {
  const other = "org:2/lead:maju";
  const result = await memory.remember({
    scope: other,
    source: { content: "PT Maju masih tahap awal.", received_at: "2025-02-01T00:00:00Z" },
    facts: [{ entity: "PT Maju", attribute: "stage", value: "lead", quote: "tahap awal" }],
  });
  expect(result.ok).toBe(true);
  expect(await entityCount(other, "PT Maju")).toBe(1);
  expect(at(await factsOf(other, "PT Maju"), "stage", "2025-02-02")).toEqual(["lead"]);
  // Fakta pemilik pertama tidak berubah.
  expect(at(await factsOf("org:1/lead:maju", "PT Maju"), "stage", "2025-02-02")).toEqual(["demo"]);
});

test("kesalahan AI dikembalikan sebagai data yang bisa diperbaiki, tanpa menulis apa pun", async () => {
  const scope = "org:3/lead:x";
  const result = await memory.remember({
    scope,
    source: { content: "PT Baru ingin demo." },
    facts: [{ entity: "PT Baru", attribute: "tahap", value: "demo", quote: "ingin demo" }],
  });
  expect(result.ok).toBe(false);
  if (result.ok || result.stage !== "validation") throw new Error("seharusnya gagal validasi");
  expect(result.errors[0]).toMatchObject({ index: 0, code: "unknown_attribute" });
  expect(result.errors[0]?.details.valid).toEqual(
    expect.arrayContaining(["stage", "budget", "decision_maker"]),
  );
  expect(await entityCount(scope, "PT Baru")).toBe(0);
});
