import { expect, test } from "bun:test";
import { type Embedder, embedTexts } from "../../src/core/embedder";
import type { MemoryError } from "../../src/core/errors";
import { parseOptions } from "../../src/core/options";
import { createFakeEmbedder } from "../support/embedder";

const failure = async (promise: Promise<unknown>): Promise<MemoryError> => {
  try {
    await promise;
  } catch (error) {
    return error as MemoryError;
  }
  throw new Error("seharusnya melempar");
};

test("opsi embedder valid diterima, tidak valid ditolak", () => {
  const ok = parseOptions({ storage: { url: "mem://" }, embedder: createFakeEmbedder() });
  expect(ok.embedder?.model).toBe("fake-bow");

  const embed = async () => [];
  for (const bad of [
    "x",
    {},
    { model: "", dimension: 4, embed },
    { model: "m", dimension: 0, embed },
    { model: "m", dimension: 1.5, embed },
    { model: "m", dimension: 4 },
    { model: "m", dimension: 4, embed, maxBatch: 0 },
  ]) {
    expect(() => parseOptions({ storage: { url: "mem://" }, embedder: bad })).toThrow();
  }
});

test("embedTexts: tanpa teks tidak memanggil embedder", async () => {
  const embedder = createFakeEmbedder();
  expect(await embedTexts(embedder, [], "document")).toEqual([]);
  expect(embedder.calls).toHaveLength(0);
});

test("embedTexts: teks dipecah menurut maxBatch, urutan hasil terjaga", async () => {
  const embedder = createFakeEmbedder({ maxBatch: 2, dimension: 16 });
  const texts = ["a", "b", "c", "d", "e"];
  const vectors = await embedTexts(embedder, texts, "query");
  expect(embedder.calls.map((c) => c.texts)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  expect(embedder.calls.every((c) => c.kind === "query")).toBe(true);
  expect(vectors).toHaveLength(5);
  expect(vectors[4]).toEqual(
    (await embedTexts(createFakeEmbedder({ dimension: 16 }), ["e"], "query"))[0],
  );
});

test("embedTexts: batch bawaan 64", async () => {
  const embedder = createFakeEmbedder({ dimension: 8 });
  await embedTexts(
    embedder,
    Array.from({ length: 130 }, (_, i) => `t${i}`),
    "document",
  );
  expect(embedder.calls.map((c) => c.texts.length)).toEqual([64, 64, 2]);
});

test("embedTexts: error embedder dibungkus MemoryError dengan penyebabnya", async () => {
  const embedder = createFakeEmbedder();
  embedder.failNext(new Error("kuota habis"));
  const error = await failure(embedTexts(embedder, ["a"], "document"));
  expect(error.code).toBe("embedder");
  expect(error.message).toContain("kuota habis");
  expect(String(error.details.cause)).toContain("kuota habis");
});

test.each([
  ["jumlah vektor kurang", [[1, 0, 0, 0]], ["a", "b"]],
  ["dimensi salah", [[1, 0, 0]], ["a"]],
  ["berisi NaN", [[1, Number.NaN, 0, 0]], ["a"]],
  ["berisi bukan angka", [["x", 0, 0, 0]], ["a"]],
  ["bukan array", "oops", ["a"]],
])("embedTexts: hasil tidak valid ditolak (%s)", async (_name, returned, texts) => {
  const embedder = createFakeEmbedder({ dimension: 4 });
  embedder.returnNext(returned as number[][]);
  const error = await failure(embedTexts(embedder as Embedder, texts, "document"));
  expect(error.code).toBe("embedder");
  expect(error.details.expectedDimension).toBe(4);
});
