import { afterAll, beforeAll, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { checkValue, createRegistry, syncAttributes } from "../../src/core/attributes";
import type { MemoryError } from "../../src/core/errors";
import { parseOptions } from "../../src/core/options";
import { openTestContext, type TestContext, testAttributes } from "../support/context";

const attrs = parseOptions({ storage: { url: "mem://" }, attributes: testAttributes }).attributes;
const strict = createRegistry(attrs, "strict");
const open = createRegistry(attrs, "open");

const catchError = (fn: () => unknown): MemoryError => {
  try {
    fn();
  } catch (error) {
    return error as MemoryError;
  }
  throw new Error("seharusnya melempar");
};

test("resolve: key, alias, dan normalisasi nama", () => {
  expect(strict.resolve("employer").key).toBe("employer");
  expect(strict.resolve("Works At").key).toBe("employer");
  expect(strict.resolve("COMPANY").key).toBe("employer");
  expect(strict.resolve("kota").key).toBe("city");
  expect(strict.all()).toHaveLength(attrs.length);
});

test("strict: atribut tak dikenal ditolak dengan saran terdekat", () => {
  const error = catchError(() => strict.resolve("employe"));
  expect(error.code).toBe("unknown_attribute");
  expect(error.details.suggestions).toEqual(["employer"]);
  expect(error.details.valid).toContain("city");
  expect(error.message).toContain("employer");
});

test("strict: saran dari substring alias, tanpa duplikat", () => {
  expect(catchError(() => strict.resolve("compan")).details.suggestions).toEqual(["employer"]);
});

test("strict: tanpa saran bila tidak ada yang mirip", () => {
  const error = catchError(() => strict.resolve("zzzzzzzz"));
  expect(error.details.suggestions).toEqual([]);
  expect(error.message).not.toContain("maksud Anda");
});

test("open: atribut tak dikenal diterima sebagai json bernilai tunggal", () => {
  expect(open.resolve("Favorite Color")).toMatchObject({
    key: "favorite_color",
    type: "json",
    cardinality: "single",
  });
  expect(open.resolve("employer").key).toBe("employer");
});

test("open: nama yang tidak bisa menjadi key tetap ditolak", () => {
  expect(catchError(() => open.resolve("1 buruk!")).code).toBe("unknown_attribute");
});

const attr = (key: string) => strict.resolve(key);
const entityId = new RecordId("entity", "x");

test.each([
  ["employer", "Acme"],
  ["age", 30],
  ["is_vip", false],
  ["birthday", new Date("1990-01-01")],
  ["works_for", entityId],
  ["profile", { a: 1 }],
  ["profile", [1, 2]],
  ["profile", 0],
])("checkValue menerima %s = %p", (key, value) => {
  expect(() => checkValue(attr(key), value)).not.toThrow();
});

test.each([
  ["employer", ""],
  ["employer", 1],
  ["age", "30"],
  ["age", Number.NaN],
  ["is_vip", "ya"],
  ["birthday", "1990-01-01"],
  ["birthday", new Date("bukan tanggal")],
  ["works_for", "entity:x"],
  ["works_for", new RecordId("source", "x")],
  ["profile", null],
  ["profile", undefined],
])("checkValue menolak %s = %p", (key, value) => {
  const error = catchError(() => checkValue(attr(key), value));
  expect(error.code).toBe("invalid_value");
  expect(error.details.attribute).toBe(key);
});

let t: TestContext;
beforeAll(async () => {
  t = await openTestContext();
});
afterAll(() => t.close());

test("syncAttributes: cermin konfigurasi, atribut lama ditandai tidak aktif", async () => {
  const read = async () => {
    const [rows] = await t.ctx.db
      .query<[{ id: RecordId; active: boolean; cardinality: string }[]]>(
        "SELECT id, active, cardinality FROM attribute ORDER BY id",
      )
      .collect();
    return Object.fromEntries((rows ?? []).map((r) => [String(r.id.id), r]));
  };

  const first = await read();
  expect(first.hobby).toMatchObject({ active: true, cardinality: "multi" });

  await syncAttributes(
    t.ctx.db,
    attrs.filter((a) => a.key !== "hobby"),
  );
  const second = await read();
  expect(second.hobby?.active).toBe(false);
  expect(second.employer?.active).toBe(true);

  await syncAttributes(t.ctx.db, attrs);
  expect((await read()).hobby?.active).toBe(true);
});

test("strict: beberapa saran diurutkan dari yang paling mirip", () => {
  const registry = createRegistry(
    parseOptions({
      storage: { url: "mem://" },
      attributes: [
        { key: "stage_one", description: "x" },
        { key: "stage_two_long", description: "x" },
      ],
    }).attributes,
    "strict",
  );
  expect(catchError(() => registry.resolve("stage")).details.suggestions).toEqual([
    "stage_one",
    "stage_two_long",
  ]);
});
