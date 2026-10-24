import { afterAll, beforeAll, expect, test } from "bun:test";
import { type DateTime, RecordId } from "surrealdb";
import type { MemoryError } from "../../src/core/errors";
import { assertFact, factsAt, retractFact } from "../../src/core/fact";
import { createEntity, createSource } from "../../src/core/records";
import { openTestContext, type TestContext } from "../support/context";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

const d = (s: string) => new Date(s);
const S = "s1";

const person = (name: string, scope = S) => createEntity(t.ctx, { scope, name, kind: "person" });
const text = (content: string, scope = S) => createSource(t.ctx, { scope, content });

const values = async (entity: RecordId, at: string, scope = S) =>
  (await factsAt(t.ctx, { scope, entity, at: d(at) })).map((f) => f.value);

const allRows = async (entity: RecordId) => {
  const [rows] = await t.ctx.db
    .query<[{ value: unknown; valid_to?: DateTime }[]]>(
      "SELECT * FROM fact WHERE entity = $entity ORDER BY valid_from",
      { entity },
    )
    .collect();
  return rows ?? [];
};

const failure = async (promise: Promise<unknown>): Promise<MemoryError> => {
  try {
    await promise;
  } catch (error) {
    return error as MemoryError;
  }
  throw new Error("seharusnya melempar");
};

test("update menutup fakta lama, tidak menghapus, dan mendukung query as-of", async () => {
  const budi = await person("Budi");
  const s1 = await text("Budi kerja di Acme");
  const s2 = await text("Budi pindah ke Globex");
  const assert = (value: string, source: RecordId, at: string) =>
    assertFact(t.ctx, { scope: S, entity: budi, attribute: "employer", value, source, at: d(at) });

  const a = await assert("Acme", s1, "2024-01-01");
  expect(a.status).toBe("created");

  const same = await assert("Acme", s2, "2024-03-01");
  expect(same.status).toBe("unchanged");
  expect(same.id.toString()).toBe(a.id.toString());

  expect((await assert("Globex", s2, "2025-01-01")).status).toBe("updated");

  expect(await allRows(budi)).toHaveLength(2);
  expect(await values(budi, "2024-06-01")).toEqual(["Acme"]);
  expect(await values(budi, "2025-06-01")).toEqual(["Globex"]);
  expect(await values(budi, "2023-01-01")).toEqual([]);
});

test("alias atribut menjadi key kanonik", async () => {
  const e = await person("Alias");
  const s = await text("Alias kerja di Acme");
  await assertFact(t.ctx, {
    scope: S,
    entity: e,
    attribute: "Works At",
    value: "Acme",
    source: s,
    at: d("2025-01-01"),
  });
  const [fact] = await factsAt(t.ctx, { scope: S, entity: e, at: d("2025-02-01") });
  expect(fact?.attribute).toBe("employer");
});

test("atribut tak dikenal ditolak (strict) dan tidak menulis apa pun", async () => {
  const e = await person("Strict");
  const s = await text("x");
  const error = await failure(
    assertFact(t.ctx, { scope: S, entity: e, attribute: "employe", value: "A", source: s }),
  );
  expect(error.code).toBe("unknown_attribute");
  expect(error.details.suggestions).toEqual(["employer"]);
  expect(await allRows(e)).toHaveLength(0);
});

test("nilai bertipe salah ditolak", async () => {
  const e = await person("Tipe");
  const s = await text("x");
  const error = await failure(
    assertFact(t.ctx, { scope: S, entity: e, attribute: "age", value: "30", source: s }),
  );
  expect(error.code).toBe("invalid_value");
});

test("source yang tidak ada atau entity yang tidak ada ditolak, tanpa efek samping", async () => {
  const e = await person("Siti");
  const s = await text("x");
  const noSource = await failure(
    assertFact(t.ctx, {
      scope: S,
      entity: e,
      attribute: "city",
      value: "Bandung",
      source: new RecordId("source", "tidak-ada"),
    }),
  );
  expect(noSource.code).toBe("not_found");
  expect(noSource.details.what).toBe("source");
  expect(await allRows(e)).toHaveLength(0);

  const noEntity = await failure(
    assertFact(t.ctx, {
      scope: S,
      entity: new RecordId("entity", "tidak-ada"),
      attribute: "city",
      value: "Bandung",
      source: s,
    }),
  );
  expect(noEntity.code).toBe("not_found");
  expect(noEntity.details.what).toBe("entity");
});

test("source atau entity dari scope lain ditolak", async () => {
  const mine = await person("Mine");
  const foreignSource = await text("x", "lain");
  const foreignEntity = await person("Foreign", "lain");
  const mySource = await text("x");

  const a = await failure(
    assertFact(t.ctx, {
      scope: S,
      entity: mine,
      attribute: "city",
      value: "A",
      source: foreignSource,
    }),
  );
  expect([a.code, a.details.what]).toEqual(["scope_mismatch", "source"]);

  const b = await failure(
    assertFact(t.ctx, {
      scope: S,
      entity: foreignEntity,
      attribute: "city",
      value: "A",
      source: mySource,
    }),
  );
  expect([b.code, b.details.what]).toEqual(["scope_mismatch", "entity"]);
});

test("waktu mundur dari fakta berlaku ditolak dan tidak mengubah data", async () => {
  const e = await person("Rina");
  const s = await text("Rina di Jakarta");
  const assert = (value: string, at: string) =>
    assertFact(t.ctx, { scope: S, entity: e, attribute: "city", value, source: s, at: d(at) });
  await assert("Jakarta", "2025-01-01");
  const error = await failure(assert("Medan", "2024-01-01"));
  expect(error.code).toBe("stale_time");
  expect(await values(e, "2025-06-01")).toEqual(["Jakarta"]);
});

test("atribut berbeda tidak saling menutup", async () => {
  const e = await person("Dewi");
  const s = await text("Dewi di Bali, usia 30");
  const at = d("2025-01-01");
  await assertFact(t.ctx, { scope: S, entity: e, attribute: "city", value: "Bali", source: s, at });
  await assertFact(t.ctx, { scope: S, entity: e, attribute: "age", value: 30, source: s, at });
  expect(await values(e, "2025-02-01")).toEqual(expect.arrayContaining(["Bali", 30]));
});

test("nilai objek dan tanggal dibandingkan secara struktural", async () => {
  const e = await person("Toko");
  const s = await text("profil toko");
  const value = { jalan: "Merdeka", no: 1, tags: ["a", "b"] };
  const put = (v: unknown, at: string) =>
    assertFact(t.ctx, {
      scope: S,
      entity: e,
      attribute: "profile",
      value: v,
      source: s,
      at: d(at),
    });

  const first = await put(value, "2025-01-01");
  const again = await put({ ...value, tags: [...value.tags] }, "2025-02-01");
  expect(again).toEqual({ status: "unchanged", id: first.id });
  expect((await put({ ...value, no: 2 }, "2025-03-01")).status).toBe("updated");

  const bday = d("1990-05-05");
  const putDate = (v: Date, at: string) =>
    assertFact(t.ctx, {
      scope: S,
      entity: e,
      attribute: "birthday",
      value: v,
      source: s,
      at: d(at),
    });
  await putDate(bday, "2025-01-01");
  expect((await putDate(new Date(bday), "2025-02-01")).status).toBe("unchanged");
});

test("tanpa `at` memakai waktu sekarang; factsAt default juga sekarang", async () => {
  const e = await person("Eko");
  const s = await text("Eko di Solo");
  const before = Date.now();
  await assertFact(t.ctx, { scope: S, entity: e, attribute: "city", value: "Solo", source: s });
  const [fact] = await factsAt(t.ctx, { scope: S, entity: e });
  expect(fact?.value).toBe("Solo");
  expect(fact?.valid_from.toDate().getTime()).toBeGreaterThanOrEqual(before - 1000);
});

test("atribut multi: nilai bertambah, tidak saling menutup, pernyataan ulang unchanged", async () => {
  const e = await person("Hobi");
  const s = await text("hobi");
  const put = (value: string, at: string) =>
    assertFact(t.ctx, { scope: S, entity: e, attribute: "hobby", value, source: s, at: d(at) });

  expect((await put("catur", "2025-01-01")).status).toBe("created");
  expect((await put("renang", "2025-02-01")).status).toBe("created");
  expect((await put("catur", "2025-03-01")).status).toBe("unchanged");
  // Menyisipkan nilai multi lebih awal dari nilai lain tidak dianggap waktu mundur.
  expect((await put("lari", "2024-12-01")).status).toBe("created");
  expect((await values(e, "2025-06-01")).sort()).toEqual(["catur", "lari", "renang"]);
  expect(await allRows(e)).toHaveLength(3);
});

test("retractFact: menutup satu nilai multi, riwayat tetap ada", async () => {
  const e = await person("Retract");
  const s = await text("hobi");
  const put = (value: string) =>
    assertFact(t.ctx, {
      scope: S,
      entity: e,
      attribute: "hobby",
      value,
      source: s,
      at: d("2025-01-01"),
    });
  await put("catur");
  await put("renang");

  const closed = await retractFact(t.ctx, {
    scope: S,
    entity: e,
    attribute: "hobby",
    value: "catur",
    at: d("2025-03-01"),
  });
  expect(closed).toBe(1);
  expect(await values(e, "2025-02-01")).toEqual(expect.arrayContaining(["catur", "renang"]));
  expect(await values(e, "2025-04-01")).toEqual(["renang"]);
  expect(await allRows(e)).toHaveLength(2);
});

test("retractFact tanpa value menutup semua nilai atribut itu", async () => {
  const e = await person("RetractAll");
  const s = await text("kota");
  await assertFact(t.ctx, {
    scope: S,
    entity: e,
    attribute: "city",
    value: "Bogor",
    source: s,
    at: d("2025-01-01"),
  });
  expect(
    await retractFact(t.ctx, { scope: S, entity: e, attribute: "kota", at: d("2025-02-01") }),
  ).toBe(1);
  expect(await values(e, "2025-03-01")).toEqual([]);
  // Setelah ditutup, nilai baru dibuat sebagai fakta baru, bukan pembaruan.
  const again = await assertFact(t.ctx, {
    scope: S,
    entity: e,
    attribute: "city",
    value: "Depok",
    source: s,
    at: d("2025-04-01"),
  });
  expect(again.status).toBe("created");
});

test("retractFact: tidak ada yang cocok, nilai salah tipe, waktu mundur", async () => {
  const e = await person("RetractErr");
  const s = await text("x");
  const none = await failure(retractFact(t.ctx, { scope: S, entity: e, attribute: "city" }));
  expect(none.code).toBe("not_found");

  await assertFact(t.ctx, {
    scope: S,
    entity: e,
    attribute: "age",
    value: 30,
    source: s,
    at: d("2025-01-01"),
  });
  const badType = await failure(
    retractFact(t.ctx, { scope: S, entity: e, attribute: "age", value: "30" }),
  );
  expect(badType.code).toBe("invalid_value");

  const stale = await failure(
    retractFact(t.ctx, { scope: S, entity: e, attribute: "age", at: d("2024-01-01") }),
  );
  expect(stale.code).toBe("stale_time");
  expect(await values(e, "2025-06-01")).toEqual([30]);
});

test("retractFact tidak menyentuh scope lain", async () => {
  const mine = await person("Sama");
  const s = await text("x");
  await assertFact(t.ctx, {
    scope: S,
    entity: mine,
    attribute: "city",
    value: "Bogor",
    source: s,
    at: d("2025-01-01"),
  });
  const error = await failure(
    retractFact(t.ctx, { scope: "lain", entity: mine, attribute: "city", at: d("2025-02-01") }),
  );
  expect(error.code).toBe("not_found");
  expect(await values(mine, "2025-03-01")).toEqual(["Bogor"]);
});

test("nilai bertipe entity: referensi diperiksa keberadaan dan scope-nya", async () => {
  const budi = await person("Budi Ref");
  const acme = await createEntity(t.ctx, { scope: S, name: "Acme", kind: "organization" });
  const foreign = await createEntity(t.ctx, { scope: "lain", name: "Acme", kind: "organization" });
  const s = await text("Budi kerja di Acme");
  const put = (value: RecordId) =>
    assertFact(t.ctx, { scope: S, entity: budi, attribute: "works_for", value, source: s });

  expect((await failure(put(new RecordId("entity", "tidak-ada")))).details.what).toBe("value");
  expect((await failure(put(foreign))).code).toBe("scope_mismatch");
  expect((await put(acme)).status).toBe("created");

  const [fact] = await factsAt(t.ctx, { scope: S, entity: budi });
  expect((fact?.value as RecordId | undefined)?.toString()).toBe(acme.toString());
});

test("factsAt dibatasi scope; beberapa scope bisa dibaca sekaligus", async () => {
  const e = await person("Scoped");
  const s = await text("x");
  await assertFact(t.ctx, {
    scope: S,
    entity: e,
    attribute: "city",
    value: "Bogor",
    source: s,
    at: d("2025-01-01"),
  });
  const read = (scope: string | string[]) =>
    factsAt(t.ctx, { scope, entity: e, at: d("2025-02-01") }).then((f) => f.length);
  expect(await read(S)).toBe(1);
  expect(await read("lain")).toBe(0);
  expect(await read(["lain", S])).toBe(1);
});

test("galat tak dikenal dari DB diteruskan apa adanya", async () => {
  const e = await person("Galat");
  const s = await text("x");
  const spy = await failure(
    assertFact(t.ctx, {
      scope: S,
      entity: e,
      attribute: "profile",
      value: { a: 1 },
      source: s,
      at: new Date(Number.NaN),
    }),
  );
  expect(spy).toBeInstanceOf(Error);
  expect((spy as { code?: string }).code).not.toBe("not_found");
});
