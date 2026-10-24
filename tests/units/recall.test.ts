import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { type RecallInput, type RecallResult, recall, recallSchema } from "../../src/core/recall";
import { type RememberInput, remember } from "../../src/core/remember";
import { openTestContext, type TestContext, testAttributes } from "../support/context";
import { createFakeEmbedder, type FakeEmbedder } from "../support/embedder";

let t: TestContext;
let embedder: FakeEmbedder;
const SCOPE = "org:1";

const salesAttributes = [
  ...testAttributes,
  { key: "stage", description: "tahap penjualan" },
  { key: "budget", description: "anggaran", type: "number" as const },
  { key: "decision_maker", description: "pengambil keputusan", type: "entity" as const },
  { key: "pain_point", description: "masalah", cardinality: "multi" as const },
];

const store = async (input: RememberInput) => {
  const result = await remember(t.ctx, input);
  if (!result.ok) throw new Error(`remember gagal: ${JSON.stringify(result)}`);
};

beforeAll(async () => {
  embedder = createFakeEmbedder();
  t = await openTestContext({
    attributes: salesAttributes,
    embedder,
    retrieval: { minSimilarity: 0.3, minKeywordCoverage: 0.3 },
  });

  await store({
    scope: SCOPE,
    source: {
      content:
        "PT Maju menanyakan paket Pro. Budget sekitar 50 juta. Keputusan di tangan Ibu Sari. " +
        "Mereka kesulitan dengan laporan manual.",
      received_at: "2025-01-10T09:00:00Z",
    },
    facts: [
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
  await store({
    scope: SCOPE,
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
  await store({
    scope: "org:2",
    source: {
      content: "PT Maju milik tenant lain, budget 10 juta.",
      received_at: "2025-01-05T00:00:00Z",
    },
    facts: [{ entity: "PT Maju", attribute: "budget", value: 10_000_000, quote: "budget 10 juta" }],
  });
});

afterAll(() => t.close());

const ask = async (query: string, extra: Partial<RecallInput> = {}) => {
  const result = await recall(t.ctx, { scope: SCOPE, query, ...extra });
  if (!result.ok) throw new Error(`recall gagal: ${JSON.stringify(result)}`);
  return result;
};

const values = (result: Extract<RecallResult, { ok: true }>, attribute: string) =>
  result.items.filter((i) => i.attribute === attribute).map((i) => i.value);

test("menemukan fakta yang berlaku sekarang lewat gabungan kanal", async () => {
  const result = await ask("berapa budget PT Maju");
  expect(result.found).toBe(true);
  expect(values(result, "budget")).toEqual([75_000_000]);
  const [top] = result.items;
  expect(top).toMatchObject({
    attribute: "budget",
    entity: { name: "PT Maju", kind: "organization" },
    quote: "Budget naik jadi 75 juta",
  });
  expect(top?.signals.vector).toBeGreaterThan(0.3);
  expect(top?.signals.keyword).toBeGreaterThan(0);
  expect(top?.signals.entity).toBe("direct");
  expect(result.linked_entities.map((e) => e.name)).toContain("PT Maju");
  expect(top?.source.received_at).toBe("2025-01-20T09:00:00.000Z");
});

test("as_of: kebenaran pada tanggal lampau", async () => {
  const past = await ask("budget PT Maju", { as_of: "2025-01-15" });
  expect(values(past, "budget")).toEqual([50_000_000]);
  const present = await ask("budget PT Maju", { as_of: "2025-02-01T00:00:00Z" });
  expect(values(present, "budget")).toEqual([75_000_000]);
  const before = await ask("budget PT Maju", { as_of: "2024-01-01" });
  expect(before.found).toBe(false);
});

test("nilai referensi dikembalikan dengan nama entitasnya", async () => {
  const result = await ask("siapa pengambil keputusan di PT Maju");
  const [decision] = result.items.filter((i) => i.attribute === "decision_maker");
  expect(decision?.value).toMatchObject({ name: "Sari" });
  expect((decision?.value as { id: string } | undefined)?.id).toStartWith("entity:");
});

test("fakta berelasi (satu lompatan) ikut terjangkau lewat entitas yang disebut", async () => {
  // "Sari" disebut di query; PT Maju menunjuk Sari sebagai pengambil keputusan.
  const result = await ask("apa peran Sari pengambil keputusan");
  expect(result.items.map((i) => i.attribute)).toContain("decision_maker");
  const related = result.items.find((i) => i.attribute === "decision_maker");
  expect(related?.signals.entity).toBe("related");
});

test("scope memisahkan hasil; beberapa scope bisa dibaca sekaligus", async () => {
  const other = await recall(t.ctx, { scope: "org:2", query: "budget PT Maju" });
  expect(other.ok && other.items.map((i) => i.value)).toEqual([10_000_000]);

  const both = await recall(t.ctx, { scope: [SCOPE, "org:2"], query: "budget PT Maju" });
  if (!both.ok) throw new Error("seharusnya ok");
  expect([...new Set(both.items.map((i) => i.scope))].sort()).toEqual(["org:1", "org:2"]);
  expect(both.items.filter((i) => i.scope === "org:2").map((i) => i.value)).toEqual([10_000_000]);

  const none = await recall(t.ctx, { scope: "org:kosong", query: "budget PT Maju" });
  expect(none.ok && none.found).toBe(false);
});

test("berani menjawab tidak tahu: pertanyaan di luar data", async () => {
  const result = await ask("kapan ulang tahun direktur utama");
  expect(result.found).toBe(false);
  expect(result.items).toEqual([]);
  expect(result.message).toContain("Jangan menebak");
});

test("entitas dikenal tetapi tidak ada fakta relevan: tidak tahu, entitas disebutkan", async () => {
  const result = await ask("alamat kantor PT Maju di kota apa");
  // "PT Maju" dikenali, tetapi tidak ada fakta tentang alamat/kota.
  expect(result.linked_entities.map((e) => e.name)).toContain("PT Maju");
  expect(result.items.filter((i) => i.attribute === "city")).toEqual([]);
  if (!result.found) expect(result.message).toContain("PT Maju");
});

test("ambang bisa diperketat per panggilan", async () => {
  const strict = await ask("berapa budget PT Maju sekarang kira-kira", {
    min_similarity: 0.99,
    min_keyword_coverage: 1,
  });
  expect(strict.found).toBe(false);
});

test("limit membatasi jumlah hasil", async () => {
  const result = await ask("PT Maju", { limit: 2 });
  expect(result.items.length).toBeLessThanOrEqual(2);
});

test("kata kunci persis (angka) ditemukan lewat BM25", async () => {
  const result = await ask("75000000");
  expect(result.found).toBe(true);
  expect(result.items[0]?.attribute).toBe("budget");
  expect(result.items[0]?.signals.keyword).toBeGreaterThan(0);
});

test.each([
  ["query kosong", { scope: SCOPE, query: "   " }],
  ["scope kosong", { scope: "", query: "x" }],
  ["scope daftar kosong", { scope: [], query: "x" }],
  ["limit di luar batas", { scope: SCOPE, query: "x", limit: 0 }],
  ["limit pecahan", { scope: SCOPE, query: "x", limit: 2.5 }],
  ["as_of bukan ISO", { scope: SCOPE, query: "x", as_of: "kemarin" }],
  ["bukan objek", "halo"],
])("input tidak valid dikembalikan sebagai data: %s", async (_name, raw) => {
  const result = await recall(t.ctx, raw);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.every((e) => e.code === "invalid_input")).toBe(true);
});

test("embedder gagal saat recall dilempar sebagai MemoryError", async () => {
  embedder.failNext();
  await expect(ask("budget PT Maju")).rejects.toMatchObject({ code: "embedder" });
});

test("query di-embed dengan kind=query", async () => {
  embedder.calls.length = 0;
  await ask("budget PT Maju");
  expect(embedder.calls).toHaveLength(1);
  expect(embedder.calls[0]?.kind).toBe("query");
});

test("recallSchema bisa dijadikan JSON Schema untuk tool AI", () => {
  const schema = z.toJSONSchema(recallSchema) as { required: string[]; properties: object };
  expect(schema.required).toEqual(expect.arrayContaining(["scope", "query"]));
  expect(Object.keys(schema.properties)).toEqual(
    expect.arrayContaining(["scope", "query", "as_of", "limit"]),
  );
});

test("nilai JSON bersarang dikembalikan sebagai JSON murni (tanggal menjadi ISO)", async () => {
  const scope = "org:json";
  await store({
    scope,
    source: { content: "Profil PT Json: kontak utama dan jam buka.", received_at: "2025-01-01" },
    facts: [
      {
        entity: "PT Json",
        attribute: "profile",
        value: { kontak: ["Andi", "Budi"], jam: { buka: 8, tutup: 17 } },
        quote: "kontak utama dan jam buka",
      },
      { entity: "PT Json", attribute: "birthday", value: "2000-02-02", quote: "PT Json" },
    ],
  });
  const result = await recall(t.ctx, { scope, query: "profil kontak jam buka PT Json" });
  if (!result.ok) throw new Error("seharusnya ok");
  const profile = result.items.find((i) => i.attribute === "profile");
  expect(profile?.value).toEqual({ kontak: ["Andi", "Budi"], jam: { buka: 8, tutup: 17 } });
  const birthday = await recall(t.ctx, { scope, query: "birthday PT Json" });
  if (!birthday.ok) throw new Error("seharusnya ok");
  expect(birthday.items.find((i) => i.attribute === "birthday")?.value).toBe(
    "2000-02-02T00:00:00.000Z",
  );
});

test("scope besar: ANN diperluas bila banyak kandidat tidak berlaku pada as_of", async () => {
  const scope = "org:many";
  await store({
    scope,
    source: { content: "Daftar hobi Hobi Besar.", received_at: "2025-06-01" },
    facts: Array.from({ length: 60 }, (_, i) => ({
      entity: "Hobi Besar",
      attribute: "hobby",
      value: `hobi nomor ${i}`,
      quote: "Daftar hobi",
    })),
  });
  // Pada 2025-01-01 belum ada fakta berlaku: ANN (k=50) penuh tetapi semuanya tidak valid,
  // sehingga pencarian diperluas sampai seluruh partisi terbaca.
  const early = await recall(t.ctx, { scope, query: "hobi Hobi Besar", as_of: "2025-01-01" });
  expect(early.ok && early.found).toBe(false);

  // Pada waktu berlaku, entitas yang disebut punya 60 fakta langsung: sebagian di luar top-k
  // ANN dan dinilai lewat lookup kemiripan langsung.
  const now = await recall(t.ctx, { scope, query: "hobi Hobi Besar", limit: 50 });
  if (!now.ok) throw new Error("seharusnya ok");
  expect(now.found).toBe(true);
  expect(now.items.length).toBeGreaterThan(20);
  expect(now.items.every((i) => i.signals.entity === "direct")).toBe(true);
  expect(now.items.every((i) => i.signals.vector !== undefined)).toBe(true);
});
