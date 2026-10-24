# Agent Memory Kit

Library memori jangka panjang untuk AI agent, berbasis SurrealDB. Aplikasi memasangnya sebagai
"memory kit"; **AI milik aplikasi yang memanggil tool-nya**. Library tidak memanggil LLM sendiri.
- **Fakta terstruktur** (entitas, atribut, nilai), bukan potongan chat.
- **Sadar waktu**: fakta lama ditutup, tidak dihapus. Bisa ditanya "benar pada tanggal X".
- **Berbukti**: setiap fakta membawa kutipan dari teks sumber, dan kutipan diverifikasi.
- **Pencarian hibrida**: makna (vektor), kata kunci (BM25), dan relasi (graf).
- **Berani menjawab "tidak tahu"**: `found: false` bila bukti di bawah ambang.

Kontrak desain lengkap ada di [CLAUDE.md](CLAUDE.md). Library belum dipublikasikan ke npm.

## Pemakaian

```ts
import { createMemory } from "agent"; // nama paket menyusul

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
  // Ambang "tidak tahu". Bergantung pada model embedding: kalibrasikan dengan data Anda.
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

const answer = await memory.recall({ scope: "org:42/lead:7", query: "berapa budget PT Maju" });
// answer.found === false berarti memori tidak punya jawabannya: jangan menebak.

await memory.reindex(); // bangun ulang vektor (ganti model embedding, atau mengisi data lama)
await memory.close();
```

## Mencoba dengan LLM sungguhan

Aplikasi chat terminal dengan Gemini ada di [examples/cli](examples/cli/README.md).

## Pengembangan

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run test:coverage   # gagal bila coverage < 95%
```
