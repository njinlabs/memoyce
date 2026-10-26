import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createMemory, type Memory, type RememberInput } from "../src/index";
import { embedText } from "../tests/support/embedder";

// Benchmark skala. BUKAN bagian library dan tidak memanggil API apa pun: embedder tiruan
// (bag-of-words di-hash ke vektor) hanya untuk menguji biaya penyimpanan, indeks, dan query.
// Mutu semantik tidak diukur di sini (itu urusan evals/ dengan embedding sungguhan).
//
//   bun bench/scale.ts --mode scopes --scopes 1000 --leads 4          # banyak scope kecil
//   bun bench/scale.ts --mode big --leads 20000                        # satu scope besar
//   tambah --engine rocksdb untuk penyimpanan embedded sungguhan (default mem)

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "scopes" },
    scopes: { type: "string", default: "100" },
    leads: { type: "string", default: "4" },
    engine: { type: "string", default: "mem" },
    dim: { type: "string", default: "768" },
    queries: { type: "string", default: "40" },
    keep: { type: "boolean", default: false },
    // --no-vectors: tanpa embedder, memisahkan biaya partisi vektor per scope dari biaya lainnya.
    "no-vectors": { type: "boolean", default: false },
    // short: "PT Alfa Nusa 17" (4 kata); long: "PT Alfa Nusa Teknik 17" (5 kata).
    names: { type: "string", default: "long" },
  },
});

const dim = Number(args.dim);
const FACTS_PER_LEAD = 5;

const embedder = {
  model: `bench-bow@${dim}`,
  dimension: dim,
  maxBatch: 100,
  async embed(texts: string[]) {
    return texts.map((t) => embedText(t, dim));
  },
};

const A = ["Alfa", "Bima", "Cakra", "Dwipa", "Eka", "Fajar", "Garda", "Harsa", "Indra", "Jaya"];
const B = ["Nusa", "Mulia", "Karya", "Tirta", "Surya", "Bumi", "Cipta", "Sinar", "Maju", "Abadi"];
const C = ["Teknik", "Logistik", "Pangan", "Medika", "Digital", "Energi", "Tekstil", "Kargo"];
const CITIES = [
  "Bandung",
  "Surabaya",
  "Jakarta",
  "Medan",
  "Makassar",
  "Semarang",
  "Denpasar",
  "Malang",
];
const STAGES = ["lead", "discovery", "demo", "negosiasi", "closed_won"];
const ROLES = ["Manajer Pengadaan", "Direktur Operasional", "Kepala Keuangan", "Pemilik", "CTO"];
const PEOPLE = [
  "Agus",
  "Lina",
  "Yusuf",
  "Maya",
  "Slamet",
  "Fajar",
  "Nia",
  "Dimas",
  "Putri",
  "Hasan",
];

// Nama unik deterministik per indeks (sufiks angka menjaga resolusi nama persis tetap tunggal).
const company = (i: number): string =>
  args.names === "short" ? `PT ${A[i % 10]} ${B[Math.floor(i / 10) % 10]} ${i}` : companyLong(i);
const companyLong = (i: number): string =>
  `PT ${A[i % 10]} ${B[Math.floor(i / 10) % 10]} ${C[Math.floor(i / 100) % 8]} ${i}`;
const person = (i: number): string => `${PEOPLE[i % 10]} ${B[(i * 7) % 10]}${i}`;

function lead(i: number, scope: string): { input: RememberInput; budget: number } {
  const co = company(i);
  const pe = person(i);
  const city = CITIES[i % CITIES.length] as string;
  const stage = STAGES[i % STAGES.length] as string;
  const role = ROLES[i % ROLES.length] as string;
  const juta = 10 + ((i * 37) % 490);
  const content =
    `${co} (${city}) dihubungi lewat ${pe}, ${role}. Anggaran sekitar ${juta} juta. ` +
    `Tahap saat ini: ${stage}.`;
  return {
    budget: juta * 1_000_000,
    input: {
      scope,
      source: { content, received_at: "2026-01-10T09:00:00Z" },
      facts: [
        {
          entity: { name: co, kind: "organization" },
          attribute: "city",
          value: city,
          quote: `${co} (${city})`,
        },
        {
          entity: co,
          attribute: "budget",
          value: juta * 1_000_000,
          quote: `Anggaran sekitar ${juta} juta`,
        },
        { entity: co, attribute: "stage", value: stage, quote: `Tahap saat ini: ${stage}` },
        {
          entity: { name: pe, kind: "person" },
          attribute: "works_for",
          value: co,
          quote: `${pe}, ${role}`,
        },
        { entity: pe, attribute: "role", value: role, quote: role },
      ],
    },
  };
}

const attributes = [
  { key: "city", description: "kota" },
  { key: "budget", description: "anggaran", type: "number" as const },
  { key: "stage", description: "tahap penjualan" },
  { key: "role", description: "jabatan" },
  { key: "works_for", description: "perusahaan tempat bekerja", type: "entity" as const },
];

const ms = (x: number): string => `${x.toFixed(1)}ms`;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)}MB`;
const quantile = (xs: number[], q: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const dirSize = (path: string): number => {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (sum, e) =>
      sum + (e.isDirectory() ? dirSize(join(path, e.name)) : statSync(join(path, e.name)).size),
    0,
  );
};

const dbPath = resolve("data/bench-scale");
if (args.engine === "rocksdb") {
  rmSync(dbPath, { recursive: true, force: true });
  mkdirSync(resolve("data"), { recursive: true });
}
const url = args.engine === "rocksdb" ? `rocksdb://${dbPath}` : "mem://";

async function open(): Promise<Memory> {
  return createMemory({
    storage: { url },
    attributes,
    embedder: args["no-vectors"] ? undefined : embedder,
  });
}

async function probe(memory: Memory, scopeOf: (i: number) => string, total: number, label: string) {
  const n = Number(args.queries);
  const lat: number[] = [];
  const latUnknown: number[] = [];
  let correct = 0;
  for (let k = 0; k < n; k++) {
    const i = Math.floor(((k + 1) * 2654435761) % total);
    const scope = scopeOf(i);
    const { budget } = lead(i, scope);
    const t0 = performance.now();
    const r = await memory.recall({ scope, query: `anggaran ${company(i)}`, min_similarity: 0.3 });
    lat.push(performance.now() - t0);
    if (r.ok && r.items.some((it) => it.attribute === "budget" && it.value === budget)) correct++;
    const t1 = performance.now();
    await memory.recall({
      scope,
      query: "anggaran PT Sentosa Tidakada 999999",
      min_similarity: 0.3,
    });
    latUnknown.push(performance.now() - t1);
  }
  console.log(
    `${label}: recall p50 ${ms(quantile(lat, 0.5))} p95 ${ms(quantile(lat, 0.95))} | tak dikenal p50 ${ms(quantile(latUnknown, 0.5))} p95 ${ms(quantile(latUnknown, 0.95))} | benar ${correct}/${n}`,
  );
}

const t0 = performance.now();
let memory = await open();
console.log(
  `engine=${args.engine} dim=${dim} mode=${args.mode}; buka (kosong): ${ms(performance.now() - t0)}`,
);

if (args.mode === "scopes") {
  const scopes = Number(args.scopes);
  const leads = Number(args.leads);
  console.log(
    `${scopes} scope x ${leads} lead x ${FACTS_PER_LEAD} fakta = ${scopes * leads * FACTS_PER_LEAD} fakta`,
  );
  const perScope: number[] = [];
  const tAll = performance.now();
  for (let s = 0; s < scopes; s++) {
    const scope = `org:${s}`;
    const t = performance.now();
    for (let j = 0; j < leads; j++) {
      const { input } = lead(s * leads + j, scope);
      const r = await memory.remember(input);
      if (!r.ok) throw new Error(`remember gagal: ${JSON.stringify(r).slice(0, 300)}`);
    }
    perScope.push(performance.now() - t);
    if ((s + 1) % Math.max(1, Math.floor(scopes / 5)) === 0) {
      console.log(
        `  ${s + 1}/${scopes} scope | scope terakhir ${ms(perScope.at(-1) ?? 0)} | total ${((performance.now() - tAll) / 1000).toFixed(1)}s | rss ${mb(process.memoryUsage().rss)}`,
      );
    }
  }
  console.log(
    `isi: total ${((performance.now() - tAll) / 1000).toFixed(1)}s | per scope p50 ${ms(quantile(perScope, 0.5))} p95 ${ms(quantile(perScope, 0.95))} | scope pertama ${ms(perScope[0] ?? 0)} | 10% terakhir p50 ${ms(quantile(perScope.slice(-Math.ceil(scopes / 10)), 0.5))}`,
  );
  await probe(memory, (i) => `org:${Math.floor(i / leads)}`, scopes * leads, "recall");
  console.log(
    `rss ${mb(process.memoryUsage().rss)}${args.engine === "rocksdb" ? ` | disk ${mb(dirSize(dbPath))}` : ""}`,
  );
} else {
  const leads = Number(args.leads);
  const scope = "org:big";
  console.log(
    `1 scope x ${leads} lead x ${FACTS_PER_LEAD} fakta = ${leads * FACTS_PER_LEAD} fakta`,
  );
  const tAll = performance.now();
  const checkpoints = new Set([1, 2, 4, 5].map((q) => Math.floor((leads * q) / 5)));
  let batchStart = performance.now();
  for (let i = 0; i < leads; i++) {
    const { input } = lead(i, scope);
    const r = await memory.remember(input);
    if (!r.ok) throw new Error(`remember gagal: ${JSON.stringify(r).slice(0, 300)}`);
    if (checkpoints.has(i + 1)) {
      const per = (performance.now() - batchStart) / Math.max(1, Math.floor(leads / 5));
      console.log(
        `  ${(i + 1) * FACTS_PER_LEAD} fakta | ${ms(per)}/lead sejak checkpoint | total ${((performance.now() - tAll) / 1000).toFixed(1)}s | rss ${mb(process.memoryUsage().rss)}`,
      );
      await probe(memory, () => scope, i + 1, `    recall @${(i + 1) * FACTS_PER_LEAD}`);
      batchStart = performance.now();
    }
  }
  console.log(`isi: total ${((performance.now() - tAll) / 1000).toFixed(1)}s`);
  console.log(
    `rss ${mb(process.memoryUsage().rss)}${args.engine === "rocksdb" ? ` | disk ${mb(dirSize(dbPath))}` : ""}`,
  );
}

await memory.close();

if (args.engine === "rocksdb") {
  console.log(`disk setelah ditutup: ${mb(dirSize(dbPath))}`);
  // Buka ulang: waktu startup dengan data yang sudah ada (mencakup migrasi/cek skema).
  const t1 = performance.now();
  memory = await open();
  console.log(
    `buka ulang (data ada): ${ms(performance.now() - t1)} | rss ${mb(process.memoryUsage().rss)}`,
  );
  const t2 = performance.now();
  await memory.recall({ scope: "org:0", query: `anggaran ${company(0)}`, min_similarity: 0.3 });
  console.log(`recall pertama setelah buka ulang: ${ms(performance.now() - t2)}`);
  await memory.close();
  if (!args.keep) rmSync(dbPath, { recursive: true, force: true });
}
