import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemory, type Memory } from "../../src/index";
import { createFakeEmbedder } from "../support/embedder";

// Prinsip 5: berani bilang tidak tahu. Kasus yang menggoda sistem untuk menebak: entitas dikenal
// tetapi atributnya tidak pernah disebut, entitas yang tidak ada, dan kata yang tidak ada di korpus.
// Tanpa embedder supaya bukti hanya kata kunci dan hasilnya deterministik.

let memory: Memory;
let semantic: Memory;
let plain: Memory;
const SCOPE = "org:1";

const attributes = [
  { key: "budget", description: "anggaran", type: "number" as const },
  { key: "city", description: "kota" },
  { key: "role", description: "jabatan" },
  { key: "decision_maker", description: "pengambil keputusan", type: "entity" as const },
];

const seed = {
  scope: SCOPE,
  source: {
    received_at: "2026-01-10T09:00:00Z",
    content:
      "PT Maju (Bandung) punya anggaran 75 juta. Keputusan di tangan Ibu Sari, direktur utama. " +
      "PT Nusantara ada di Jakarta. Berkah Sentosa Makmur Tbk di Surabaya.",
  },
  facts: [
    {
      entity: "PT Maju",
      attribute: "budget",
      value: 75_000_000,
      quote: "PT Maju (Bandung) punya anggaran 75 juta",
    },
    { entity: "PT Maju", attribute: "city", value: "Bandung", quote: "PT Maju (Bandung)" },
    {
      entity: "PT Maju",
      attribute: "decision_maker",
      value: { name: "Sari", kind: "person" },
      quote: "Ibu Sari",
    },
    { entity: "Sari", attribute: "role", value: "direktur utama", quote: "direktur utama" },
    {
      entity: "PT Nusantara",
      attribute: "city",
      value: "Jakarta",
      quote: "PT Nusantara ada di Jakarta",
    },
    {
      entity: "Berkah Sentosa Makmur Tbk",
      attribute: "city",
      value: "Surabaya",
      quote: "Berkah Sentosa Makmur Tbk di Surabaya",
    },
  ],
};

beforeAll(async () => {
  // Kata fungsi dan gelar berasal dari konfigurasi aplikasi; library tidak membawa daftar bahasa.
  const language = {
    stopwords: ["apa", "berapa", "bagaimana", "di", "mana", "saja", "ada", "berada"],
    titles: ["pt", "cv", "ibu", "pak"],
  };
  memory = await createMemory({
    storage: { url: "mem://" },
    attributes,
    retrieval: language,
  });
  expect((await memory.remember(seed)).ok).toBe(true);
  plain = await createMemory({ storage: { url: "mem://" }, attributes });
  expect((await plain.remember(seed)).ok).toBe(true);
  semantic = await createMemory({
    storage: { url: "mem://" },
    attributes,
    embedder: createFakeEmbedder(),
    retrieval: { minSimilarity: 0.6, minKeywordCoverage: 0.5, ...language },
  });
  expect((await semantic.remember(seed)).ok).toBe(true);
});
afterAll(async () => {
  await memory.close();
  await plain.close();
  await semantic.close();
});

const entities = (r: Awaited<ReturnType<Memory["recall"]>>): string[] =>
  r.ok ? r.items.map((i) => i.entity.name) : [];

test("kontrol: pertanyaan yang bisa dijawab tetap dijawab", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Berapa anggaran PT Maju?" });
  expect(r.ok && r.found).toBe(true);
  expect(entities(r)).toContain("PT Maju");
});

test("entitas dikenal, atribut tak pernah disebut: tidak tahu (bukan anggaran perusahaan lain)", async () => {
  for (const m of [memory, semantic]) {
    const r = await m.recall({ scope: SCOPE, query: "Berapa anggaran PT Nusantara?" });
    expect(r.ok && r.found).toBe(false);
    expect(r.ok && r.message).toContain("Jangan menebak");
  }
});

test("entitas yang tidak ada: tidak tahu walau kata lain cocok", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Berapa anggaran PT Kencana?" });
  expect(r.ok && r.found).toBe(false);
});

test("kata yang tidak ada di korpus membatalkan bukti kata kunci", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Bagaimana cuaca di Bandung?" });
  expect(r.ok && r.found).toBe(false);
});

test("dua lompatan: istilah yang dijelaskan jalur relasi dihitung terpenuhi", async () => {
  const r = await memory.recall({
    scope: SCOPE,
    query: "Apa jabatan pengambil keputusan di PT Maju?",
    min_keyword_coverage: 0.9,
  });
  expect(r.ok && r.found).toBe(true);
  expect(entities(r)).toContain("Sari");
});

test("kata fungsi dari konfigurasi aplikasi tidak membatalkan bukti", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "PT Maju ada di kota mana saja?" });
  expect(r.ok && r.found).toBe(true);
  expect(entities(r)).toContain("PT Maju");
});

test("tanpa daftar bahasa (bawaan netral): kata kunci berhasil, kalimat tanya aman ke 'tidak tahu'", async () => {
  // Query berupa kata kunci (cara tool memintanya dari AI) tidak butuh daftar apa pun.
  const keywords = await plain.recall({ scope: SCOPE, query: "anggaran PT Maju" });
  expect(keywords.ok && keywords.found).toBe(true);
  expect(entities(keywords)).toContain("PT Maju");
  // Kalimat tanya berisi kata yang tak ada di data ("berapa"): bukti kata kunci batal, dan tanpa
  // embedder hasilnya tegas "tidak tahu", bukan tebakan.
  const sentence = await plain.recall({ scope: SCOPE, query: "Berapa anggaran PT Maju?" });
  expect(sentence.ok && sentence.found).toBe(false);
});

test("tanpa nama persis, entitas ditemukan lewat kemiripan makna nama", async () => {
  const r = await semantic.recall({ scope: SCOPE, query: "Berkah Sentosa Makmur" });
  expect(r.ok && r.linked_entities.map((e) => e.name)).toContain("Berkah Sentosa Makmur Tbk");
  expect(r.ok && r.found).toBe(true);
});

test("nama yang kemiripannya di bawah ambang entitas tidak ditautkan", async () => {
  const r = await semantic.recall({ scope: SCOPE, query: "Bandung Jakarta" });
  expect(r.ok && r.linked_entities).toEqual([]);
});

test("nama sebagian (tanpa gelar) menautkan entitas; kata atribut dan kata tanya tidak", async () => {
  // "Nusantara" = bagian dari "PT Nusantara"; "kota" dan "anggaran" adalah kata atribut.
  const r = await memory.recall({ scope: SCOPE, query: "Di kota mana Nusantara berada?" });
  expect(r.ok && r.linked_entities.map((e) => e.name)).toEqual(["PT Nusantara"]);
  expect(entities(r)).toContain("PT Nusantara");

  const attributeWord = await memory.recall({ scope: SCOPE, query: "Berapa anggaran kota?" });
  expect(attributeWord.ok && attributeWord.linked_entities).toEqual([]);
});
