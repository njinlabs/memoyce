import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemory, type Memory } from "../../src/index";

// Resolusi entitas longgar: pengguna menyebut "Budi", "Ibu Sari", atau "Nusantara Logistik",
// bukan nama lengkap. Cocok bila kata query adalah potongan berurutan nama/alias (gelar dan badan
// usaha diabaikan). Yang ambigu dikembalikan semuanya, tidak ditebak satu.

let memory: Memory;
const SCOPE = "org:1";

beforeAll(async () => {
  memory = await createMemory({
    storage: { url: "mem://" },
    attributes: [
      { key: "role", description: "jabatan" },
      { key: "city", description: "kota" },
      { key: "budget", description: "anggaran", type: "number" },
    ],
    // Kata fungsi dan gelar berasal dari aplikasi (bahasa datanya); library tidak membawa daftar.
    retrieval: {
      stopwords: ["apa", "berapa", "di", "mana", "berada", "kabar"],
      titles: ["pt", "cv", "tbk", "ibu", "pak", "bu"],
    },
  });
  const result = await memory.remember({
    scope: SCOPE,
    source: {
      received_at: "2026-01-10T09:00:00Z",
      content:
        "Budi Santoso kepala pengadaan. Budi Hartono manajer keuangan. Ibu Sari Wulandari " +
        "direktur utama. PT Nusantara Logistik di Jakarta. PT Maju anggaran 75 juta. " +
        "PT Maju Jaya anggaran 20 juta.",
    },
    facts: [
      {
        entity: "Budi Santoso",
        attribute: "role",
        value: "kepala pengadaan",
        quote: "kepala pengadaan",
      },
      {
        entity: "Budi Hartono",
        attribute: "role",
        value: "manajer keuangan",
        quote: "manajer keuangan",
      },
      {
        entity: "Sari Wulandari",
        attribute: "role",
        value: "direktur utama",
        quote: "direktur utama",
      },
      { entity: "PT Nusantara Logistik", attribute: "city", value: "Jakarta", quote: "di Jakarta" },
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 75_000_000,
        quote: "PT Maju anggaran 75 juta",
      },
      {
        entity: "PT Maju Jaya",
        attribute: "budget",
        value: 20_000_000,
        quote: "PT Maju Jaya anggaran 20 juta",
      },
    ],
  });
  expect(result.ok).toBe(true);
});
afterAll(async () => {
  await memory.close();
});

const linked = (r: Awaited<ReturnType<Memory["recall"]>>): string[] =>
  r.ok ? r.linked_entities.map((e) => e.name).sort() : [];
const values = (r: Awaited<ReturnType<Memory["recall"]>>): unknown[] =>
  r.ok ? r.items.map((i) => i.value) : [];

test("nama depan saja: entitas yang cocok ditautkan", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Apa jabatan Wulandari?" });
  expect(linked(r)).toEqual(["Sari Wulandari"]);
  expect(values(r)).toContain("direktur utama");
});

test("gelar diabaikan: 'Ibu Sari' = Sari Wulandari", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Apa jabatan Ibu Sari?" });
  expect(linked(r)).toEqual(["Sari Wulandari"]);
  expect(values(r)).toContain("direktur utama");
});

test("badan usaha diabaikan: 'Nusantara Logistik' = PT Nusantara Logistik", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Di kota mana Nusantara Logistik berada?" });
  expect(linked(r)).toEqual(["PT Nusantara Logistik"]);
  expect(values(r)).toContain("Jakarta");
});

test("ambigu: dua 'Budi' dikembalikan keduanya, tidak ditebak satu", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Apa jabatan Budi?" });
  expect(linked(r)).toEqual(["Budi Hartono", "Budi Santoso"]);
  expect(values(r)).toEqual(expect.arrayContaining(["kepala pengadaan", "manajer keuangan"]));
});

test("penyebutan lebih panjang menang: 'Maju Jaya' bukan PT Maju", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Berapa anggaran Maju Jaya?" });
  expect(linked(r)).toEqual(["PT Maju Jaya"]);
  expect(values(r)).toContain(20_000_000);
  expect(values(r)).not.toContain(75_000_000);
});

test("kata atribut, kata tanya, gelar, angka, dan kata pendek tidak menautkan entitas", async () => {
  for (const query of [
    "Apa jabatan?",
    "Berapa anggaran kota?",
    "Apa kabar Pak Bu?",
    "anggaran 75",
  ]) {
    const r = await memory.recall({ scope: SCOPE, query });
    expect(linked(r), query).toEqual([]);
  }
});

test("nama yang tidak ada tetap tidak ditautkan (tidak tahu)", async () => {
  const r = await memory.recall({ scope: SCOPE, query: "Apa jabatan Rudi Hartanto?" });
  expect(linked(r)).toEqual([]);
  expect(r.ok && r.found).toBe(false);
});

test("tanpa kata yang sama, entitas ditemukan lewat kemiripan makna nama (embedder buatan)", async () => {
  // Embedder buatan: "bintang" dan "star" bermakna sama (vektor sama), selain itu vektor lain.
  const embedder = {
    model: "stub-sinonim",
    dimension: 4,
    async embed(texts: string[]) {
      return texts.map((t) => (/bintang|star/i.test(t) ? [1, 0, 0, 0] : [0, 1, 0, 0]));
    },
  };
  const semantic = await createMemory({
    storage: { url: "mem://" },
    attributes: [{ key: "city", description: "kota" }],
    embedder,
  });
  try {
    const stored = await semantic.remember({
      scope: SCOPE,
      source: { received_at: "2026-01-10T09:00:00Z", content: "PT Bintang Timur ada di Medan." },
      facts: [{ entity: "PT Bintang Timur", attribute: "city", value: "Medan", quote: "di Medan" }],
    });
    expect(stored.ok).toBe(true);
    const r = await semantic.recall({ scope: SCOPE, query: "Star Company" });
    expect(linked(r)).toEqual(["PT Bintang Timur"]);
  } finally {
    await semantic.close();
  }
});
