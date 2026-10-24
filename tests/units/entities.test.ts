import { afterAll, beforeAll, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { entityKey, findEntities, getEntity } from "../../src/core/entities";
import { idToString, newId, parseId } from "../../src/core/ids";
import { createEntity } from "../../src/core/records";
import { contentTerms } from "../../src/core/text";
import { openTestContext, type TestContext } from "../support/context";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

test("entityKey: trim dan huruf kecil", () => {
  expect(entityKey("  Pak BUDI ")).toBe("pak budi");
});

test("keys dihitung DB dari nama dan alias, sama dengan entityKey", async () => {
  const id = await createEntity(t.ctx, {
    scope: "s",
    name: "  Pak Budi ",
    kind: "person",
    aliases: ["BUDI", " budi ", "Bu  Ani"],
  });
  const [row] = await t.ctx.db
    .query<[{ keys: string[] }]>("SELECT keys FROM ONLY $id", { id })
    .collect();
  expect(row?.keys).toEqual(["pak budi", "budi", "bu  ani"]);
  expect(row?.keys).toEqual([
    ...new Set(["  Pak Budi ", "BUDI", " budi ", "Bu  Ani"].map(entityKey)),
  ]);

  await t.ctx.db.query("UPDATE $id SET name = 'Budi Santoso'", { id }).collect();
  const [renamed] = await t.ctx.db
    .query<[{ keys: string[] }]>("SELECT keys FROM ONLY $id", { id })
    .collect();
  expect(renamed?.keys[0]).toBe("budi santoso");
});

test("findEntities: lewat nama atau alias, terbatas scope", async () => {
  const mine = await createEntity(t.ctx, {
    scope: "a",
    name: "Rina",
    kind: "person",
    aliases: ["Bu Rina"],
  });
  await createEntity(t.ctx, { scope: "b", name: "Rina", kind: "person" });

  expect((await findEntities(t.ctx, "a", "RINA")).map((e) => e.id.toString())).toEqual([
    mine.toString(),
  ]);
  expect(await findEntities(t.ctx, "a", " bu rina ")).toHaveLength(1);
  expect(await findEntities(t.ctx, "a", "tidak ada")).toEqual([]);
  expect(await findEntities(t.ctx, "c", "Rina")).toEqual([]);
});

test("getEntity: ada dan tidak ada", async () => {
  const id = await createEntity(t.ctx, { scope: "a", name: "Eko", kind: "person" });
  expect(await getEntity(t.ctx, id)).toMatchObject({ name: "Eko", kind: "person", scope: "a" });
  expect(await getEntity(t.ctx, new RecordId("entity", "tidak-ada"))).toBeUndefined();
});

test("ids: bolak-balik, tanpa tanda minus, bentuk salah ditolak", () => {
  expect(newId()).toMatch(/^[0-9a-f]{32}$/);
  const id = new RecordId("entity", newId());
  expect(parseId("entity", idToString(id))?.toString()).toBe(id.toString());
  expect(idToString(id)).toStartWith("entity:");

  expect(parseId("entity", "source:abc")).toBeUndefined();
  expect(parseId("entity", "abc")).toBeUndefined();
  expect(parseId("entity", "entity:")).toBeUndefined();
});

test("contentTerms: membuang kata tanya, tetap memakai semua kata bila semuanya kata umum", () => {
  expect(contentTerms("Apa  budget PT Maju sekarang?")).toEqual(["budget", "pt", "maju"]);
  expect(contentTerms("what is the")).toEqual(["what", "is", "the"]);
  expect(contentTerms("Café CAFÉ")).toEqual(["cafe"]);
});
