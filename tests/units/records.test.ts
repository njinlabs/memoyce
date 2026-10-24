import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DateTime, RecordId } from "surrealdb";
import { createEntity, createSource } from "../../src/core/records";
import { openTestContext, type TestContext } from "../support/context";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

test("createSource menyimpan scope, meta, dan received_at", async () => {
  const at = new Date("2024-05-05");
  const id = await createSource(t.ctx, {
    scope: "s",
    content: "halo",
    meta: { channel: "chat" },
    receivedAt: at,
  });
  const [row] = await t.ctx.db
    .query<[{ scope: string; meta: unknown; received_at: DateTime }]>(
      "SELECT scope, meta, received_at FROM ONLY $id",
      { id },
    )
    .collect();
  expect(row).toMatchObject({ scope: "s", meta: { channel: "chat" } });
  expect(row?.received_at.toDate()).toEqual(at);
});

test("createSource: received_at default sekarang, meta opsional", async () => {
  const before = Date.now();
  const id = await createSource(t.ctx, { scope: "s", content: "halo" });
  const [row] = await t.ctx.db
    .query<[{ meta?: unknown; received_at: DateTime }]>("SELECT meta, received_at FROM ONLY $id", {
      id,
    })
    .collect();
  expect(row?.meta).toBeUndefined();
  expect(row?.received_at.toDate().getTime()).toBeGreaterThanOrEqual(before - 1000);
});

test("createEntity: alias default kosong, alias tersimpan bila diberikan", async () => {
  const read = async (id: RecordId) => {
    const [row] = await t.ctx.db
      .query<[{ scope: string; name: string; kind: string; aliases: string[] }]>(
        "SELECT scope, name, kind, aliases FROM ONLY $id",
        { id },
      )
      .collect();
    return row;
  };
  const plain = await createEntity(t.ctx, { scope: "s", name: "Budi", kind: "person" });
  expect(await read(plain)).toEqual({ scope: "s", name: "Budi", kind: "person", aliases: [] });

  const aliased = await createEntity(t.ctx, {
    scope: "s",
    name: "Budi",
    kind: "person",
    aliases: ["Pak Budi"],
  });
  expect((await read(aliased))?.aliases).toEqual(["Pak Budi"]);
});
