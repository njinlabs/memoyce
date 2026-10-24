import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemory, type Memory } from "../../src/index";
import { createFakeEmbedder } from "../support/embedder";

// Alur lengkap lewat API publik: AI menyimpan hasil ekstraksinya, lalu bertanya dan
// mendapat bukti terstruktur atau jawaban "tidak tahu". Embedder palsu: hanya mekanisme
// yang diuji di sini, bukan mutu semantik.

let memory: Memory;
const SCOPE = "org:1/lead:maju";

beforeAll(async () => {
  memory = await createMemory({
    storage: { url: "mem://" },
    embedder: createFakeEmbedder(),
    retrieval: { minSimilarity: 0.3, minKeywordCoverage: 0.3 },
    attributes: [
      { key: "stage", description: "tahap penjualan" },
      { key: "budget", description: "anggaran", type: "number" },
      { key: "decision_maker", description: "pengambil keputusan", type: "entity" },
      { key: "objection", description: "keberatan pelanggan", cardinality: "multi" },
    ],
  });

  const first = await memory.remember({
    scope: SCOPE,
    source: {
      content:
        "PT Maju menanyakan paket Pro. Budget sekitar 50 juta. Keputusan di tangan Ibu Sari. " +
        "Mereka keberatan dengan harga lisensi.",
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
        attribute: "objection",
        value: "harga lisensi",
        quote: "keberatan dengan harga lisensi",
      },
    ],
  });
  expect(first.ok).toBe(true);

  const second = await memory.remember({
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
  expect(second.ok).toBe(true);
});

afterAll(() => memory.close());

test("pertanyaan dijawab dengan bukti: nilai terkini, kutipan, dan sumbernya", async () => {
  const result = await memory.recall({ scope: SCOPE, query: "berapa budget PT Maju sekarang" });
  if (!result.ok) throw new Error("seharusnya ok");
  expect(result.found).toBe(true);
  const [top] = result.items;
  expect(top).toMatchObject({
    attribute: "budget",
    value: 75_000_000,
    quote: "Budget naik jadi 75 juta",
    entity: { name: "PT Maju" },
  });
  expect(top?.source.received_at).toBe("2025-01-20T09:00:00.000Z");
  expect(top?.valid_to).toBeUndefined();
});

test("pertanyaan historis: kondisi pada tanggal lampau", async () => {
  const result = await memory.recall({
    scope: SCOPE,
    query: "budget PT Maju",
    as_of: "2025-01-12",
  });
  if (!result.ok) throw new Error("seharusnya ok");
  expect(result.items.find((i) => i.attribute === "budget")?.value).toBe(50_000_000);
});

test("multi nilai dan relasi: keberatan dan pengambil keputusan terambil", async () => {
  const objection = await memory.recall({
    scope: SCOPE,
    query: "apa keberatan harga lisensi PT Maju",
  });
  if (!objection.ok) throw new Error("seharusnya ok");
  expect(objection.items.map((i) => i.attribute)).toContain("objection");

  const decision = await memory.recall({
    scope: SCOPE,
    query: "siapa pengambil keputusan PT Maju",
  });
  if (!decision.ok) throw new Error("seharusnya ok");
  const item = decision.items.find((i) => i.attribute === "decision_maker");
  expect(item?.value).toMatchObject({ name: "Sari" });
});

test("tidak tahu bila memang tidak ada: tanpa mengarang", async () => {
  const unrelated = await memory.recall({
    scope: SCOPE,
    query: "warna logo perusahaan kompetitor",
  });
  if (!unrelated.ok) throw new Error("seharusnya ok");
  expect(unrelated).toMatchObject({ found: false, items: [] });
  expect(unrelated.message).toContain("Jangan menebak");

  const otherOwner = await memory.recall({ scope: "org:2/lead:maju", query: "budget PT Maju" });
  expect(otherOwner.ok && otherOwner.found).toBe(false);
});

test("reindex membangun ulang vektor tanpa mengubah jawaban", async () => {
  const before = await memory.recall({ scope: SCOPE, query: "budget PT Maju" });
  const counts = await memory.reindex();
  expect(counts.entities).toBe(2);
  expect(counts.facts).toBe(6);

  const after = await memory.recall({ scope: SCOPE, query: "budget PT Maju" });
  if (!before.ok || !after.ok) throw new Error("seharusnya ok");
  expect(after.items.map((i) => i.fact)).toEqual(before.items.map((i) => i.fact));
});

test("tanpa embedder: kata kunci dan graf tetap bekerja, makna dimatikan", async () => {
  const plain = await createMemory({
    storage: { url: "mem://" },
    attributes: [{ key: "budget", description: "anggaran", type: "number" }],
    retrieval: { minKeywordCoverage: 0.3 },
  });
  try {
    await plain.remember({
      scope: "s",
      source: { content: "Budget PT Maju 75 juta", received_at: "2025-01-01" },
      facts: [
        { entity: "PT Maju", attribute: "budget", value: 75_000_000, quote: "Budget PT Maju" },
      ],
    });
    const found = await plain.recall({ scope: "s", query: "budget PT Maju" });
    if (!found.ok) throw new Error("seharusnya ok");
    expect(found.found).toBe(true);
    expect(found.items[0]?.signals.vector).toBeUndefined();
    expect(found.items[0]?.signals.keyword).toBeGreaterThan(0);

    await expect(plain.reindex()).rejects.toMatchObject({ code: "embedder" });
  } finally {
    await plain.close();
  }
});

test("sesi baru: briefing tanpa pertanyaan memungkinkan AI berinisiatif melanjutkan konteks", async () => {
  // Awal sesi tanpa riwayat chat: aplikasi meminta briefing lalu menaruhnya di prompt.
  const briefing = await memory.context({ scope: SCOPE });
  if (!briefing.ok) throw new Error("seharusnya ok");
  expect(briefing.found).toBe(true);
  expect(briefing.text).toContain("PT Maju (organization)");
  // Hanya keadaan terkini: nilai lama yang sudah diganti tidak ikut.
  expect(briefing.text).toContain("anggaran: 75000000");
  expect(briefing.text).not.toContain("50000000");
  expect(briefing.entities.map((e) => e.name)).toContain("PT Maju");

  // Dengan pertanyaan: hanya yang relevan, atau pernyataan tegas bahwa memori tidak tahu.
  const asked = await memory.context({ scope: SCOPE, query: "berapa budget PT Maju" });
  expect(asked.ok && asked.found).toBe(true);
  const unknown = await memory.context({ scope: SCOPE, query: "warna logo kompetitor" });
  expect(unknown.ok && unknown.text).toContain("Jangan menebak");

  // Lead baru yang belum punya memori: dinyatakan kosong, bukan dibiarkan ambigu.
  const fresh = await memory.context({ scope: "org:1/lead:baru" });
  expect(fresh.ok && fresh.found).toBe(false);
  expect(fresh.ok && fresh.text).toBe("Memori jangka panjang: belum ada informasi yang tersimpan.");
});
