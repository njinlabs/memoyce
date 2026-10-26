import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext } from "../src/core/context";

// Biaya TETAP partisi vektor per scope: membuat N scope tanpa satu fakta pun. Bukan bagian library.
const N = Number(process.argv[2] ?? 300);
const dim = 768;
const path = resolve("data/bench-partitions");
rmSync(path, { recursive: true, force: true });
const dirSize = (p: string): number =>
  existsSync(p)
    ? readdirSync(p, { withFileTypes: true }).reduce(
        (sum, e) =>
          sum + (e.isDirectory() ? dirSize(join(p, e.name)) : statSync(join(p, e.name)).size),
        0,
      )
    : 0;
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
const embedder = {
  model: "bench",
  dimension: dim,
  maxBatch: 100,
  async embed(t: string[]) {
    return t.map(() => new Array<number>(dim).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
  },
};
let { ctx, close } = await createContext({
  storage: { url: `rocksdb://${path}` },
  attributes: [{ key: "city", description: "kota" }],
  embedder,
});
const base = dirSize(path);
const t0 = performance.now();
for (let s = 0; s < N; s++) {
  await ctx.vectors?.ensure("fvec", `org:${s}`);
  await ctx.vectors?.ensure("evec", `org:${s}`);
}
const ensureMs = (performance.now() - t0) / N;
console.log(
  `${N} scope kosong (2 tabel + 2 indeks HNSW tiap scope): ${ensureMs.toFixed(1)}ms per scope`,
);
console.log(
  `disk: ${mb(dirSize(path))} (dasar ${mb(base)}) -> ${((dirSize(path) - base) / N / 1024).toFixed(0)} KB per scope | rss ${mb(process.memoryUsage().rss)}`,
);
await close();
const t1 = performance.now();
({ ctx, close } = await createContext({
  storage: { url: `rocksdb://${path}` },
  attributes: [{ key: "city", description: "kota" }],
  embedder,
}));
console.log(
  `buka ulang: ${(performance.now() - t1).toFixed(0)}ms | rss ${mb(process.memoryUsage().rss)}`,
);
const t2 = performance.now();
await ctx.vectors?.ensure("fvec", "org:0");
console.log(
  `ensure scope yang sudah ada setelah buka ulang: ${(performance.now() - t2).toFixed(1)}ms`,
);
await close();
rmSync(path, { recursive: true, force: true });
