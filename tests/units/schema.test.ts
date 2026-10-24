import { afterAll, beforeAll, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { createEntity, createSource } from "../../src/core/records";
import { openTestContext, type TestContext } from "../support/context";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

const now = new Date("2025-01-01");
const later = new Date("2025-06-01");

// Builder SDK bersifat thenable, bukan Promise, jadi `.rejects` perlu dibungkus.
const createFact = async (data: Record<string, unknown>): Promise<void> => {
  await t.ctx.db.create(new RecordId("fact", crypto.randomUUID())).content(data);
};

const base = async (scope = "s") => ({
  scope,
  entity: await createEntity(t.ctx, { scope, name: "A", kind: "person" }),
  attribute: "x",
  value: 1,
  valid_from: now,
  source: await createSource(t.ctx, { scope, content: "teks" }),
});

test("source: scope dan content kosong ditolak", async () => {
  await expect(createSource(t.ctx, { scope: "", content: "x" })).rejects.toThrow();
  await expect(createSource(t.ctx, { scope: "s", content: "" })).rejects.toThrow();
});

test("entity: scope dan nama kosong ditolak", async () => {
  await expect(createEntity(t.ctx, { scope: "", name: "A", kind: "person" })).rejects.toThrow();
  await expect(createEntity(t.ctx, { scope: "s", name: "", kind: "person" })).rejects.toThrow();
});

test("fact valid diterima", async () => {
  await createFact(await base());
});

test("fact: field wajib tidak boleh hilang", async () => {
  const full = await base();
  for (const key of ["scope", "entity", "source", "valid_from"] as const) {
    const { [key]: _omit, ...rest } = full;
    await expect(createFact(rest)).rejects.toThrow();
  }
});

test("fact: valid_to lebih awal dari valid_from ditolak", async () => {
  await expect(
    createFact({ ...(await base()), valid_from: later, valid_to: now }),
  ).rejects.toThrow();
});

test("fact: value NULL ditolak", async () => {
  await expect(createFact({ ...(await base()), value: null })).rejects.toThrow();
});

test("fact: field di luar skema ditolak (SCHEMAFULL)", async () => {
  await expect(createFact({ ...(await base()), liar: true })).rejects.toThrow();
});

test("fact: entity atau source dari scope lain ditolak di tingkat skema", async () => {
  const full = await base("s");
  const otherEntity = await createEntity(t.ctx, { scope: "lain", name: "B", kind: "person" });
  const otherSource = await createSource(t.ctx, { scope: "lain", content: "x" });
  await expect(createFact({ ...full, entity: otherEntity })).rejects.toThrow();
  await expect(createFact({ ...full, source: otherSource })).rejects.toThrow();
});
