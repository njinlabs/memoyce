import { afterAll, beforeAll, expect, test } from "bun:test";
import { isoTime } from "../../src/core/schemas";
import { createTools, type MemoryTool } from "../../src/core/tools";
import { openTestContext, type TestContext, testAttributes } from "../support/context";
import { createFakeEmbedder } from "../support/embedder";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext({
    attributes: testAttributes,
    embedder: createFakeEmbedder(),
    retrieval: { minSimilarity: 0.3, minKeywordCoverage: 0.5 },
  });
});

afterAll(() => t.close());

const byName = (tools: MemoryTool[], name: string): MemoryTool => {
  const tool = tools.find((x) => x.name === name);
  if (!tool) throw new Error(`tool ${name} tidak ada`);
  return tool;
};

// Meniru SDK AI: input dan hasil melewati JSON.
const call = async (tool: MemoryTool, input: unknown) =>
  JSON.parse(JSON.stringify(await tool.execute(JSON.parse(JSON.stringify(input)))));

const factInput = (content: string, value: string, attribute = "city") => ({
  source: { content, received_at: "2025-03-01T00:00:00Z" },
  facts: [{ entity: "Budi", attribute, value, quote: content.slice(0, 12) }],
});

test("daftar tool lengkap, dan readOnly hanya membaca", () => {
  expect(createTools(t.ctx, { scope: "a" }).map((x) => x.name)).toEqual([
    "memory_remember",
    "memory_recall",
    "memory_list_attributes",
  ]);
  expect(createTools(t.ctx, { scope: "a", readOnly: true }).map((x) => x.name)).toEqual([
    "memory_recall",
    "memory_list_attributes",
  ]);
});

test("opsi tidak valid ditolak", () => {
  for (const bad of [
    { scope: "" },
    {},
    { scope: "a", readScopes: [] },
    { scope: "a", readOnly: "ya" },
  ]) {
    expect(() => createTools(t.ctx, bad as never)).toThrow();
  }
});

test("skema input: JSON Schema bersih, tanpa scope/meta/ambang, tanpa regex tanggal panjang", () => {
  const tools = createTools(t.ctx, { scope: "a" });
  for (const tool of tools) {
    const text = JSON.stringify(tool.inputSchema);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.$schema).toBeUndefined();
    expect(text).not.toContain("pattern");
    expect(tool.description.length).toBeGreaterThan(20);
  }
  const remember = JSON.stringify(byName(tools, "memory_remember").inputSchema);
  expect(remember).not.toContain('"scope"');
  expect(remember).not.toContain('"meta"');
  expect(byName(tools, "memory_remember").inputSchema.required).toEqual(["source", "facts"]);

  const recall = byName(tools, "memory_recall").inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  expect(Object.keys(recall.properties).sort()).toEqual(["as_of", "limit", "query"]);
  expect(recall.required).toEqual(["query"]);
  expect(JSON.stringify(recall)).not.toContain("min_similarity");
});

test("deskripsi memuat kosakata atribut beserta tipe, kardinalitas, dan alias", () => {
  const { description } = byName(createTools(t.ctx, { scope: "a" }), "memory_remember");
  expect(description).toContain("- employer (string): tempat bekerja; alias: company, works_at");
  expect(description).toContain("- hobby (string, banyak nilai): hobi");
  expect(description).toContain("ditolak");
});

test("deskripsi memory_recall memuat kosakata dan aturan menulis query (tanpa mengganti pertanyaan)", () => {
  const { description } = byName(createTools(t.ctx, { scope: "a" }), "memory_recall");
  expect(description).toContain("- employer (string): tempat bekerja");
  expect(description).toContain("DESKRIPSI atribut");
  expect(description).toContain("JANGAN diganti atribut lain");
  expect(description).toContain("TANPA kata tanya");
  expect(description).toContain("JANGAN menebak");
});

test("deskripsi menyesuaikan mode open dan kosakata kosong", async () => {
  const open = await openTestContext({ vocabulary: "open", attributes: [] });
  try {
    const { description } = byName(createTools(open.ctx, { scope: "a" }), "memory_remember");
    expect(description).toContain("Belum ada atribut terdaftar");
    expect(description).toContain("diterima sebagai teks bebas");
  } finally {
    await open.close();
  }
});

test("memory_list_attributes mengembalikan kosakata terstruktur", async () => {
  const result = await call(
    byName(createTools(t.ctx, { scope: "a" }), "memory_list_attributes"),
    {},
  );
  expect(result.ok).toBe(true);
  expect(result.vocabulary).toBe("strict");
  expect(result.attributes).toContainEqual({
    key: "employer",
    description: "tempat bekerja",
    type: "string",
    cardinality: "single",
    aliases: ["company", "works_at"],
  });
});

test("remember dan recall terikat pada scope aplikasi; hasil JSON murni", async () => {
  const tools = createTools(t.ctx, { scope: "tenant:a" });
  const saved = await call(
    byName(tools, "memory_remember"),
    factInput("Budi tinggal di Bandung", "Bandung"),
  );
  expect(saved.ok).toBe(true);
  expect(saved.results[0]).toMatchObject({ status: "created", attribute: "city" });

  const found = await call(byName(tools, "memory_recall"), { query: "Budi tinggal di kota apa" });
  expect(found.found).toBe(true);
  expect(found.items[0]).toMatchObject({ scope: "tenant:a", value: "Bandung" });

  const other = await call(byName(createTools(t.ctx, { scope: "tenant:b" }), "memory_recall"), {
    query: "Budi tinggal di kota apa",
  });
  expect(other.found).toBe(false);
});

test("nilai kiriman AI untuk scope, meta, dan ambang diabaikan", async () => {
  const tools = createTools(t.ctx, {
    scope: "tenant:c",
    sourceMeta: { channel: "whatsapp", user: "u1" },
  });
  const saved = await call(byName(tools, "memory_remember"), {
    scope: "tenant:LAIN",
    source: {
      content: "Budi tinggal di Medan",
      received_at: "2025-03-01",
      meta: { channel: "dipalsukan" },
      scope: "tenant:LAIN",
    },
    facts: [{ entity: "Budi", attribute: "city", value: "Medan", quote: "tinggal di Medan" }],
  });
  expect(saved.ok).toBe(true);

  const [source] = await t.ctx.db
    .query<[{ scope: string; meta: unknown }[]]>(
      "SELECT scope, meta FROM source WHERE scope = $s",
      {
        s: "tenant:c",
      },
    )
    .collect()
    .then(([rows]) => rows ?? []);
  expect(source).toEqual({ scope: "tenant:c", meta: { channel: "whatsapp", user: "u1" } });
  const [leak] = await t.ctx.db
    .query<[unknown[]]>("SELECT id FROM source WHERE scope = 'tenant:LAIN'")
    .collect();
  expect(leak).toEqual([]);

  // Ambang kiriman AI (min_similarity 0.99) tidak berlaku; scope kiriman AI juga diabaikan.
  const found = await call(byName(tools, "memory_recall"), {
    scope: "tenant:LAIN",
    query: "Budi tinggal di kota apa",
    min_similarity: 0.99,
    min_keyword_coverage: 1,
  });
  expect(found.found).toBe(true);
  expect(found.items[0].scope).toBe("tenant:c");
});

test("readScopes: membaca beberapa scope, menulis hanya ke scope utama", async () => {
  const shared = createTools(t.ctx, { scope: "shared:docs" });
  await call(
    byName(shared, "memory_remember"),
    factInput("Perusahaan beralamat di Jakarta Selatan", "Jakarta Selatan", "city"),
  );
  await call(byName(createTools(t.ctx, { scope: "user:1" }), "memory_remember"), {
    source: { content: "Andi suka kopi hitam", received_at: "2025-03-01" },
    facts: [{ entity: "Andi", attribute: "hobby", value: "kopi hitam", quote: "suka kopi hitam" }],
  });

  const tools = createTools(t.ctx, { scope: "user:1", readScopes: ["user:1", "shared:docs"] });
  const found = await call(byName(tools, "memory_recall"), {
    query: "alamat perusahaan Jakarta Selatan",
  });
  expect(found.items.map((i: { scope: string }) => i.scope)).toContain("shared:docs");

  // Menulis lewat tool ini masuk ke scope utama saja.
  await call(byName(tools, "memory_remember"), factInput("Budi tinggal di Solo", "Solo"));
  const [shareRows] = await t.ctx.db
    .query<[unknown[]]>(
      "SELECT id FROM source WHERE scope = 'shared:docs' AND content CONTAINS 'Solo'",
    )
    .collect();
  expect(shareRows).toEqual([]);
});

test("input AI yang salah dikembalikan sebagai data yang bisa diperbaiki", async () => {
  const tools = createTools(t.ctx, { scope: "tenant:d" });
  const remember = byName(tools, "memory_remember");

  const wrongAttribute = await call(remember, factInput("Budi tinggal di Solo", "Solo", "kotaa"));
  expect(wrongAttribute).toMatchObject({ ok: false, stage: "validation" });
  expect(wrongAttribute.errors[0]).toMatchObject({ index: 0, code: "unknown_attribute" });
  expect(wrongAttribute.errors[0].details.suggestions).toEqual(["city"]);

  const badQuote = await call(remember, {
    source: { content: "Budi tinggal di Solo" },
    facts: [{ entity: "Budi", attribute: "city", value: "Solo", quote: "tidak ada di teks" }],
  });
  expect(badQuote.errors[0].code).toBe("quote_not_found");

  for (const garbage of ["halo", null, 42, [], { facts: "x" }]) {
    const result = await call(remember, garbage);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  }
  for (const garbage of ["halo", null, {}, { query: "" }]) {
    const result = await call(byName(tools, "memory_recall"), garbage);
    expect(result.ok).toBe(false);
  }
});

test("isoTime: menerima ISO 8601 yang valid dan menolak sisanya", () => {
  for (const ok of [
    "2025-01-31",
    "2024-02-29",
    "2025-01-31T09:00Z",
    "2025-01-31T09:00:15Z",
    "2025-01-31T09:00:15.250+07:00",
  ]) {
    expect(isoTime.safeParse(ok).success).toBe(true);
  }
  for (const bad of [
    "2025-02-30",
    "2025-02-29",
    "2025-13-01",
    "kemarin",
    "2025-01-31T09:00",
    "31/01/2025",
    "",
    "2025-01-31T25:00:00Z",
  ]) {
    expect(isoTime.safeParse(bad).success).toBe(false);
  }
});
