import { expect, spyOn, test } from "bun:test";
import { Surreal } from "surrealdb";
import { createContext } from "../../src/core/context";
import { MemoryError } from "../../src/core/errors";
import { createMemory, MemoryError as PublicMemoryError } from "../../src/index";

test("createContext menolak opsi tidak valid dengan MemoryError", async () => {
  await expect(createContext({ storage: {} } as never)).rejects.toMatchObject({
    code: "invalid_options",
  });
});

test("createContext: migrate check pada database baru gagal dan koneksi ditutup", async () => {
  const close = spyOn(Surreal.prototype, "close");
  try {
    await expect(
      createContext({ storage: { url: "mem://" }, migrate: "check" }),
    ).rejects.toMatchObject({ code: "migration" });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
});

test("createContext: kegagalan close() tidak menutupi error aslinya", async () => {
  const close = spyOn(Surreal.prototype, "close").mockRejectedValueOnce(new Error("close gagal"));
  try {
    const error = await createContext({ storage: { url: "mem://" }, migrate: "check" }).catch(
      (e: unknown) => e,
    );
    expect((error as MemoryError).code).toBe("migration");
  } finally {
    close.mockRestore();
  }
});

test("migrate off: skema dan registri atribut tidak disentuh", async () => {
  const { ctx, close } = await createContext({
    storage: { url: "mem://" },
    migrate: "off",
    attributes: [{ key: "city", description: "kota" }],
  });
  try {
    const [info] = await ctx.db
      .query<[{ tables: Record<string, string> }]>("INFO FOR DB")
      .collect();
    expect(Object.keys(info?.tables ?? {})).toEqual([]);
  } finally {
    await close();
  }
});

test("createContext: registri mengikuti mode vocabulary", async () => {
  const { ctx, close } = await createContext({
    storage: { url: "mem://" },
    vocabulary: "open",
    attributes: [{ key: "city", description: "kota" }],
  });
  try {
    expect(ctx.registry.vocabulary).toBe("open");
    expect(ctx.registry.resolve("warna").key).toBe("warna");
  } finally {
    await close();
  }
});

test("createMemory: instance independen dan close()", async () => {
  const a = await createMemory({ storage: { url: "mem://" } });
  const b = await createMemory({ storage: { url: "mem://" } });
  await a.close();
  await b.close();
});

test("createMemory: opsi tidak valid melempar MemoryError yang diekspor publik", async () => {
  const error = await createMemory({ storage: {} } as never).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PublicMemoryError);
  expect(PublicMemoryError).toBe(MemoryError);
});
