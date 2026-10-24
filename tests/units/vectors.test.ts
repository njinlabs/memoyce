import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createVectorStore, partitionDdl, partitionTable } from "../../src/core/vectors";
import { openTestContext, type TestContext } from "../support/context";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

const tableNames = async (): Promise<string[]> => {
  const [info] = await t.ctx.db
    .query<[{ tables: Record<string, string> }]>("INFO FOR DB")
    .collect();
  return Object.keys(info?.tables ?? {});
};

test("partitionTable: deterministik, berbeda per scope dan jenis, aman sebagai nama tabel", () => {
  const a = partitionTable("fvec", "org:1/lead:7");
  expect(a).toMatch(/^fvec_[0-9a-f]{16}$/);
  expect(partitionTable("fvec", "org:1/lead:7")).toBe(a);
  expect(partitionTable("fvec", "org:2")).not.toBe(a);
  expect(partitionTable("evec", "org:1/lead:7")).toMatch(/^evec_[0-9a-f]{16}$/);
  expect(partitionTable("evec", "org:1/lead:7").slice(5)).toBe(a.slice(5));
});

test("partitionDdl: HNSW dengan dimensi yang diminta; fvec punya kolom validitas, evec tidak", () => {
  const fvec = partitionDdl("fvec", "fvec_x", 384);
  expect(fvec).toContain("DIMENSION 384");
  expect(fvec).toContain("record<fact>");
  expect(fvec).toContain("valid_to");
  const evec = partitionDdl("evec", "evec_x", 8);
  expect(evec).toContain("record<entity>");
  expect(evec).not.toContain("valid_to");
});

test("ensure: membuat partisi sekali, idempoten, dan reset melupakan cache", async () => {
  const store = createVectorStore(t.ctx.db, 8);
  expect(store.dimension).toBe(8);

  const table = await store.ensure("fvec", "scope-ensure");
  expect(table).toBe(partitionTable("fvec", "scope-ensure"));
  expect(await tableNames()).toContain(table);

  const query = spyOn(t.ctx.db, "query");
  try {
    expect(await store.ensure("fvec", "scope-ensure")).toBe(table);
    expect(query).not.toHaveBeenCalled();

    store.reset();
    await store.ensure("fvec", "scope-ensure");
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore();
  }
});

test("ensure: panggilan bersamaan berbagi satu pembuatan", async () => {
  const store = createVectorStore(t.ctx.db, 8);
  const query = spyOn(t.ctx.db, "query");
  try {
    await Promise.all([
      store.ensure("evec", "scope-parallel"),
      store.ensure("evec", "scope-parallel"),
      store.ensure("evec", "scope-parallel"),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore();
  }
});

test("ensure: kegagalan tidak di-cache, percobaan berikutnya mencoba lagi", async () => {
  const store = createVectorStore(t.ctx.db, 8);
  const original = t.ctx.db.query.bind(t.ctx.db);
  let calls = 0;
  const query = spyOn(t.ctx.db, "query").mockImplementation(((
    ...args: Parameters<typeof original>
  ) => {
    calls++;
    if (calls === 1) throw new Error("gagal sesaat");
    return original(...args);
  }) as never);
  try {
    await expect(store.ensure("fvec", "scope-retry")).rejects.toThrow("gagal sesaat");
    const table = await store.ensure("fvec", "scope-retry");
    expect(await tableNames()).toContain(table);
  } finally {
    query.mockRestore();
  }
});
