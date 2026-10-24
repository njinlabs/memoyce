import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { createMemory, type Embedder } from "../../src/index";
import { runTurn, systemPrompt, type ToolEvent, type Turn, windowTurns } from "./agent";
import { salesAttributes } from "./attributes";
import { geminiEmbedder, openAiEmbedder } from "./embedders";

// Aplikasi uji sederhana: chat di terminal dengan Gemini, memori lewat library ini.
// Jalankan: bun run example:cli   (lihat examples/cli/README.md)

const { values: args } = parseArgs({
  options: {
    scope: { type: "string", default: "demo:lead-1" },
    db: { type: "string", default: "./data/cli-demo" },
    window: { type: "string", default: "6" },
    quiet: { type: "boolean", default: false },
    reindex: { type: "boolean", default: false },
  },
});

const geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey) {
  console.error("GEMINI_API_KEY belum diisi. Salin .env.example ke .env lalu isi kuncinya.");
  process.exit(1);
}
const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const ai = new GoogleGenAI({ apiKey: geminiKey });

function chooseEmbedder(): { embedder?: Embedder; label: string } {
  const provider =
    process.env.EMBEDDING_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai" : "gemini");
  if (provider === "none") return { label: "tanpa embedding (kata kunci + graf)" };
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("EMBEDDING_PROVIDER=openai membutuhkan OPENAI_API_KEY");
    const embedder = openAiEmbedder({ apiKey });
    return { embedder, label: embedder.model };
  }
  const embedder = geminiEmbedder({ ai });
  return { embedder, label: embedder.model };
}

const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number(raw);
};

const { embedder, label } = chooseEmbedder();
const memory = await createMemory({
  storage: { url: `rocksdb://${args.db}` },
  attributes: salesAttributes,
  embedder,
  onEmbedderChange: args.reindex ? "reindex" : "error",
  // Ambang bawaan belum dikalibrasi; ubah lewat env sambil mencoba /recall.
  retrieval: {
    minSimilarity: number("MIN_SIMILARITY", 0.5),
    minKeywordCoverage: number("MIN_KEYWORD_COVERAGE", 0.5),
  },
});
const scope = args.scope as string;
const tools = memory.tools({ scope, sourceMeta: { channel: "cli" } });
const windowSize = Number(args.window);

const short = (value: unknown, max = 160): string => {
  const text = JSON.stringify(value) ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function describe({ name, args: input, result }: ToolEvent): string {
  const r = result as Record<string, unknown>;
  if (name === "memory_recall") {
    const items = (r.items as unknown[] | undefined)?.length ?? 0;
    return `found=${String(r.found)} (${items} hasil)`;
  }
  if (name === "memory_remember") {
    return r.ok ? `ok (${(r.results as unknown[]).length} fakta)` : `ditolak: ${short(r.errors)}`;
  }
  return short(result ?? input);
}

console.log(`Model: ${model} | Embedding: ${label}`);
console.log(`Scope: ${scope} | Database: ${args.db} | Jendela riwayat: ${windowSize} giliran`);
console.log("Ketik pesan, atau /help. Ctrl+C untuk keluar.\n");

const rl = createInterface({ input: stdin, output: stdout });
let history: Turn[] = [];

async function command(line: string): Promise<boolean> {
  const [name, ...rest] = line.slice(1).split(" ");
  const argument = rest.join(" ").trim();
  switch (name) {
    case "help":
      console.log(
        [
          "/recall <pertanyaan>  jalankan memory.recall langsung dan tampilkan buktinya",
          "/clear                kosongkan riwayat chat (memori tetap ada)",
          "/tools                daftar tool untuk AI",
          "/reindex              bangun ulang vektor",
          "/exit                 keluar",
        ].join("\n"),
      );
      return true;
    case "clear":
      history = [];
      console.log("Riwayat chat dikosongkan. Memori jangka panjang tidak disentuh.");
      return true;
    case "tools":
      for (const tool of tools) console.log(`- ${tool.name}`);
      return true;
    case "reindex":
      console.log(short(await memory.reindex()));
      return true;
    case "recall": {
      const result = await memory.recall({ scope, query: argument || "apa yang kamu ingat" });
      if (!result.ok) {
        console.log(short(result.errors));
        return true;
      }
      console.log(`found=${result.found}`, result.message ?? "");
      for (const item of result.items) {
        console.log(
          ` - ${item.text}\n   nilai=${short(item.value, 80)} berlaku ${item.valid_from.slice(0, 10)}${
            item.valid_to ? ` s/d ${item.valid_to.slice(0, 10)}` : ""
          } sinyal=${short(item.signals, 120)}`,
        );
      }
      return true;
    }
    default:
      return false;
  }
}

async function handle(line: string): Promise<"exit" | "next"> {
  if (!line) return "next";
  if (line === "/exit" || line === "/quit") return "exit";
  if (line.startsWith("/")) {
    if (!(await command(line))) console.log("Perintah tidak dikenal. /help");
    return "next";
  }

  try {
    const { text, turn } = await runTurn({
      generate: (request) => ai.models.generateContent(request),
      model,
      system: systemPrompt(),
      tools,
      history: windowTurns(history, windowSize),
      userText: line,
      onToolCall: args.quiet
        ? undefined
        : (event) =>
            console.log(`  ↳ ${event.name} ${short(event.args, 100)} → ${describe(event)}`),
    });
    history.push(turn);
    console.log(`agen> ${text}\n`);
  } catch (error) {
    console.error(`Galat: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return "next";
}

// Iterasi baris (bukan rl.question) agar input yang di-pipe tidak ada barisnya yang terbuang.
// Input yang di-pipe bisa selesai (rl tertutup) sebelum semua baris diproses.
let closed = false;
rl.on("close", () => {
  closed = true;
});
const prompt = () => {
  if (!closed) rl.prompt();
};
rl.setPrompt("kamu> ");
prompt();
try {
  for await (const raw of rl) {
    if ((await handle(raw.trim())) === "exit") break;
    prompt();
  }
} finally {
  rl.close();
  await memory.close();
}
