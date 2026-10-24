import type { Content, FunctionCall, FunctionDeclaration } from "@google/genai";
import type { MemoryTool } from "../../src/index";

// Inti percakapan: tidak tahu apa-apa tentang jaringan atau terminal, supaya bisa dites.
// Satu "giliran" = pesan pengguna sampai jawaban akhir model, termasuk semua panggilan tool
// di antaranya. Riwayat dipotong per giliran agar pasangan functionCall/functionResponse
// tidak pernah terputus.

export type Turn = Content[];

// Subset respons SDK yang dipakai; memudahkan pemalsuan di tes.
export interface ModelResponse {
  candidates?: { content?: Content }[];
  functionCalls?: FunctionCall[];
  text?: string;
}

export interface GenerateRequest {
  model: string;
  contents: Content[];
  config: {
    systemInstruction: string;
    tools: { functionDeclarations: FunctionDeclaration[] }[];
  };
}

export interface ToolEvent {
  name: string;
  args: unknown;
  result: unknown;
}

export function windowTurns(turns: Turn[], size: number): Turn[] {
  return size > 0 ? turns.slice(-size) : turns;
}

// Skema tool sudah JSON Schema penuh; Gemini menerimanya lewat parametersJsonSchema.
export function toDeclaration(tool: MemoryTool): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  };
}

export async function runTurn(options: {
  generate: (request: GenerateRequest) => Promise<ModelResponse>;
  model: string;
  system: string;
  tools: MemoryTool[];
  history: Turn[];
  userText: string;
  onToolCall?: (event: ToolEvent) => void;
  maxSteps?: number;
}): Promise<{ text: string; turn: Turn }> {
  const { generate, model, system, tools, history, userText, onToolCall, maxSteps = 6 } = options;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const declarations = tools.map(toDeclaration);
  const turn: Turn = [{ role: "user", parts: [{ text: userText }] }];

  for (let step = 0; step < maxSteps; step++) {
    const response = await generate({
      model,
      contents: [...history.flat(), ...turn],
      config: { systemInstruction: system, tools: [{ functionDeclarations: declarations }] },
    });
    const content = response.candidates?.[0]?.content;
    if (!content) throw new Error("model tidak mengembalikan jawaban");
    // Disimpan apa adanya: model generasi baru mensyaratkan bagian "thought signature" ikut
    // dikirim kembali pada langkah berikutnya.
    turn.push(content);

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) return { text: response.text ?? "", turn };

    const parts = [];
    for (const call of calls) {
      const tool = byName.get(call.name ?? "");
      let result: unknown;
      try {
        result = tool
          ? await tool.execute(call.args)
          : { ok: false, error: `tool ${call.name} tidak ada` };
      } catch (error) {
        // Galat infrastruktur (embedder/DB) dilaporkan ke model sebagai data, bukan menghentikan chat.
        result = { ok: false, error: `memori tidak tersedia: ${String(error)}` };
      }
      onToolCall?.({ name: call.name ?? "?", args: call.args, result });
      parts.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
    }
    turn.push({ role: "user", parts });
  }
  throw new Error(`lebih dari ${maxSteps} langkah tool dalam satu giliran`);
}

export function systemPrompt(today: Date = new Date()): string {
  return [
    "Kamu asisten penjualan yang membantu mengelola calon pelanggan (lead). Jawab dalam bahasa pengguna, singkat dan jelas.",
    `Hari ini ${today.toISOString().slice(0, 10)}.`,
    "Kamu punya memori jangka panjang lewat tool memory_*. Riwayat chat dipotong, jadi hanya memori yang bertahan.",
    "- Sebelum menjawab hal tentang calon pelanggan (angka, status, keputusan, riwayat), panggil memory_recall.",
    "- Bila pengguna menyampaikan fakta baru yang layak diingat, panggil memory_remember dengan kutipan persis dari pesan pengguna.",
    "- Jika memory_recall mengembalikan found=false, katakan terus terang kamu tidak punya informasinya. Jangan menebak.",
    "- Bila memory_remember mengembalikan ok=false, perbaiki sesuai errors lalu coba lagi.",
    "- Sebutkan sumber/tanggal bila menjawab dari memori dan nilainya sudah berubah.",
  ].join("\n");
}
