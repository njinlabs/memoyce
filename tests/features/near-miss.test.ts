import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemory, type Memory } from "../../src/index";
import { createFakeEmbedder } from "../support/embedder";

// Entitas bernama mirip ("PT Maju" dan "PT Maju Jaya") tidak boleh tertukar: menanyakan yang
// satu tidak boleh mengembalikan fakta yang lain, sebagai subjek maupun sebagai nilai.

let memory: Memory;
const SCOPE = "org:1";

beforeAll(async () => {
  memory = await createMemory({
    storage: { url: "mem://" },
    embedder: createFakeEmbedder(),
    retrieval: { minSimilarity: 0.3, minKeywordCoverage: 0.3 },
    attributes: [
      { key: "budget", description: "anggaran", type: "number" },
      { key: "works_for", description: "bekerja di", type: "entity" },
    ],
  });
  const result = await memory.remember({
    scope: SCOPE,
    source: {
      received_at: "2026-01-10T09:00:00Z",
      content:
        "PT Maju punya anggaran 75 juta. PT Maju Jaya punya anggaran 20 juta. " +
        "Budi bekerja di PT Maju. Dewi bekerja di PT Maju Jaya.",
    },
    facts: [
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 75_000_000,
        quote: "PT Maju punya anggaran 75 juta",
      },
      {
        entity: "PT Maju Jaya",
        attribute: "budget",
        value: 20_000_000,
        quote: "PT Maju Jaya punya anggaran 20 juta",
      },
      {
        entity: "Budi",
        attribute: "works_for",
        value: "PT Maju",
        quote: "Budi bekerja di PT Maju",
      },
      {
        entity: "Dewi",
        attribute: "works_for",
        value: "PT Maju Jaya",
        quote: "Dewi bekerja di PT Maju Jaya",
      },
    ],
  });
  expect(result.ok).toBe(true);
});
afterAll(async () => {
  await memory.close();
});

const names = (result: Awaited<ReturnType<Memory["recall"]>>): string[] =>
  result.ok ? result.items.map((i) => i.entity.name) : [];

test("menanyakan PT Maju Jaya tidak mengembalikan fakta PT Maju", async () => {
  const result = await memory.recall({ scope: SCOPE, query: "Berapa anggaran PT Maju Jaya?" });
  expect(result.ok && result.found).toBe(true);
  expect(names(result)).toContain("PT Maju Jaya");
  expect(names(result)).not.toContain("PT Maju");
  expect(names(result)).not.toContain("Budi");
});

test("relasi: pekerja PT Maju Jaya, bukan PT Maju", async () => {
  const result = await memory.recall({
    scope: SCOPE,
    query: "Siapa yang bekerja di PT Maju Jaya?",
  });
  expect(names(result)).toContain("Dewi");
  expect(names(result)).not.toContain("Budi");
});

test("menyebut keduanya: keduanya dijawab", async () => {
  const result = await memory.recall({
    scope: SCOPE,
    query: "Bandingkan anggaran PT Maju dengan anggaran PT Maju Jaya",
  });
  expect(names(result)).toContain("PT Maju");
  expect(names(result)).toContain("PT Maju Jaya");
});

test("menanyakan PT Maju tetap menemukan faktanya", async () => {
  const result = await memory.recall({ scope: SCOPE, query: "Berapa anggaran PT Maju?" });
  expect(result.ok && result.found).toBe(true);
  expect(names(result)).toContain("PT Maju");
});
