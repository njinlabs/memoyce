import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DateTime, RecordId } from "surrealdb";
import { retractFact } from "../../src/core/fact";
import { createEntity } from "../../src/core/records";
import { type RememberInput, remember } from "../../src/core/remember";
import { partitionTable } from "../../src/core/vectors";
import { openTestContext, type TestContext, testAttributes } from "../support/context";
import { createFakeEmbedder, type FakeEmbedder } from "../support/embedder";

let t: TestContext;
let embedder: FakeEmbedder;
let counter = 0;

beforeAll(async () => {
  embedder = createFakeEmbedder({ dimension: 64 });
  t = await openTestContext({ attributes: testAttributes, embedder });
});

afterAll(() => t.close());

const newScope = () => `vs-${++counter}`;

const put = (scope: string, value: string, at: string, attribute = "city", entity = "Budi") =>
  remember(t.ctx, {
    scope,
    source: { content: `${entity} ${attribute} ${value}`, received_at: at },
    facts: [{ entity, attribute, value, quote: `${attribute} ${value}` }],
  } satisfies RememberInput);

interface Row {
  ref: RecordId;
  valid_to?: DateTime;
}

const rows = async (kind: "fvec" | "evec", scope: string): Promise<Row[]> => {
  const [r] = await t.ctx.db
    .query<[Row[]]>("SELECT * FROM type::table($table)", { table: partitionTable(kind, scope) })
    .collect();
  return r ?? [];
};

const count = async (table: string, scope: string) => {
  const [r] = await t.ctx.db
    .query<[unknown[]]>(`SELECT id FROM ${table} WHERE scope = $scope`, { scope })
    .collect();
  return r?.length ?? 0;
};

test("remember menulis satu vektor per fakta baru dan per entitas baru, dalam satu batch", async () => {
  const scope = newScope();
  embedder.calls.length = 0;
  const result = await remember(t.ctx, {
    scope,
    source: {
      content: "Budi tinggal di Bandung. Budi bekerja di Acme.",
      received_at: "2025-01-01",
    },
    facts: [
      { entity: "Budi", attribute: "city", value: "Bandung", quote: "tinggal di Bandung" },
      { entity: "Budi", attribute: "works_for", value: "Acme", quote: "bekerja di Acme" },
    ],
  });
  expect(result.ok).toBe(true);

  expect(embedder.calls).toHaveLength(1);
  expect(embedder.calls[0]?.kind).toBe("document");
  // 2 teks fakta + 2 nama entitas baru (Budi, Acme).
  expect(embedder.calls[0]?.texts).toHaveLength(4);
  expect(embedder.calls[0]?.texts[0]).toBe("Budi · kota tinggal: Bandung — tinggal di Bandung");

  expect(await rows("fvec", scope)).toHaveLength(2);
  expect(await rows("evec", scope)).toHaveLength(2);
});

test("nilai baru menutup vektor fakta lama; pernyataan ulang tidak menambah vektor", async () => {
  const scope = newScope();
  await put(scope, "Bandung", "2025-01-01");
  await put(scope, "Bandung", "2025-02-01");
  expect(await rows("fvec", scope)).toHaveLength(1);

  await put(scope, "Medan", "2025-03-01");
  const after = await rows("fvec", scope);
  expect(after).toHaveLength(2);
  expect(after.filter((r) => r.valid_to)).toHaveLength(1);
  expect(await count("fact", scope)).toBe(2);
});

test("retractFact menutup vektor fakta yang dicabut", async () => {
  const scope = newScope();
  const result = await put(scope, "catur", "2025-01-01", "hobby");
  if (!result.ok) throw new Error("seharusnya ok");
  const [first] = result.results;
  if (!first?.ok) throw new Error("seharusnya ok");
  const entity = await t.ctx.db
    .query<[{ id: RecordId }[]]>("SELECT id FROM entity WHERE scope = $scope", { scope })
    .collect()
    .then(([r]) => r?.[0]?.id as RecordId);

  await retractFact(t.ctx, { scope, entity, attribute: "hobby", at: new Date("2025-02-01") });
  const after = await rows("fvec", scope);
  expect(after).toHaveLength(1);
  expect(after[0]?.valid_to).toBeDefined();
});

test("embedder gagal: tidak ada yang tertulis, error dilempar", async () => {
  const scope = newScope();
  embedder.failNext(new Error("jaringan putus"));
  await expect(put(scope, "Bandung", "2025-01-01")).rejects.toMatchObject({ code: "embedder" });
  expect(await count("source", scope)).toBe(0);
  expect(await count("entity", scope)).toBe(0);
  expect(await count("fact", scope)).toBe(0);
});

test("embedder mengembalikan hasil tidak valid: tidak ada yang tertulis", async () => {
  const scope = newScope();
  embedder.returnNext([[1, 2, 3]]);
  await expect(put(scope, "Bandung", "2025-01-01")).rejects.toMatchObject({ code: "embedder" });
  expect(await count("source", scope)).toBe(0);
  expect(await count("fact", scope)).toBe(0);
});

test("entitas yang sudah ada tidak di-embed ulang", async () => {
  const scope = newScope();
  await put(scope, "Bandung", "2025-01-01");
  embedder.calls.length = 0;
  await put(scope, "Medan", "2025-02-01");
  // Hanya teks fakta yang di-embed; "Budi" sudah punya vektor.
  expect(embedder.calls[0]?.texts).toHaveLength(1);
  expect(await rows("evec", scope)).toHaveLength(1);
});

test("createEntity dengan embedding menulis entitas dan vektornya bersama-sama", async () => {
  const scope = newScope();
  const id = await createEntity(t.ctx, {
    scope,
    name: "Siti",
    kind: "person",
    embedding: new Array<number>(64).fill(0.1),
  });
  const evec = await rows("evec", scope);
  expect(evec.map((r) => r.ref.toString())).toEqual([id.toString()]);
});
