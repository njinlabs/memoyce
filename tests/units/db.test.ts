import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Surreal } from "surrealdb";
import { env, loadConfig } from "../../src/core/config";
import { connectDb, db, rocksdbUrl } from "../../src/core/db";

test("rocksdbUrl: path relatif tetap relatif", () => {
  expect(rocksdbUrl("./data/x")).toBe("rocksdb://data/x");
});

test("rocksdbUrl: path absolut di bawah cwd diubah menjadi relatif", () => {
  expect(rocksdbUrl(resolve("data", "x"))).toBe("rocksdb://data/x");
});

test("rocksdbUrl: path di luar cwd memakai ..", () => {
  expect(rocksdbUrl("../x")).toBe("rocksdb://../x");
});

test("rocksdbUrl: cwd sendiri menjadi .", () => {
  expect(rocksdbUrl(".")).toBe("rocksdb://.");
});

test.skipIf(process.platform !== "win32")("rocksdbUrl: beda drive ditolak", () => {
  const otherDrive = process.cwd().toUpperCase().startsWith("Z:") ? "Y:/x" : "Z:/x";
  expect(() => rocksdbUrl(otherDrive)).toThrow("satu drive");
});

const dir = resolve("data", `test-db-${crypto.randomUUID()}`);

afterEach(async () => {
  await db?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

test("connectDb menulis ke path absolut yang diminta, bukan ./C/...", async () => {
  process.env.SURREAL_PATH = dir;
  await loadConfig();
  await connectDb();
  const [rows] = await db.query<[number]>("RETURN 1").collect();
  expect(rows).toBe(1);
  expect(existsSync(dir)).toBe(true);
});

test("connectDb menutup koneksi dan melempar ulang bila setup gagal", async () => {
  process.env.SURREAL_PATH = dir;
  await loadConfig();
  env.SURREAL_NAMESPACE = "bad name;";
  await expect(connectDb()).rejects.toThrow();
  env.SURREAL_NAMESPACE = "agent";
});

test("connectDb tetap melempar error asli walau close() juga gagal", async () => {
  process.env.SURREAL_PATH = dir;
  await loadConfig();
  env.SURREAL_NAMESPACE = "bad name;";
  const close = spyOn(Surreal.prototype, "close").mockRejectedValueOnce(new Error("close gagal"));
  try {
    const error = await connectDb().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("close gagal");
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    env.SURREAL_NAMESPACE = "agent";
  }
});
