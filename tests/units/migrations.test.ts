import { afterEach, beforeEach, expect, test } from "bun:test";
import { MemoryError } from "../../src/core/errors";
import { currentVersion, latestVersion, migrate, migrations } from "../../src/core/migrations";
import { openStorage, type Storage } from "../../src/core/storage";

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage({ url: "mem://", namespace: "ns", database: "db" });
});

afterEach(async () => {
  await storage.close();
});

const tableNames = async (): Promise<string[]> => {
  const [info] = await storage.db
    .query<[{ tables: Record<string, string> }]>("INFO FOR DB")
    .collect();
  return Object.keys(info?.tables ?? {});
};

test("database baru berversi 0, auto memigrasi ke versi terbaru", async () => {
  expect(await currentVersion(storage.db)).toBe(0);
  await migrate(storage.db, "auto");
  expect(await currentVersion(storage.db)).toBe(latestVersion());
  expect(await tableNames()).toEqual(
    expect.arrayContaining(["source", "entity", "attribute", "fact", "meta"]),
  );
});

test("migrate idempoten", async () => {
  await migrate(storage.db, "auto");
  await migrate(storage.db, "auto");
  expect(await currentVersion(storage.db)).toBe(latestVersion());
});

test("check: gagal bila database belum dimigrasi, lolos setelahnya", async () => {
  await expect(migrate(storage.db, "check")).rejects.toMatchObject({ code: "migration" });
  await migrate(storage.db, "auto");
  await migrate(storage.db, "check");
});

test("off: tidak menyentuh database", async () => {
  await migrate(storage.db, "off");
  expect(await tableNames()).not.toContain("fact");
});

test("database lebih baru dari library ditolak", async () => {
  await migrate(storage.db, "auto");
  await storage.db.query("UPSERT meta:schema SET version = 999");
  const error = await migrate(storage.db, "auto").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MemoryError);
  expect((error as MemoryError).code).toBe("migration");
  expect((error as MemoryError).message).toContain("lebih baru");
});

test("migrasi baru dijalankan berurutan tanpa menyentuh data lama", async () => {
  await migrate(storage.db, "auto");
  await storage.db.query("CREATE source:s1 SET scope = 'a', content = 'x'");
  const next = latestVersion() + 1;
  migrations.push({ version: next, up: "DEFINE TABLE IF NOT EXISTS extra SCHEMALESS;" });
  try {
    await migrate(storage.db, "auto");
    expect(await currentVersion(storage.db)).toBe(next);
    expect(await tableNames()).toContain("extra");
    const [rows] = await storage.db.query<[unknown[]]>("SELECT * FROM source").collect();
    expect(rows).toHaveLength(1);
  } finally {
    migrations.pop();
  }
});

test("migrasi yang gagal dibatalkan seluruhnya dan versi tidak naik", async () => {
  await migrate(storage.db, "auto");
  const before = latestVersion();
  migrations.push({
    version: before + 1,
    up: 'DEFINE TABLE IF NOT EXISTS half SCHEMALESS; THROW "rusak";',
  });
  try {
    const error = await migrate(storage.db, "auto").catch((e: unknown) => e);
    expect((error as MemoryError).code).toBe("migration");
    expect((error as MemoryError).details.version).toBe(before + 1);
  } finally {
    migrations.pop();
  }
  expect(await currentVersion(storage.db)).toBe(before);
  expect(await tableNames()).not.toContain("half");
});

test("v1 -> v2: keys terisi untuk entitas lama, kolom quote ada, index lama diganti", async () => {
  const [v1] = migrations;
  if (!v1) throw new Error("migrasi v1 hilang");
  await storage.db.query(`BEGIN; ${v1.up} UPSERT meta:schema SET version = 1; COMMIT;`);
  await storage.db.query(
    "CREATE entity:lama SET scope = 's', name = '  Pak Budi', kind = 'person', aliases = ['BUDI']",
  );
  await migrate(storage.db, "auto");

  const [row] = await storage.db
    .query<[{ keys: string[] }]>("SELECT keys FROM ONLY entity:lama")
    .collect();
  expect(row?.keys).toEqual(["pak budi", "budi"]);

  await storage.db.query(
    "CREATE source:s1 SET scope = 's', content = 'x'; CREATE fact SET scope = 's', entity = entity:lama, attribute = 'a', value = 1, valid_from = time::now(), source = source:s1, quote = 'x'",
  );
  const [info] = await storage.db
    .query<[{ tables: Record<string, string> }]>("INFO FOR TABLE entity")
    .collect();
  const indexes = Object.keys((info as unknown as { indexes: Record<string, string> }).indexes);
  expect(indexes).toContain("entity_scope_keys");
  expect(indexes).not.toContain("entity_scope_name");
});
