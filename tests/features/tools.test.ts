import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemory, type Memory, type MemoryTool } from "../../src/index";
import { createFakeEmbedder } from "../support/embedder";

// Meniru aplikasi dengan AI: aplikasi membuat tool terikat scope-nya, AI memanggil tool dengan
// JSON, hasilnya kembali sebagai JSON. "AI" di sini hanya skrip deterministik.

let memory: Memory;
let tools: MemoryTool[];

beforeAll(async () => {
  memory = await createMemory({
    storage: { url: "mem://" },
    embedder: createFakeEmbedder(),
    retrieval: { minSimilarity: 0.3, minKeywordCoverage: 0.5 },
    attributes: [
      { key: "stage", description: "tahap penjualan" },
      { key: "budget", description: "anggaran", type: "number", aliases: ["dana"] },
      { key: "next_step", description: "langkah berikutnya yang disepakati" },
    ],
  });
  tools = memory.tools({
    scope: "org:1/lead:maju",
    sourceMeta: { channel: "chat" },
  });
});

afterAll(() => memory.close());

// Seperti SDK AI: tool dipanggil lewat nama, input dan hasil melewati JSON.
const useTool = async (name: string, input: unknown) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} tidak ada`);
  return JSON.parse(JSON.stringify(await tool.execute(JSON.parse(JSON.stringify(input)))));
};

test("tool dapat dipetakan ke format SDK populer hanya dengan pemetaan nama field", () => {
  const anthropic = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  const openai = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  expect(anthropic.map((t) => t.name)).toEqual(openai.map((t) => t.function.name));
  // Skema bisa diserialisasi apa adanya ke API model.
  expect(() => JSON.stringify(openai)).not.toThrow();
});

test("alur percakapan: tanya (tidak tahu) -> simpan -> tanya lagi -> koreksi -> riwayat", async () => {
  // 1. AI mengecek memori sebelum menjawab: belum ada apa pun.
  const empty = await useTool("memory_recall", { query: "berapa budget PT Maju" });
  expect(empty).toMatchObject({ ok: true, found: false, items: [] });
  expect(empty.message).toContain("Jangan menebak");

  // 2. Pengguna menyebut angka; AI menyimpannya, sekali salah atribut lalu memperbaiki.
  const content = "PT Maju punya dana sekitar 50 juta. Langkah berikutnya: kirim proposal.";
  const rejected = await useTool("memory_remember", {
    source: { content, received_at: "2025-02-01T09:00:00Z" },
    facts: [
      {
        entity: "PT Maju",
        attribute: "anggaran_total",
        value: 50_000_000,
        quote: "dana sekitar 50 juta",
      },
    ],
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.errors[0].code).toBe("unknown_attribute");

  const saved = await useTool("memory_remember", {
    source: { content, received_at: "2025-02-01T09:00:00Z" },
    facts: [
      // "dana" adalah alias atribut budget: dipetakan otomatis ke kunci kanoniknya.
      {
        entity: { name: "PT Maju", kind: "organization" },
        attribute: "dana",
        value: 50_000_000,
        quote: "dana sekitar 50 juta",
      },
      {
        entity: "PT Maju",
        attribute: "next_step",
        value: "kirim proposal",
        quote: "kirim proposal",
      },
    ],
  });
  expect(saved.ok).toBe(true);
  expect(saved.results.map((r: { attribute: string }) => r.attribute)).toEqual([
    "budget",
    "next_step",
  ]);

  // 3. Menjawab dengan bukti.
  const answer = await useTool("memory_recall", { query: "berapa budget PT Maju" });
  expect(answer.found).toBe(true);
  expect(answer.items[0]).toMatchObject({
    attribute: "budget",
    value: 50_000_000,
    quote: "dana sekitar 50 juta",
  });

  // 4. Pengguna mengoreksi angka sebulan kemudian; riwayat tetap bisa ditanyakan.
  const update = await useTool("memory_remember", {
    source: {
      content: "Kabar baru: dana PT Maju naik jadi 80 juta.",
      received_at: "2025-03-01T09:00:00Z",
    },
    facts: [
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 80_000_000,
        quote: "dana PT Maju naik jadi 80 juta",
      },
    ],
  });
  expect(update.results[0].status).toBe("updated");

  const now = await useTool("memory_recall", { query: "budget PT Maju" });
  expect(now.items.find((i: { attribute: string }) => i.attribute === "budget").value).toBe(
    80_000_000,
  );
  const before = await useTool("memory_recall", { query: "budget PT Maju", as_of: "2025-02-15" });
  expect(before.items.find((i: { attribute: string }) => i.attribute === "budget").value).toBe(
    50_000_000,
  );

  // 5. Sumber tercatat dengan meta dari aplikasi.
  expect(now.items[0].source.id).toStartWith("source:");
});

test("tool baca-saja tidak menyediakan penulisan", async () => {
  const readOnly = memory.tools({ scope: "org:1/lead:maju", readOnly: true });
  expect(readOnly.map((t) => t.name)).toEqual(["memory_recall", "memory_list_attributes"]);
  const found = await readOnly[0]?.execute({ query: "budget PT Maju" });
  expect((found as { found: boolean }).found).toBe(true);
});
