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
