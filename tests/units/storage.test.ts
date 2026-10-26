import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal } from "surrealdb";
import { MemoryError } from "../../src/core/errors";
import { loadNodeEngines, normalizeUrl, openStorage } from "../../src/core/storage";

test("normalizeUrl: path relatif tetap relatif", () => {
  expect(normalizeUrl("rocksdb://./data/x")).toBe("rocksdb://data/x");
  expect(normalizeUrl("surrealkv://data/x")).toBe("surrealkv://data/x");
});

test("normalizeUrl: path absolut di bawah cwd menjadi relatif", () => {
  expect(normalizeUrl(`rocksdb://${resolve("data", "x")}`)).toBe("rocksdb://data/x");
});

test("normalizeUrl: path di luar cwd memakai ..", () => {
  expect(normalizeUrl("rocksdb://../x")).toBe("rocksdb://../x");
});

test("normalizeUrl: cwd sendiri menjadi .", () => {
  expect(normalizeUrl("rocksdb://.")).toBe("rocksdb://.");
});

test.each(["mem://", "ws://localhost:8000", "http://db.example.com"])(
  "normalizeUrl: %s tidak diubah",
  (url) => {
    expect(normalizeUrl(url)).toBe(url);
  },
);

test.skipIf(process.platform !== "win32")("normalizeUrl: beda drive ditolak", () => {
  const otherDrive = process.cwd().toUpperCase().startsWith("Z:") ? "Y:/x" : "Z:/x";
  expect(() => normalizeUrl(`rocksdb://${otherDrive}`)).toThrow(MemoryError);
});

test("openStorage lewat url membuka koneksi dan close() menutupnya", async () => {
  const storage = await openStorage({ url: "mem://", namespace: "ns", database: "db" });
  const [one] = await storage.db.query<[number]>("RETURN 1").collect();
  expect(one).toBe(1);
  await storage.close();
});

test("openStorage menutup koneksi dan melempar error asli bila setup gagal", async () => {
  const close = spyOn(Surreal.prototype, "close");
  try {
    await expect(
      openStorage({ url: "mem://", namespace: "bad name;", database: "db" }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
});

test("openStorage tetap melempar error asli walau close() juga gagal", async () => {
  const close = spyOn(Surreal.prototype, "close").mockRejectedValueOnce(new Error("close gagal"));
  try {
    const error = await openStorage({
      url: "mem://",
      namespace: "bad name;",
      database: "db",
    }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("close gagal");
  } finally {
    close.mockRestore();
  }
});

test("openStorage lewat db: session terpisah dan close() tidak menutup koneksi aplikasi", async () => {
  const host = new Surreal({ engines: createNodeEngines() });
  await host.connect("mem://");
  await host.use({ namespace: "host_ns", database: "host_db" });
  await host.query("CREATE marker:one SET v = 1");

  const storage = await openStorage({ db: host, namespace: "lib_ns", database: "lib_db" });
  await storage.db.query("CREATE marker:two SET v = 2");
  await storage.close();

  // Namespace aplikasi tidak berubah dan koneksinya masih hidup.
  const [hostRows] = await host.query<[{ id: unknown }[]]>("SELECT id FROM marker").collect();
  expect(hostRows).toHaveLength(1);
  await host.close();
});

test("loadNodeEngines: pesan jelas bila paket embedded tidak terpasang", async () => {
  const error = await loadNodeEngines(async () => {
    throw new Error("Cannot find package '@surrealdb/node'");
  }).catch((e) => e);
  expect(error).toBeInstanceOf(MemoryError);
  expect(error.code).toBe("storage");
  expect(error.message).toContain("@surrealdb/node");
  expect(error.message).toContain("ws://");
  expect(error.details.cause).toContain("Cannot find package");
});

test("loadNodeEngines: mengembalikan engine bila paket ada", async () => {
  const engines = await loadNodeEngines();
  expect(Object.keys(engines)).toEqual(expect.arrayContaining(["mem", "rocksdb"]));
});
