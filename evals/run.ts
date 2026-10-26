import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { salesAttributes } from "../examples/cli/attributes";
import { geminiEmbedder, openAiEmbedder } from "../examples/cli/embedders";
import { createMemory, type Embedder, type RecallItem } from "../src/index";
import { questions, seedSteps } from "./dataset";
import { cacheQueryEmbeddings, evaluate, seed, sweep, throttleEmbedder } from "./harness";
import { byCategory, matches, pickThreshold, type Summary, summarize } from "./metrics";

// Evaluasi retrieval pada embedding sungguhan. Jalankan: bun run eval   (lihat evals/README.md)
// Membaca environment variable boleh di sini (bukan bagian library).

const { values: args } = parseArgs({
  options: {
    sweep: { type: "boolean", default: false },
    signals: { type: "boolean", default: false },
    rewrite: { type: "boolean", default: false },
    // Daftar kata fungsi/gelar bahasa Indonesia dari aplikasi. Bawaan: tanpa daftar (netral bahasa).
    language: { type: "string" },
    failures: { type: "boolean", default: false },
    "max-false-answer": { type: "string", default: "0.05" },
    similarity: { type: "string" },
    coverage: { type: "string" },
  },
});

// EMBEDDING_DIMENSION: dimensi vektor (bawaan 768). Dimensi lebih kecil menghemat disk secara proporsional.
const dimension = process.env.EMBEDDING_DIMENSION
  ? Number(process.env.EMBEDDING_DIMENSION)
  : undefined;

function chooseEmbedder(): Embedder {
  const provider =
    process.env.EMBEDDING_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai" : "gemini");
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("EMBEDDING_PROVIDER=openai membutuhkan OPENAI_API_KEY");
    return openAiEmbedder({ apiKey, dimension });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Isi GEMINI_API_KEY atau OPENAI_API_KEY (lihat .env.example)");
  return geminiEmbedder({ ai: new GoogleGenAI({ apiKey }), dimension });
}

// Salinan deskripsi memory_recall SEBELUM kosakata atribut ditambahkan, sebagai pembanding.
const OLD_RECALL_DESCRIPTION = [
  "Cari informasi di memori jangka panjang. Panggil sebelum menjawab hal yang mungkin pernah disampaikan pengguna (angka, preferensi, status, riwayat).",
  "`query` berupa pertanyaan atau kata kunci; gunakan nama entitas dan istilah penting. `as_of` (ISO 8601) menanyakan keadaan pada tanggal tertentu; tanpa itu hasilnya adalah kondisi terkini.",
  "Setiap hasil membawa `quote` dan `source` sebagai bukti, serta `valid_from`/`valid_to`.",
  "Jika `found` bernilai false, artinya memori TIDAK punya jawabannya: katakan kamu tidak tahu atau tanyakan ke pengguna. JANGAN menebak atau mengisi dari asumsi.",
].join(String.fromCharCode(10));

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

function row(label: string, s: Summary): string {
  return [
    label.padEnd(15),
    String(s.total).padStart(3),
    pct(s.accuracy).padStart(5),
    `${s.answeredFully}/${s.answerable}`.padStart(7),
    pct(s.recall).padStart(7),
    pct(s.hitAt1).padStart(6),
    s.mrr.toFixed(2).padStart(5),
    `${s.abstained}/${s.unanswerable}`.padStart(7),
    pct(s.falseAnswerRate).padStart(6),
    pct(s.leakRate).padStart(6),
  ].join(" ");
}

const HEADER = `${"kategori".padEnd(15)} ${"n".padStart(3)} ${"akur".padStart(5)} ${"lengkap".padStart(7)} ${"recall".padStart(7)} ${"hit@1".padStart(6)} ${"mrr".padStart(5)} ${"tolak".padStart(7)} ${"salah".padStart(6)} ${"bocor".padStart(6)}`;

// Cache embedding di disk (data/ di-ignore git): percobaan berulang tidak memanggil API lagi.
// Kunci memuat model, jenis (dokumen/query), dan teks, jadi mengganti model otomatis memakai cache lain.
function diskCache(inner: Embedder, file: string): Embedder {
  const store: Record<string, number[]> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const id = (kind: string, text: string) => `${inner.model}|${kind}|${text}`;
  return {
    model: inner.model,
    dimension: inner.dimension,
    maxBatch: inner.maxBatch,
    async embed(texts, options) {
      const missing = [...new Set(texts.filter((t) => !store[id(options.kind, t)]))];
      if (missing.length > 0) {
        const vectors = await inner.embed(missing, options);
        for (const [i, text] of missing.entries()) store[id(options.kind, text)] = vectors[i] ?? [];
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(store));
      }
      return texts.map((t) => store[id(options.kind, t)] as number[]);
    },
  };
}

// EMBEDDING_PROVIDER=none: tanpa vektor (hanya kata kunci + graf), untuk mengukur sumbangan vektor.
const embedder =
  process.env.EMBEDDING_PROVIDER === "none"
    ? undefined
    : cacheQueryEmbeddings(
        diskCache(throttleEmbedder(chooseEmbedder()), resolve("data/eval-embeddings.json")),
      );
// Library tidak membawa daftar bahasa; evaluasi meniru aplikasi yang mengisinya (--language id).
const indonesian = {
  stopwords: (
    "apa siapa berapa kapan dimana mana bagaimana kenapa mengapa apakah adalah yang dan atau di ke " +
    "dari untuk dengan pada ini itu ada berada saja saat sedang saya kami kita dia mereka sudah " +
    "belum akan masih sekarang tolong"
  ).split(" "),
  titles: [
    "pt",
    "cv",
    "ud",
    "pd",
    "tbk",
    "bapak",
    "pak",
    "ibu",
    "bu",
    "sdr",
    "sdri",
    "mas",
    "mbak",
    "kak",
  ],
};
const memory = await createMemory({
  storage: { url: "mem://" },
  attributes: salesAttributes,
  embedder,
  retrieval: args.language === "id" ? indonesian : {},
});

console.log(`Embedder: ${embedder?.model ?? "tanpa vektor"}`);
const facts = await seed(memory, seedSteps);
console.log(
  `Korpus: ${seedSteps.length} sumber, ${facts} fakta. Pertanyaan: ${questions.length}\n`,
);

const thresholds = {
  min_similarity: args.similarity === undefined ? undefined : Number(args.similarity),
  min_keyword_coverage: args.coverage === undefined ? undefined : Number(args.coverage),
};
const scores = await evaluate(memory, questions, thresholds);
const overall = byCategory(scores);

console.log(HEADER);
for (const [category, summary] of overall) console.log(row(category, summary));
const total = summarize(scores);
console.log("-".repeat(HEADER.length));
console.log(row("SEMUA", total));
console.log(
  "\nakur = benar seluruhnya | lengkap = bisa dijawab & semua jawaban muncul | tolak = tak bisa" +
    " dijawab & dijawab tidak tahu | salah = tak bisa dijawab tetapi dijawab ketemu | bocor =" +
    " memuat fakta terlarang",
);

if (args.failures) {
  console.log("\nGagal:");
  for (const s of scores.filter((x) => !x.correct)) {
    const why = s.leaked
      ? "bocor fakta terlarang"
      : s.answerable
        ? `recall ${pct(s.recall)}${s.found ? "" : ", found=false"}`
        : "menjawab padahal tidak ada jawaban";
    console.log(`  ${s.id.padEnd(16)} ${s.category.padEnd(15)} ${why}`);
  }
}

// Sinyal mentah pada ambang paling longgar: bahan memilih aturan "tahu atau tidak". Untuk yang
// bisa dijawab ditampilkan item benar terbaik dan item salah teratas; untuk yang tidak, item teratas.
if (args.signals) {
  const fmt = (item?: RecallItem): string =>
    item
      ? `v=${(item.signals.vector ?? Number.NaN).toFixed(2)} k=${(item.signals.keyword ?? Number.NaN).toFixed(2)} e=${item.signals.entity ?? "-"}`
      : "(tidak ada)";
  console.log(
    "\nSinyal (salah = item bukan jawaban dengan kosinus tertinggi; v=kosinus, k=cakupan istilah, e=hubungan entitas):",
  );
  for (const question of questions) {
    const result = await memory.recall({
      scope: question.scope,
      query: question.query,
      as_of: question.as_of,
      min_similarity: -1,
      min_keyword_coverage: 0,
    });
    const items = result.ok ? result.items : [];
    const linked = result.ok ? result.linked_entities.length : 0;
    const right = items.find((i) => question.answers.some((a) => matches(i, a)));
    const wrong = items
      .filter((i) => !question.answers.some((a) => matches(i, a)))
      .sort((x, y) => (y.signals.vector ?? 0) - (x.signals.vector ?? 0))[0];
    const tag = question.answers.length > 0 ? "JAWAB" : "TIDAK";
    console.log(
      `${question.id.padEnd(15)} ${tag} ent=${linked} benar[${fmt(right)}] vektor-tertinggi-salah[${fmt(wrong)}]`,
    );
  }
}

// Mengukur peran AI pemanggil: Gemini menulis `query` memory_recall dari pertanyaan pengguna hanya
// berdasarkan deskripsi tool, dua varian: deskripsi lama (tanpa kosakata atribut) dan baru. `as_of`
// tetap dari label (di aplikasi, AI mengisinya dari kalimat pengguna).
if (args.rewrite) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("--rewrite membutuhkan GEMINI_API_KEY");
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
  const recallTool = memory
    .tools({ scope: "org:1", readOnly: true })
    .find((t) => t.name === "memory_recall");
  if (!recallTool) throw new Error("tool memory_recall tidak ditemukan");

  const variants = { lama: OLD_RECALL_DESCRIPTION, baru: recallTool.description };
  const cacheFile = resolve("data/eval-rewrites.json");
  const cache: Record<string, string> = existsSync(cacheFile)
    ? JSON.parse(readFileSync(cacheFile, "utf8"))
    : {};

  async function writeQuery(description: string, question: string): Promise<string> {
    const id = `${model}|${description}|${question}`;
    if (cache[id]) return cache[id];
    const prompt = [
      "Kamu asisten penjualan. Kamu punya tool berikut.",
      "",
      "TOOL memory_recall",
      description,
      "",
      `Pengguna bertanya: "${question}"`,
      "",
      "Tulis HANYA nilai argumen `query` yang akan kamu kirim ke memory_recall, satu baris, tanpa penjelasan dan tanpa tanda kutip.",
    ].join(String.fromCharCode(10));
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0 },
        });
        const text =
          (result.text ?? "")
            .trim()
            .split(/\r?\n/)[0]
            ?.replace(/^["']|["']$/g, "") ?? "";
        cache[id] = text || question;
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(cache));
        return cache[id];
      } catch (error) {
        if (!/429|RESOURCE_EXHAUSTED|503|UNAVAILABLE/.test(String(error)) || attempt >= 6)
          throw error;
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  }

  const thr = {
    min_similarity: thresholds.min_similarity,
    min_keyword_coverage: thresholds.min_keyword_coverage,
  };
  console.log(`
Penulisan ulang query oleh ${model} (ambang: ${JSON.stringify(thr)})`);
  console.log(HEADER);
  const base = summarize(scores);
  console.log(row("pertanyaan asli", base));
  for (const [name, description] of Object.entries(variants)) {
    const rewritten = [];
    for (const question of questions) {
      rewritten.push({ ...question, query: await writeQuery(description, question.query) });
      await new Promise((r) => setTimeout(r, 300));
    }
    const result = await evaluate(memory, rewritten, thr);
    console.log(row(`deskripsi ${name}`, summarize(result)));
    if (args.failures) {
      for (const [i, sc] of result.entries()) {
        if (!sc.correct)
          console.log(`    ${sc.id.padEnd(15)} "${(rewritten[i] as { query: string }).query}"`);
      }
    }
  }
}

if (args.sweep) {
  const points = await sweep(memory, questions, {
    similarities: [0.5, 0.6, 0.65, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88, 0.9],
    coverages: [0.34, 0.5, 0.67, 1],
  });
  console.log("\nSapuan ambang (sim x coverage):");
  console.log(
    `${"sim".padEnd(5)} ${"cov".padEnd(5)} ${"akur".padStart(5)} ${"lengkap".padStart(8)} ${"salah".padStart(6)} ${"bocor".padStart(6)}`,
  );
  for (const p of points) {
    console.log(
      `${String(p.minSimilarity).padEnd(5)} ${String(p.minKeywordCoverage).padEnd(5)} ${pct(p.summary.accuracy).padStart(5)} ${`${p.summary.answeredFully}/${p.summary.answerable}`.padStart(8)} ${pct(p.summary.falseAnswerRate).padStart(6)} ${pct(p.summary.leakRate).padStart(6)}`,
    );
  }
  const best = pickThreshold(points, Number(args["max-false-answer"]));
  console.log(
    best
      ? `\nUsulan: minSimilarity=${best.minSimilarity}, minKeywordCoverage=${best.minKeywordCoverage} (salah <= ${pct(Number(args["max-false-answer"]))}, tanpa kebocoran)`
      : "\nTidak ada titik yang memenuhi batas; periksa daftar gagal (--failures).",
  );
}

await memory.close();
