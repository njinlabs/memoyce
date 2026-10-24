import { expect, test } from "bun:test";
import { MemoryError } from "../../src/core/errors";
import { normalizeName, parseOptions } from "../../src/core/options";

const fakeDb = { query: () => {} };

test("default terisi untuk opsi minimal", () => {
  const o = parseOptions({ storage: { url: "mem://" } });
  expect(o).toMatchObject({
    storage: { url: "mem://", namespace: "agent", database: "memory" },
    attributes: [],
    vocabulary: "strict",
    migrate: "auto",
  });
});

test("atribut mendapat default tipe, kardinalitas, alias", () => {
  const o = parseOptions({
    storage: { url: "mem://" },
    attributes: [{ key: "city", description: "kota" }],
  });
  expect(o.attributes[0]).toEqual({
    key: "city",
    description: "kota",
    type: "string",
    cardinality: "single",
    aliases: [],
  });
});

test("storage.db diterima sebagai alternatif url", () => {
  const o = parseOptions({ storage: { db: fakeDb, namespace: "ns" } });
  expect("db" in o.storage).toBe(true);
});

test.each([
  ["tanpa url maupun db", { storage: {} }],
  ["url dan db sekaligus kosong string", { storage: { url: "" } }],
  ["db bukan koneksi", { storage: { db: {} } }],
  ["namespace tidak valid", { storage: { url: "mem://", namespace: "bad name;" } }],
  ["vocabulary tidak dikenal", { storage: { url: "mem://" }, vocabulary: "loose" }],
  [
    "key atribut tidak valid",
    { storage: { url: "mem://" }, attributes: [{ key: "Bad Key", description: "x" }] },
  ],
  [
    "alias ganda antar atribut",
    {
      storage: { url: "mem://" },
      attributes: [
        { key: "a", description: "x", aliases: ["same"] },
        { key: "b", description: "x", aliases: ["Same"] },
      ],
    },
  ],
  [
    "alias sama dengan key lain",
    {
      storage: { url: "mem://" },
      attributes: [
        { key: "a", description: "x" },
        { key: "b", description: "x", aliases: ["a"] },
      ],
    },
  ],
  ["bukan objek", "x"],
])("menolak opsi tidak valid: %s", (_name, input) => {
  try {
    parseOptions(input);
    throw new Error("seharusnya melempar");
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).code).toBe("invalid_options");
    expect((error as MemoryError).details.issues).toBeDefined();
  }
});

test("normalizeName: huruf kecil, spasi dan strip menjadi underscore", () => {
  expect(normalizeName("  Works At ")).toBe("works_at");
  expect(normalizeName("Is-VIP")).toBe("is_vip");
});
