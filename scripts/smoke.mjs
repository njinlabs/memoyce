// Uji asap paket hasil build di Node murni (tanpa Bun): simpan fakta, ambil kembali, tolak yang
// tanpa bukti, dan jawab "tidak tahu". Dipakai dua cara:
//   node scripts/smoke.mjs            -> menguji dist/ di repositori
//   node smoke.mjs memoyce            -> menguji paket terpasang (dari tarball npm pack)
import assert from "node:assert/strict";

const specifier = process.argv[2] ?? new URL("../dist/index.js", import.meta.url).href;
const { createMemory, MemoryError } = await import(specifier);

assert.equal(typeof createMemory, "function", "createMemory tidak diekspor");
assert.equal(typeof MemoryError, "function", "MemoryError tidak diekspor");

const memory = await createMemory({
  storage: { url: "mem://" },
  attributes: [
    { key: "budget", description: "anggaran", type: "number" },
    { key: "stage", description: "tahap penjualan" },
  ],
});

const stored = await memory.remember({
  scope: "smoke",
  source: {
    content: "PT Maju menanyakan paket Pro. Anggaran sekitar 50 juta.",
    received_at: "2026-01-10",
  },
  facts: [
    {
      entity: "PT Maju",
      attribute: "budget",
      value: 50_000_000,
      quote: "Anggaran sekitar 50 juta",
    },
  ],
});
assert.equal(stored.ok, true, `remember gagal: ${JSON.stringify(stored)}`);

// Kutipan yang tidak ada di teks sumber ditolak, tidak ada yang tertulis.
const rejected = await memory.remember({
  scope: "smoke",
  source: { content: "PT Maju menanyakan paket Pro.", received_at: "2026-01-11" },
  facts: [{ entity: "PT Maju", attribute: "stage", value: "demo", quote: "kutipan karangan" }],
});
assert.equal(rejected.ok, false);
assert.equal(rejected.stage, "validation");

const found = await memory.recall({ scope: "smoke", query: "anggaran PT Maju" });
assert.equal(found.ok && found.found, true, `recall gagal: ${JSON.stringify(found)}`);
assert.equal(found.items[0].value, 50_000_000);

// Scope lain tidak melihat data ini, dan pertanyaan tanpa jawaban tegas "tidak tahu".
const other = await memory.recall({ scope: "lain", query: "anggaran PT Maju" });
assert.equal(other.ok && other.found, false);
const unknown = await memory.recall({ scope: "smoke", query: "warna logo kompetitor" });
assert.equal(unknown.ok && unknown.found, false);
assert.match(unknown.message, /Jangan menebak/);

const tools = memory.tools({ scope: "smoke" });
assert.deepEqual(tools.map((t) => t.name).sort(), [
  "memory_list_attributes",
  "memory_recall",
  "memory_remember",
]);
assert.equal(
  JSON.stringify(tools[0].inputSchema).includes('"scope"'),
  false,
  "scope bocor ke skema tool",
);

await memory.close();
console.log(`smoke OK (${specifier}) pada Node ${process.version}`);
