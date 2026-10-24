import { afterAll, beforeAll, expect, test } from "bun:test";
import { createNodeEngines } from "@surrealdb/node";
import { type DateTime, type RecordId, Surreal } from "surrealdb";
import { type Ctx, createContext } from "../../src/core/context";
import type { MemoryError } from "../../src/core/errors";
import { assertFact } from "../../src/core/fact";
import { recall } from "../../src/core/recall";
import { createEntity, createSource } from "../../src/core/records";
import { reindex } from "../../src/core/reindex";
import { remember } from "../../src/core/remember";
import { partitionTable } from "../../src/core/vectors";
import { testAttributes } from "../support/context";
import { createFakeEmbedder } from "../support/embedder";

// Beberapa konteks membuka DB yang sama lewat satu koneksi milik "aplikasi" (storage.db),
// sehingga data bertahan antar pembukaan seperti pada penyimpanan sungguhan.
let host: Surreal;
let counter = 0;

beforeAll(async () => {
  host = new Surreal({ engines: createNodeEngines() });
  await host.connect("mem://");
});

afterAll(() => host.close());

const newDb = () => `db_${++counter}`;

const open = async (
  database: string,
  extra: {
    embedder?: ReturnType<typeof createFakeEmbedder>;
    onEmbedderChange?: "error" | "reindex";
  } = {},
) => {
  const { ctx, close } = await createContext({
    storage: { db: host, namespace: "ns", database },
    attributes: testAttributes,
    retrieval: { minSimilarity: 0.3, minKeywordCoverage: 0.3 },
    ...extra,
  });
  return { ctx, close };
};

const failure = async (promise: Promise<unknown>): Promise<MemoryError> => {
  try {
    await promise;
  } catch (error) {
    return error as MemoryError;
  }
  throw new Error("seharusnya melempar");
};

interface VecRow {
  ref: RecordId;
  scope: string;
  valid_to?: DateTime;
}

const vectorRows = async (ctx: Ctx, kind: "fvec" | "evec", scope: string): Promise<VecRow[]> => {
  const [rows] = await ctx.db
    .query<[VecRow[]]>("SELECT * FROM type::table($table)", { table: partitionTable(kind, scope) })
    .collect();
  return rows ?? [];
};

const meta = async (ctx: Ctx) => {
  const [row] = await ctx.db
    .query<[{ model: string; dimension: number } | undefined]>(
      "SELECT model, dimension FROM ONLY meta:embedding",
    )
    .collect();
  return row;
};

const budget = (scope: string, value: number, at: string) => ({
  scope,
  source: { content: `Budget PT Maju ${value} juta`, received_at: at },
  facts: [
    {
      entity: { name: "PT Maju", kind: "organization" },
      attribute: "city",
      value: `Kota ${value}`,
      quote: `Budget PT Maju ${value}`,
    },
  ],
});

test("embedder baru pada DB kosong: model dan dimensi tercatat; dibuka ulang dengan embedder sama aman", async () => {
  const database = newDb();
  const first = await open(database, { embedder: createFakeEmbedder() });
  expect(await meta(first.ctx)).toEqual({ model: "fake-bow", dimension: 256 });
  await first.close();

  const second = await open(database, { embedder: createFakeEmbedder() });
  expect(await meta(second.ctx)).toEqual({ model: "fake-bow", dimension: 256 });
  await second.close();
});

test("model berbeda ditolak dengan embedder_mismatch (default)", async () => {
  const database = newDb();
  await (await open(database, { embedder: createFakeEmbedder() })).close();

  const byModel = await failure(
    open(database, { embedder: createFakeEmbedder({ model: "lain" }) }),
  );
  expect(byModel.code).toBe("embedder_mismatch");
  expect(byModel.message).toContain("reindex");
  expect(byModel.details.configured).toEqual({ model: "lain", dimension: 256 });

  const byDimension = await failure(
    open(database, { embedder: createFakeEmbedder({ dimension: 32 }) }),
  );
  expect(byDimension.code).toBe("embedder_mismatch");
});

test("onEmbedderChange=reindex: ganti model/dimensi membangun ulang vektor dan meta", async () => {
  const database = newDb();
  const scope = "org:1";
  const first = await open(database, { embedder: createFakeEmbedder({ dimension: 64 }) });
  expect((await remember(first.ctx, budget(scope, 50, "2025-01-10T00:00:00Z"))).ok).toBe(true);
  await first.close();

  const next = createFakeEmbedder({ model: "model-baru", dimension: 32 });
  const second = await open(database, { embedder: next, onEmbedderChange: "reindex" });
  expect(await meta(second.ctx)).toEqual({ model: "model-baru", dimension: 32 });
  expect(await vectorRows(second.ctx, "fvec", scope)).toHaveLength(1);
  expect(await vectorRows(second.ctx, "evec", scope)).toHaveLength(1);

  const result = await recall(second.ctx, { scope, query: "Budget PT Maju 50" });
  expect(result.ok && result.found).toBe(true);
  await second.close();
});

test("embedder dipasang pada data lama tanpa vektor: ditolak, atau di-backfill dengan reindex", async () => {
  const database = newDb();
  const scope = "org:1";
  const plain = await open(database);
  const entity = await createEntity(plain.ctx, { scope, name: "Budi", kind: "person" });
  const source = await createSource(plain.ctx, { scope, content: "Budi tinggal di Bandung" });
  // Fakta lama dibuat tanpa `text` (sebelum fitur teks/vektor ada).
  await assertFact(plain.ctx, {
    scope,
    entity,
    attribute: "city",
    value: "Bandung",
    source,
    quote: "tinggal di Bandung",
    at: new Date("2025-01-01"),
  });
  await plain.close();

  const rejected = await failure(open(database, { embedder: createFakeEmbedder() }));
  expect(rejected.code).toBe("embedder_mismatch");
  expect(rejected.message).toContain("belum punya vektor");

  const embedder = createFakeEmbedder();
  const upgraded = await open(database, { embedder, onEmbedderChange: "reindex" });
  expect(await meta(upgraded.ctx)).toEqual({ model: "fake-bow", dimension: 256 });
  const [rows] = await upgraded.ctx.db
    .query<[{ text: string }[]]>("SELECT text FROM fact")
    .collect();
  const fact = rows?.[0];
  expect(fact?.text).toBe("Budi · kota tinggal: Bandung — tinggal di Bandung");

  const result = await recall(upgraded.ctx, { scope, query: "Budi tinggal di kota apa" });
  expect(result.ok && result.found).toBe(true);
  await upgraded.close();
});

test("reindex: jumlah, vektor fakta tertutup membawa valid_to, nilai referensi memakai nama entitas", async () => {
  const database = newDb();
  const scope = "org:1";
  const embedder = createFakeEmbedder();
  const { ctx, close } = await open(database, { embedder });

  expect((await remember(ctx, budget(scope, 50, "2025-01-10T00:00:00Z"))).ok).toBe(true);
  expect((await remember(ctx, budget(scope, 75, "2025-02-10T00:00:00Z"))).ok).toBe(true);
  expect(
    (
      await remember(ctx, {
        scope,
        source: { content: "Budi bekerja di Acme", received_at: "2025-03-01T00:00:00Z" },
        facts: [
          { entity: "Budi", attribute: "works_for", value: "Acme", quote: "bekerja di Acme" },
        ],
      })
    ).ok,
  ).toBe(true);

  const counts = await reindex(ctx);
  // entitas: PT Maju, Budi, Acme; fakta: city (ditutup) + city (berlaku) + works_for.
  expect(counts).toEqual({ entities: 3, facts: 3 });

  const rows = await vectorRows(ctx, "fvec", scope);
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.valid_to).length).toBe(1);
  expect(await vectorRows(ctx, "evec", scope)).toHaveLength(3);

  // Idempoten: menjalankan ulang menghasilkan jumlah yang sama, tanpa duplikat.
  expect(await reindex(ctx)).toEqual(counts);
  expect(await vectorRows(ctx, "fvec", scope)).toHaveLength(3);

  const [refFact] = await ctx.db
    .query<[{ text: string }[]]>("SELECT text FROM fact WHERE attribute = 'works_for'")
    .collect();
  expect(refFact?.[0]?.text).toContain("Acme");
  await close();
});

test("reindex mengisi teks fakta bernilai referensi yang belum punya teks", async () => {
  const database = newDb();
  const scope = "org:1";
  const embedder = createFakeEmbedder();
  const { ctx, close } = await open(database, { embedder });
  const budi = await createEntity(ctx, { scope, name: "Budi", kind: "person" });
  const acme = await createEntity(ctx, { scope, name: "Acme", kind: "organization" });
  const source = await createSource(ctx, { scope, content: "Budi bekerja di Acme" });
  await assertFact(ctx, {
    scope,
    entity: budi,
    attribute: "works_for",
    value: acme,
    source,
    quote: "bekerja di Acme",
  });
  await assertFact(ctx, {
    scope,
    entity: budi,
    attribute: "unknown_attr_ok",
    value: "x",
    source,
  }).catch(() => {});

  await reindex(ctx);
  const [rows] = await ctx.db
    .query<[{ text: string }[]]>("SELECT text FROM fact WHERE attribute = 'works_for'")
    .collect();
  expect(rows?.[0]?.text).toBe("Budi · organisasi tempat bekerja: Acme — bekerja di Acme");
  await close();
});

test("reindex tanpa embedder ditolak", async () => {
  const { ctx, close } = await open(newDb());
  const error = await failure(reindex(ctx));
  expect(error.code).toBe("embedder");
  expect(error.message).toContain("embedder");
  await close();
});
