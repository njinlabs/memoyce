import { expect, test } from "bun:test";
import type { Content, FunctionCall } from "@google/genai";
import {
  type GenerateRequest,
  type ModelResponse,
  runTurn,
  systemPrompt,
  toDeclaration,
  windowTurns,
} from "../../examples/cli/agent";
import { geminiEmbedder, openAiEmbedder } from "../../examples/cli/embedders";
import type { MemoryTool } from "../../src/index";

// Logika aplikasi contoh (examples/cli) dites dengan model palsu, tanpa jaringan dan tanpa kunci.

const text = (s: string): Content => ({ role: "model", parts: [{ text: s }] });
const call = (name: string, args: unknown, id = "c1"): ModelResponse => {
  const functionCall = { id, name, args } as FunctionCall;
  return {
    candidates: [{ content: { role: "model", parts: [{ functionCall }] } }],
    functionCalls: [functionCall],
  };
};
const answer = (s: string): ModelResponse => ({
  candidates: [{ content: text(s) }],
  text: s,
});

const echoTool = (executed: unknown[] = []): MemoryTool => ({
  name: "memory_recall",
  description: "cari",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  execute: async (input) => {
    executed.push(input);
    return { ok: true, found: false, items: [] };
  },
});

const scripted = (responses: ModelResponse[]) => {
  const requests: GenerateRequest[] = [];
  return {
    requests,
    generate: async (request: GenerateRequest) => {
      requests.push(structuredClone(request));
      const next = responses.shift();
      if (!next) throw new Error("skrip habis");
      return next;
    },
  };
};

const base = { model: "m", system: "s", history: [], userText: "halo" };

test("windowTurns: mengambil N giliran terakhir; 0 berarti semua", () => {
  const turns = [[text("a")], [text("b")], [text("c")]];
  expect(windowTurns(turns, 2)).toEqual([[text("b")], [text("c")]]);
  expect(windowTurns(turns, 10)).toHaveLength(3);
  expect(windowTurns(turns, 0)).toHaveLength(3);
});

test("toDeclaration: JSON Schema tool diteruskan lewat parametersJsonSchema", () => {
  const tool = echoTool();
  expect(toDeclaration(tool)).toEqual({
    name: "memory_recall",
    description: "cari",
    parametersJsonSchema: tool.inputSchema,
  });
});

test("jawaban langsung tanpa tool: satu panggilan, giliran berisi pesan dan jawaban", async () => {
  const model = scripted([answer("Halo juga")]);
  const result = await runTurn({ ...base, generate: model.generate, tools: [echoTool()] });
  expect(result.text).toBe("Halo juga");
  expect(result.turn).toHaveLength(2);
  expect(result.turn[0]).toEqual({ role: "user", parts: [{ text: "halo" }] });
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]?.config.tools[0]?.functionDeclarations[0]?.name).toBe("memory_recall");
  expect(model.requests[0]?.config.systemInstruction).toBe("s");
});

test("pemanggilan tool: hasil dikirim balik sebagai functionResponse dan loop berlanjut", async () => {
  const executed: unknown[] = [];
  const events: string[] = [];
  const model = scripted([call("memory_recall", { query: "budget" }), answer("Tidak tahu")]);
  const result = await runTurn({
    ...base,
    generate: model.generate,
    tools: [echoTool(executed)],
    onToolCall: (e) => events.push(`${e.name}:${JSON.stringify(e.result)}`),
  });

  expect(executed).toEqual([{ query: "budget" }]);
  expect(events).toEqual(['memory_recall:{"ok":true,"found":false,"items":[]}']);
  expect(result.text).toBe("Tidak tahu");
  // user, model(functionCall), user(functionResponse), model(jawaban)
  expect(result.turn.map((c) => c.role)).toEqual(["user", "model", "user", "model"]);
  const response = result.turn[2]?.parts?.[0]?.functionResponse;
  expect(response).toMatchObject({ id: "c1", name: "memory_recall" });
  expect(response?.response).toEqual({ result: { ok: true, found: false, items: [] } });
  // Langkah kedua melihat panggilan tool dan hasilnya.
  expect(model.requests[1]?.contents).toHaveLength(3);
});

test("riwayat giliran sebelumnya ikut terkirim, urut", async () => {
  const model = scripted([answer("ok")]);
  const history = [[{ role: "user", parts: [{ text: "lama" }] } as Content, text("jawaban lama")]];
  await runTurn({
    ...base,
    history,
    generate: model.generate,
    tools: [echoTool()],
    userText: "baru",
  });
  const texts = model.requests[0]?.contents.map((c) => c.parts?.[0]?.text);
  expect(texts).toEqual(["lama", "jawaban lama", "baru"]);
});

test("tool tidak dikenal dan tool yang melempar dilaporkan ke model sebagai data", async () => {
  const broken: MemoryTool = {
    ...echoTool(),
    name: "memory_remember",
    execute: async () => {
      throw new Error("embedder mati");
    },
  };
  const model = scripted([
    {
      candidates: [{ content: { role: "model", parts: [] } }],
      functionCalls: [
        { id: "a", name: "tidak_ada", args: {} },
        { id: "b", name: "memory_remember", args: {} },
        { name: undefined, args: {} },
      ] as FunctionCall[],
    },
    answer("selesai"),
  ]);
  const events: { name: string; result: unknown }[] = [];
  const result = await runTurn({
    ...base,
    generate: model.generate,
    tools: [broken],
    onToolCall: (e) => events.push(e),
  });
  expect(result.text).toBe("selesai");
  expect(events[0]?.result).toEqual({ ok: false, error: "tool tidak_ada tidak ada" });
  expect(JSON.stringify(events[1]?.result)).toContain("embedder mati");
  expect(events[2]?.name).toBe("?");
});

test("jawaban kosong dari model memberi teks kosong; konten hilang dilaporkan", async () => {
  const empty = scripted([{ candidates: [{ content: text("") }] }]);
  expect((await runTurn({ ...base, generate: empty.generate, tools: [] })).text).toBe("");

  const none = scripted([{ candidates: [] }]);
  await expect(runTurn({ ...base, generate: none.generate, tools: [] })).rejects.toThrow("model");
});

test("terlalu banyak langkah tool dihentikan", async () => {
  const model = scripted(Array.from({ length: 5 }, () => call("memory_recall", {})));
  await expect(
    runTurn({ ...base, generate: model.generate, tools: [echoTool()], maxSteps: 3 }),
  ).rejects.toThrow("3 langkah");
  expect(model.requests).toHaveLength(3);
});

test("systemPrompt memuat tanggal dan aturan jangan menebak", () => {
  const prompt = systemPrompt(new Date("2025-03-04T10:00:00Z"));
  expect(prompt).toContain("Hari ini 2025-03-04");
  expect(prompt).toContain("Jangan menebak");
  expect(prompt).toContain("memory_recall");
});

test("openAiEmbedder: permintaan benar dan urutan hasil mengikuti index", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const embedder = openAiEmbedder({
    apiKey: "kunci",
    dimension: 4,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0, 0] },
            { index: 0, embedding: [1, 0, 0, 0] },
          ],
        }),
      );
    }) as unknown as typeof fetch,
  });
  expect(embedder.model).toBe("openai:text-embedding-3-small@4");
  const vectors = await embedder.embed(["a", "b"], { kind: "document" });
  expect(vectors).toEqual([
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ]);
  expect(seen[0]?.url).toBe("https://api.openai.com/v1/embeddings");
  expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
    model: "text-embedding-3-small",
    input: ["a", "b"],
    dimensions: 4,
  });
  expect((seen[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
    "Bearer kunci",
  );
});

test("openAiEmbedder: galat HTTP dilaporkan dengan isi responsnya", async () => {
  const embedder = openAiEmbedder({
    apiKey: "x",
    fetchImpl: (async () =>
      new Response("kuota habis", { status: 429 })) as unknown as typeof fetch,
  });
  await expect(embedder.embed(["a"], { kind: "query" })).rejects.toThrow("429: kuota habis");
});

test("geminiEmbedder: taskType mengikuti kind dan dimensi diteruskan", async () => {
  const requests: unknown[] = [];
  const embedder = geminiEmbedder({
    dimension: 3,
    ai: {
      models: {
        embedContent: async (request: unknown) => {
          requests.push(request);
          return { embeddings: [{ values: [1, 2, 3] }, {}] };
        },
      },
    } as never,
  });
  expect(embedder.model).toBe("gemini:gemini-embedding-001@3");
  const vectors = await embedder.embed(["a", "b"], { kind: "query" });
  expect(vectors).toEqual([[1, 2, 3], []]);
  await embedder.embed(["a"], { kind: "document" });
  expect(requests[0]).toMatchObject({
    model: "gemini-embedding-001",
    contents: ["a", "b"],
    config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 3 },
  });
  expect(requests[1]).toMatchObject({ config: { taskType: "RETRIEVAL_DOCUMENT" } });
});
