import { afterAll, beforeAll, expect, test } from "bun:test";
import { memoryContext } from "../../src/core/briefing";
import { type RememberInput, remember } from "../../src/core/remember";
import { openTestContext, type TestContext, testAttributes } from "../support/context";
import { createFakeEmbedder } from "../support/embedder";

let t: TestContext;

const attributes = [
  ...testAttributes,
  { key: "stage", description: "tahap penjualan (lead, demo, closed)" },
  { key: "budget", description: "anggaran", type: "number" as const },
  { key: "next_step", description: "langkah berikutnya" },
];

beforeAll(async () => {
  t = await openTestContext({
    attributes,
    embedder: createFakeEmbedder(),
    // Ambang tinggi: embedder palsu memberi kemiripan ~0,5 pada fakta berbeda yang menyebut
    // nama entitas yang sama; bukti kata kunci (cakupan istilah) yang menentukan di tes ini.
    retrieval: { minSimilarity: 0.6, minKeywordCoverage: 0.5, stopwords: ["berapa"] },
  });
});

afterAll(() => t.close());

const store = async (input: RememberInput) => {
  const result = await remember(t.ctx, input);
  if (!result.ok) throw new Error(`remember gagal: ${JSON.stringify(result)}`);
};

const ctxOf = async (input: unknown) => {
  const result = await memoryContext(t.ctx, input);
  if (!result.ok) throw new Error(`context gagal: ${JSON.stringify(result)}`);
  return result;
};

// Scope utama: dua entitas, satu nilai berubah, satu relasi, satu fakta lama yang sudah ditutup.
const SCOPE = "org:1";

beforeAll(async () => {
  await store({
    scope: SCOPE,
    source: { content: "PT Maju tahap lead. Budget 50 juta.", received_at: "2025-01-10T00:00:00Z" },
    facts: [
      {
        entity: { name: "PT Maju", kind: "organization" },
        attribute: "stage",
        value: "lead",
        quote: "tahap lead",
      },
      { entity: "PT Maju", attribute: "budget", value: 50_000_000, quote: "Budget 50 juta" },
    ],
  });
  await store({
    scope: SCOPE,
    source: {
      content:
        "PT Maju lanjut demo. Budget naik 75 juta. Budi bekerja di PT Maju. Langkah berikutnya kirim proposal.",
      received_at: "2025-02-01T00:00:00Z",
    },
    facts: [
      { entity: "PT Maju", attribute: "stage", value: "demo", quote: "lanjut demo" },
      { entity: "PT Maju", attribute: "budget", value: 75_000_000, quote: "Budget naik 75 juta" },
      {
        entity: { name: "Budi", kind: "person" },
        attribute: "works_for",
        value: "PT Maju",
        quote: "Budi bekerja di PT Maju",
      },
      {
        entity: "PT Maju",
        attribute: "next_step",
        value: "kirim proposal",
        quote: "kirim proposal",
      },
    ],
  });
});

test("briefing tanpa query: hanya fakta berlaku, terbaru lebih dulu, dikelompokkan per entitas", async () => {
  const result = await ctxOf({ scope: SCOPE });
  expect(result.found).toBe(true);

  // 4 fakta berlaku (stage, budget, next_step, works_for); stage/budget lama sudah ditutup.
  expect(result.items).toHaveLength(4);
  const values = result.items.map((i) => i.value);
  expect(values).toContain("demo");
  expect(values).toContain(75_000_000);
  expect(values).not.toContain("lead");
  expect(values).not.toContain(50_000_000);

  const dates = result.items.map((i) => i.valid_from);
  expect(dates).toEqual([...dates].sort().reverse());

  expect(result.text).toStartWith("Memori jangka panjang (keadaan per ");
  expect(result.text).toContain("PT Maju (organization)");
  expect(result.text).toContain("- anggaran: 75000000, sejak 2025-02-01");
  // Label memakai bagian depan deskripsi (tanpa daftar dalam kurung).
  expect(result.text).toContain("- tahap penjualan: demo, sejak 2025-02-01");
  expect(result.text).not.toContain("closed");
  // Nilai referensi tampil dengan nama entitasnya.
  expect(result.text).toContain("Budi (person)");
  expect(result.text).toContain("organisasi tempat bekerja: PT Maju");
  expect(result.entities.map((e) => e.name).sort()).toEqual(["Budi", "PT Maju"]);
});

test("briefing menghormati as_of dan limit", async () => {
  const past = await ctxOf({ scope: SCOPE, as_of: "2025-01-15" });
  expect(past.items.map((i) => i.value).sort()).toEqual([50_000_000, "lead"].sort());
  expect(past.text).toContain("keadaan per 2025-01-15");
  expect(past.text).toContain("tahap penjualan: lead");

  const before = await ctxOf({ scope: SCOPE, as_of: "2024-01-01" });
  expect(before.found).toBe(false);
  expect(before.text).toContain("belum ada informasi");

  const limited = await ctxOf({ scope: SCOPE, limit: 2 });
  expect(limited.items).toHaveLength(2);
});

test("quotes=true menyertakan kutipan sumber pada tiap baris", async () => {
  const plain = await ctxOf({ scope: SCOPE });
  expect(plain.text).not.toContain("Budget naik 75 juta");
  const quoted = await ctxOf({ scope: SCOPE, quotes: true });
  expect(quoted.text).toContain('— "Budget naik 75 juta"');
});

test("scope kosong: dinyatakan tegas belum ada informasi", async () => {
  const result = await ctxOf({ scope: "org:kosong" });
  expect(result).toMatchObject({ found: false, items: [], entities: [] });
  expect(result.text).toBe("Memori jangka panjang: belum ada informasi yang tersimpan.");
});

test("beberapa scope digabung menurut waktu; scope lain tidak bocor", async () => {
  await store({
    scope: "org:2",
    source: { content: "Andi suka kopi hitam", received_at: "2025-03-01T00:00:00Z" },
    facts: [{ entity: "Andi", attribute: "hobby", value: "kopi hitam", quote: "suka kopi hitam" }],
  });
  const only1 = await ctxOf({ scope: SCOPE });
  expect(only1.text).not.toContain("Andi");

  const both = await ctxOf({ scope: [SCOPE, "org:2"] });
  expect(both.items[0]?.scope).toBe("org:2");
  expect(both.items[0]?.valid_from.slice(0, 10)).toBe("2025-03-01");
  expect(both.text).toContain("Andi");
  expect(both.items.map((i) => i.scope)).toContain(SCOPE);
});

test("nilai JSON, tanggal, dan banyak nilai ditampilkan ringkas", async () => {
  await store({
    scope: "org:fmt",
    source: {
      content: "Profil PT Format: kontak dan ulang tahun.",
      received_at: "2025-04-01T00:00:00Z",
    },
    facts: [
      {
        entity: "PT Format",
        attribute: "profile",
        value: { kontak: "Andi", jam: [8, 17] },
        quote: "kontak dan ulang tahun",
      },
      { entity: "PT Format", attribute: "birthday", value: "2000-02-02", quote: "ulang tahun" },
      { entity: "PT Format", attribute: "hobby", value: "catur", quote: "PT Format" },
      { entity: "PT Format", attribute: "age", value: 12, quote: "PT Format" },
    ],
  });
  const { text } = await ctxOf({ scope: "org:fmt" });
  // SurrealDB mengurutkan kunci objek secara alfabet.
  expect(text).toContain('{"jam":[8,17],"kontak":"Andi"}');
  expect(text).toContain("tanggal lahir: 2000-02-02T00:00:00.000Z");
  expect(text).toContain("hobi: catur");
  expect(text).toContain("usia: 12");
});

test("atribut yang sudah tidak terdaftar memakai kuncinya sebagai label", async () => {
  const open = await openTestContext({ vocabulary: "open", attributes: [] });
  try {
    await remember(open.ctx, {
      scope: "s",
      source: { content: "Warna favorit Andi biru", received_at: "2025-01-01" },
      facts: [
        { entity: "Andi", attribute: "warna_favorit", value: "biru", quote: "favorit Andi biru" },
      ],
    });
    const result = await memoryContext(open.ctx, { scope: "s" });
    expect(result.ok && result.text).toContain("- warna_favorit: biru");
  } finally {
    await open.close();
  }
});

test("dengan query: fakta relevan sebagai teks, dan tegas bila tidak tahu", async () => {
  const hit = await ctxOf({ scope: SCOPE, query: "berapa budget PT Maju" });
  expect(hit.found).toBe(true);
  expect(hit.text).toStartWith("Memori jangka panjang yang relevan");
  expect(hit.text).toContain("anggaran: 75000000");
  expect(hit.items[0]).toHaveProperty("signals");
  expect(hit.entities.map((e) => e.name)).toContain("PT Maju");

  const miss = await ctxOf({ scope: SCOPE, query: "warna logo kompetitor" });
  expect(miss.found).toBe(false);
  expect(miss.text).toContain("tidak ada informasi yang relevan");
  expect(miss.text).toContain("Jangan menebak");

  // Entitas dikenal tanpa bukti isi tetap disebut agar AI tahu entitasnya ada.
  const known = await ctxOf({ scope: SCOPE, query: "alamat kantor PT Maju" });
  expect(known.found).toBe(false);
  expect(known.entities.map((e) => e.name)).toContain("PT Maju");
});

test.each([
  ["bukan objek", "halo"],
  ["tanpa scope", {}],
  ["scope kosong", { scope: "" }],
  ["limit di luar batas", { scope: "a", limit: 101 }],
  ["query kosong", { scope: "a", query: "  " }],
  ["as_of bukan ISO", { scope: "a", as_of: "kemarin" }],
  ["quotes bukan boolean", { scope: "a", quotes: "ya" }],
])("input tidak valid dikembalikan sebagai data: %s", async (_name, raw) => {
  const result = await memoryContext(t.ctx, raw);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.every((e) => e.code === "invalid_input")).toBe(true);
});

test("input query tidak valid diteruskan dari recall sebagai galat data", async () => {
  // Skema context lolos, tetapi recall menolak (mis. scope di luar batas panjang daftar).
  const result = await memoryContext(t.ctx, {
    scope: Array.from({ length: 21 }, (_, i) => `s${i}`),
    query: "x",
  });
  expect(result.ok).toBe(false);
});
