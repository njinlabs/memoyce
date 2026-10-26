# Memoyce

Library memori jangka panjang untuk AI agent, berbasis SurrealDB. Aplikasi memasangnya sebagai
"memory kit"; **AI milik aplikasi yang memanggil tool-nya**. Library tidak memanggil LLM sendiri.
- **Fakta terstruktur** (entitas, atribut, nilai), bukan potongan chat.
- **Sadar waktu**: fakta lama ditutup, tidak dihapus. Bisa ditanya "benar pada tanggal X".
- **Berbukti**: setiap fakta membawa kutipan dari teks sumber, dan kutipan diverifikasi.
- **Pencarian hibrida**: makna (vektor), kata kunci (BM25), dan relasi (graf).
- **Berani menjawab "tidak tahu"**: `found: false` bila bukti di bawah ambang.
- **Netral bahasa**: tidak ada daftar kata bahasa tertentu di dalam library (lihat [Bahasa](#bahasa)).

Kontrak desain lengkap ada di [CLAUDE.md](CLAUDE.md).

## Instalasi

```bash
npm install memoyce surrealdb
# Engine embedded (mem://, rocksdb://, surrealkv://) butuh dua paket opsional dengan binari native:
npm install @surrealdb/node @surrealdb/node-native
```

`surrealdb` adalah peer dependency karena Anda bisa memberikan instance `Surreal` sendiri
(`storage: { db }`). `@surrealdb/node` dan `@surrealdb/node-native` hanya dibutuhkan engine embedded;
bila Anda hanya memakai server remote (`ws://`, `http://`), tidak perlu dipasang
(`npm install --omit=optional`). Bila engine embedded dipakai tanpa paketnya, `createMemory`
melempar `MemoryError` dengan kode `storage` dan pesan yang menjelaskan paket yang kurang.

Persyaratan: Node.js 20+ atau Bun. Hanya ESM.

## Pemakaian

```ts
import { createMemory } from "memoyce";

const memory = await createMemory({
  // rocksdb:// (embedded), surrealkv://, mem://, ws:// (server), atau { db: instanceSurreal }
  storage: { url: "rocksdb://./data/memory" },
  // Kosakata atribut ditentukan aplikasi. Atribut di luar daftar ditolak (vocabulary: "strict").
  attributes: [
    { key: "stage", description: "tahap penjualan" },
    { key: "budget", description: "anggaran", type: "number", aliases: ["dana"] },
    { key: "decision_maker", description: "pengambil keputusan", type: "entity" },
  ],
  // Opsional: tanpa embedder, pencarian makna mati dan sisanya tetap jalan.
  embedder: {
    model: "nama-model",
    dimension: 1024,
    async embed(texts, { kind }) {
      // kind: "document" | "query". Panggil penyedia embedding Anda dan kembalikan number[][].
      return await myEmbeddingProvider(texts, kind);
    },
  },
  // Ambang "tidak tahu". Bergantung pada model embedding DAN dimensinya: kalibrasikan dengan data Anda.
  retrieval: { minSimilarity: 0.5, minKeywordCoverage: 0.5 },
});
```

### Memberi tool ke AI

Aplikasi menentukan **kepemilikan data** (`scope`); AI tidak bisa memilih atau mengubahnya, dan
nilai `scope`/`meta`/ambang yang dikirim AI diabaikan.

```ts
const tools = memory.tools({
  scope: "org:42/lead:7", // tempat menulis
  // readScopes: ["org:42/lead:7", "org:42/shared"], // opsional: baca dari beberapa scope
  sourceMeta: { channel: "whatsapp", userId: "u1" }, // dicatat pada setiap sumber
  // readOnly: true,               // hanya memory_recall dan memory_list_attributes
});
```

Setiap tool berbentuk `{ name, description, inputSchema, execute }`. Tempelkan ke SDK AI Anda:

```ts
// Anthropic
const anthropicTools = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

// OpenAI
const openaiTools = tools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

// Saat AI memanggil tool: jalankan lalu kembalikan hasilnya sebagai JSON.
const result = await tools.find((t) => t.name === call.name)?.execute(call.input);
return JSON.stringify(result);
```

Kesalahan yang bisa diperbaiki AI (atribut salah, kutipan tidak ada di teks, entitas ambigu)
dikembalikan sebagai data `{ ok: false, errors }`, bukan dilempar, sehingga AI bisa memperbaiki
panggilannya sendiri. Galat infrastruktur (embedder, database) dilempar sebagai `MemoryError`.

### Melanjutkan konteks (AI stateless / awal sesi)

AI tidak perlu menunggu pertanyaan. Di awal sesi, atau di setiap panggilan stateless, aplikasi
meminta briefing dan menaruhnya di prompt:

```ts
const briefing = await memory.context({ scope: "org:42/lead:7" });
// briefing.text, mis.:
//   Memori jangka panjang (keadaan per 2025-02-01, yang terbaru lebih dulu):
//   PT Maju (organization)
//   - anggaran: 75000000, sejak 2025-02-01
//   - tahap penjualan: demo, sejak 2025-02-01
// Kosong tetap dinyatakan tegas: "Memori jangka panjang: belum ada informasi yang tersimpan."
const system = `Kamu asisten penjualan.

${briefing.text}`;

// Atau hanya yang relevan dengan pesan pengguna:
const relevant = await memory.context({ scope: "org:42/lead:7", query: userMessage });
```

### Tanpa AI (langsung)

```ts
await memory.remember({
  scope: "org:42/lead:7",
  source: {
    content: "PT Maju menanyakan paket Pro. Budget sekitar 50 juta.",
    received_at: "2025-01-10",
  },
  facts: [
    { entity: "PT Maju", attribute: "budget", value: 50_000_000, quote: "Budget sekitar 50 juta" },
  ],
});

const answer = await memory.recall({ scope: "org:42/lead:7", query: "anggaran PT Maju" });
// answer.found === false berarti memori tidak punya jawabannya: jangan menebak.

await memory.reindex(); // bangun ulang vektor (ganti model embedding, atau mengisi data lama)
await memory.close();
```

## Bahasa

Library tidak membawa daftar kata bahasa apa pun, jadi bahasa data Anda bebas. Dua hal yang perlu
Anda ketahui:
- **Tool meminta AI menulis `query` sebagai kata kunci tanpa kata tanya**, dalam bahasa data
  ("anggaran PT Maju", bukan "Berapa anggaran PT Maju?"). AI multibahasa, sehingga jalur tool tidak
  butuh pengaturan bahasa.
- **Bila Anda memanggil `memory.recall` / `memory.context` langsung dengan kalimat tanya**, isi
  `retrieval.stopwords` (kata fungsi: "apa", "what", "les") dan `retrieval.titles` (gelar dan badan
  usaha: "pt", "mr", "ibu") sesuai bahasa Anda, misalnya dari paket `stopwords-iso`. Tanpa daftar,
  kalimat tanya jatuh ke pencarian makna; hasilnya tetap aman (lebih sering "tidak tahu", bukan
  menebak), hanya lebih lemah.
- Pemecah kata memakai pemisah huruf/angka Unicode dan indeks BM25 SurrealDB. Untuk bahasa tanpa
  spasi (Mandarin, Jepang, Thai), pencarian kata kunci dan pencocokan nama sebagian tidak andal;
  pencarian makna (embedder multibahasa) tetap bekerja.

## Mengkalibrasi ambang

Nilai kemiripan bergantung pada model embedding dan dimensinya, jadi bawaan (0,5) hanya awal.
Folder [evals/](evals/README.md) berisi set evaluasi berlabel dan sapuan ambang (`bun run eval --sweep`);
gunakan sebagai contoh untuk membuat set evaluasi dari percakapan Anda sendiri. Sebagai gambaran
(model `gemini-embedding-001`, 768 dimensi): ambang 0,76 dengan cakupan kata kunci 0,5 memberi
tingkat menebak 5% pada set uji internal. Ambang bergeser tajam menurut dimensi (mis. 0,88 pada 128
dimensi), kalibrasi ulang tiap kali model atau dimensi berubah.

## Skala dan batasan

Terukur (lihat bagian Benchmark di [CLAUDE.md](CLAUDE.md)): jumlah scope hampir tidak berbiaya
(~8 KB dan ~33 ms per scope, tanpa pelambatan sampai 3000 scope), sehingga pola satu scope per
pengguna atau pelanggan cocok. Biaya utama ada pada jumlah vektor (~50 KB disk per fakta pada 768
dimensi). Pada satu scope yang sangat besar (puluhan ribu fakta), recall melambat linear; kerjakan
dengan scope kecil bila bisa. Versi `0.x`: antarmuka masih bisa berubah.

## Mencoba dengan LLM sungguhan

Aplikasi chat terminal dengan Gemini ada di [examples/cli](examples/cli/README.md) (hanya ada di
repositori, tidak ikut paket npm).

## Pengembangan

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run test:coverage   # gagal bila coverage < 95%
bun run build           # dist/ (ESM + deklarasi)
bun run smoke           # uji paket hasil build di Node
```

## Rilis

Membuat GitHub Release dengan tag `vX.Y.Z` (sama dengan `version` di `package.json`) menerbitkan
paket ke npm secara otomatis, lengkap dengan provenance. Pra-rilis (`X.Y.Z-beta.1`) terbit dengan
dist-tag `beta`, tidak menggantikan `latest`.

## Lisensi

MIT
