import { parseArgs } from "node:util";
import { createContext } from "../src/core/context";
import { remember } from "../src/core/remember";
import { embedText } from "../tests/support/embedder";

// Profil per kueri recall pada satu scope besar. Bukan bagian library; tanpa API eksternal.
const { values: args } = parseArgs({ options: { leads: { type: "string", default: "2000" } } });
const dim = 768;
const embedder = {
  model: "bench",
  dimension: dim,
  maxBatch: 100,
  async embed(texts: string[]) {
    return texts.map((t) => embedText(t, dim));
  },
};
const { ctx, close } = await createContext({
  storage: { url: "mem://" },
  attributes: [
    { key: "city", description: "kota" },
    { key: "budget", description: "anggaran", type: "number" },
  ],
  embedder,
});
const scope = "org:big";
const A = ["Alfa", "Bima", "Cakra", "Dwipa", "Eka", "Fajar", "Garda", "Harsa", "Indra", "Jaya"];
const B = ["Nusa", "Mulia", "Karya", "Tirta", "Surya", "Bumi", "Cipta", "Sinar", "Maju", "Abadi"];
const name = (i: number) => `PT ${A[i % 10]} ${B[Math.floor(i / 10) % 10]} ${i}`;
const n = Number(args.leads);
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const co = name(i);
  const r = await remember(ctx, {
    scope,
    source: {
      content: `${co} (Bandung). Anggaran sekitar ${10 + (i % 400)} juta.`,
      received_at: "2026-01-10T09:00:00Z",
    },
    facts: [
      {
        entity: { name: co, kind: "organization" },
        attribute: "city",
        value: "Bandung",
        quote: `${co} (Bandung)`,
      },
      {
        entity: co,
        attribute: "budget",
        value: (10 + (i % 400)) * 1_000_000,
        quote: `Anggaran sekitar ${10 + (i % 400)} juta`,
      },
    ],
  });
  if (!r.ok) throw new Error("seed gagal");
}
console.log(`seed ${n} lead (${n * 2} fakta): ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const time = async (label: string, fn: () => Promise<unknown>) => {
  const xs: number[] = [];
  for (let k = 0; k < 5; k++) {
    const s = performance.now();
    await fn();
    xs.push(performance.now() - s);
  }
  xs.sort((a, b) => a - b);
  console.log(`${label.padEnd(44)} p50 ${(xs[2] as number).toFixed(1)}ms`);
};
const q = (sql: string, vars: Record<string, unknown>) => async () => {
  await ctx.db.query(sql, vars).collect();
};
const asOf = new Date();
const vec = embedText("anggaran PT Alfa Nusa 17", dim);
const fvec = await ctx.vectors?.ensure("fvec", scope);
const evec = await ctx.vectors?.ensure("evec", scope);
const validity = "valid_from <= $asOf AND (valid_to = NONE OR valid_to > $asOf)";
const [ents] = await ctx.db
  .query<[{ id: unknown }[]]>("SELECT id FROM entity WHERE scope = $s LIMIT 1", { s: scope })
  .collect();

await time(
  "A. unseen: count(anggaran)  [GROUP ALL]",
  q("SELECT count() AS n FROM fact WHERE scope IN $s AND text @@ $t GROUP ALL", {
    s: [scope],
    t: "anggaran",
  }),
);
await time(
  "A2. unseen: count(sentosa)  [0 hasil]",
  q("SELECT count() AS n FROM fact WHERE scope IN $s AND text @@ $t GROUP ALL", {
    s: [scope],
    t: "sentosa",
  }),
);
await time(
  "B. BM25 OR 'anggaran pt alfa 17' LIMIT 50",
  q(
    `SELECT id, scope, text, search::score(0) AS s FROM fact WHERE scope IN $s AND text @0,OR@ $query AND ${validity} ORDER BY s DESC LIMIT 50`,
    { s: [scope], query: "anggaran PT Alfa Nusa 17", asOf },
  ),
);
await time(
  "B2. BM25 OR kata umum 'anggaran pt'",
  q(
    `SELECT id, scope, text, search::score(0) AS s FROM fact WHERE scope IN $s AND text @0,OR@ $query AND ${validity} ORDER BY s DESC LIMIT 50`,
    { s: [scope], query: "anggaran PT", asOf },
  ),
);
await time(
  "C. ANN fakta k=64 ef=128",
  q(
    `SELECT ref, valid_from, valid_to, vector::distance::knn() AS d FROM type::table($t) WHERE embedding <|64,128|> $v`,
    { t: fvec, v: vec },
  ),
);
await time(
  "C2. ANN fakta k=400 ef=800",
  q(
    `SELECT ref, valid_from, valid_to, vector::distance::knn() AS d FROM type::table($t) WHERE embedding <|400,800|> $v`,
    { t: fvec, v: vec },
  ),
);
await time(
  "D. entitas persis keys CONTAINSANY",
  q(
    "SELECT id, name, kind, scope, keys FROM entity WHERE scope IN $s AND keys CONTAINSANY $g LIMIT 50",
    { s: [scope], g: ["pt alfa nusa 17", "pt", "alfa"] },
  ),
);
await time(
  "E. entitas sebagian words CONTAINSANY",
  q(
    "SELECT id, name, kind, scope, keys FROM entity WHERE scope IN $s AND words CONTAINSANY $w LIMIT 50",
    { s: [scope], w: ["alfa", "nusa"] },
  ),
);
await time(
  "F. graf: fakta entitas  entity IN",
  q(
    `SELECT id, value, scope, text FROM fact WHERE scope IN $s AND entity IN $e AND ${validity} ORDER BY valid_from DESC LIMIT 200`,
    { s: [scope], e: [ents?.[0]?.id], asOf },
  ),
);
await time(
  "G. ANN entitas k=5",
  q(`SELECT ref, vector::distance::knn() AS d FROM type::table($t) WHERE embedding <|5,64|> $v`, {
    t: evec,
    v: vec,
  }),
);
await close();
