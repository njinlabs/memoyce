import { z } from "zod";
import type { Ctx } from "./context.ts";
import { MemoryError } from "./errors.ts";
import { recall, recallSchema } from "./recall.ts";
import { remember, rememberSchema } from "./remember.ts";

// Definisi tool netral: aplikasi menempelkannya ke SDK AI-nya sendiri (Vercel AI SDK,
// Anthropic, OpenAI, MCP, ...). `inputSchema` adalah JSON Schema biasa; `execute` menerima
// input mentah dari AI dan mengembalikan objek JSON murni (JSON.stringify aman).
export interface MemoryTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown): Promise<unknown>;
}

const toolsOptionsSchema = z.object({
  scope: z.string().min(1),
  readScopes: z.array(z.string().min(1)).min(1).max(20).optional(),
  sourceMeta: z.record(z.string(), z.unknown()).optional(),
  readOnly: z.boolean().default(false),
});

export type ToolsOptions = z.input<typeof toolsOptionsSchema>;

// Yang boleh diisi AI. `scope`, `meta` sumber, dan ambang bukti sengaja tidak ada: itu keputusan
// aplikasi (kepemilikan data dan keamanan), dan nilai kiriman AI untuk field itu diabaikan.
const rememberToolSchema = z.object({
  source: rememberSchema.shape.source.pick({ content: true, received_at: true }),
  facts: rememberSchema.shape.facts,
});
const recallToolSchema = recallSchema.pick({ query: true, as_of: true, limit: true });

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  return rest;
}

function pick(raw: unknown, keys: string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]));
}

export function createTools(ctx: Ctx, input: ToolsOptions): MemoryTool[] {
  const parsed = toolsOptionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError("invalid_options", z.prettifyError(parsed.error), {
      issues: parsed.error.issues,
    });
  }
  const { scope, readScopes, sourceMeta, readOnly } = parsed.data;

  const attributes = ctx.registry.all();
  const vocabulary =
    attributes.length === 0
      ? "Belum ada atribut terdaftar."
      : attributes
          .map((a) => {
            const alias = a.aliases.length > 0 ? `; alias: ${a.aliases.join(", ")}` : "";
            return `- ${a.key} (${a.type}${a.cardinality === "multi" ? ", banyak nilai" : ""}): ${a.description}${alias}`;
          })
          .join("\n");
  const strictNote =
    ctx.registry.vocabulary === "strict"
      ? "Hanya atribut berikut yang diterima; atribut lain ditolak (kamu akan menerima saran)."
      : "Atribut di luar daftar diterima sebagai teks bebas, tetapi utamakan daftar berikut.";

  const rememberTool: MemoryTool = {
    name: "memory_remember",
    description: [
      "Simpan informasi baru ke memori jangka panjang. Panggil saat pengguna menyampaikan fakta yang layak diingat (preferensi, keputusan, angka, status, relasi antar pihak).",
      "Kirim `source.content` berupa teks asal persis seperti diterima, lalu `facts`: fakta terstruktur yang kamu ekstrak dari teks itu.",
      "Setiap fakta WAJIB punya `quote`: kutipan persis (minimal 3 karakter) dari `source.content` yang mendukung fakta itu. Fakta tanpa kutipan yang ada di teks sumber ditolak.",
      "`entity` boleh berupa nama, `{ name, kind }`, atau `{ id }` dari hasil memori sebelumnya. Untuk atribut bertipe entity, `value` memakai bentuk yang sama.",
      "Bila nilai suatu atribut berubah, fakta lama otomatis ditutup dan riwayatnya tetap tersimpan. `valid_from` hanya diisi bila fakta berlaku sejak waktu tertentu yang disebut di teks (ISO 8601).",
      "Jika hasil `ok: false`, baca `errors`, perbaiki, lalu panggil lagi: pada kegagalan tahap `validation` tidak ada yang tersimpan.",
      `Atribut yang tersedia. ${strictNote}`,
      vocabulary,
    ].join("\n"),
    inputSchema: jsonSchema(rememberToolSchema),
    execute: (raw) => {
      const body = pick(raw, ["source", "facts"]);
      const source = pick(body.source, ["content", "received_at"]);
      return remember(ctx, {
        scope,
        source: { ...source, meta: sourceMeta },
        facts: body.facts,
      });
    },
  };

  const recallTool: MemoryTool = {
    name: "memory_recall",
    description: [
      "Cari informasi di memori jangka panjang. Panggil sebelum menjawab hal yang mungkin pernah disampaikan pengguna (angka, preferensi, status, riwayat).",
      'Tulis `query` sebagai kata kunci isi (nama entitas dan istilah penting) TANPA kata tanya atau kata penghubung, dalam bahasa yang sama dengan data memori. Contoh: "anggaran PT Maju", bukan "Berapa anggaran PT Maju?". Pertahankan semua nama entitas dan kata kunci dari pertanyaan pengguna. Ganti sebuah kata dengan kata dari DESKRIPSI atribut di bawah (bagian setelah titik dua) HANYA bila maknanya sama persis; jangan menulis nama teknis atribut (mis. pain_point, decision_maker) karena itu tidak ada di teks memori. Contoh: "dana yang disiapkan PT Maju" menjadi "anggaran PT Maju". Bila hal yang ditanyakan tidak ada di daftar (mis. kompetitor, logo, jumlah karyawan), tulis apa adanya; JANGAN diganti atribut lain yang cuma berdekatan, dan JANGAN membuang bagian pertanyaan (mis. "perusahaan tempat Rina bekerja"). `as_of` (ISO 8601) menanyakan keadaan pada tanggal tertentu; tanpa itu hasilnya adalah kondisi terkini.',
      "Setiap hasil membawa `quote` dan `source` sebagai bukti, serta `valid_from`/`valid_to`.",
      "Jika `found` bernilai false, artinya memori TIDAK punya jawabannya: katakan kamu tidak tahu atau tanyakan ke pengguna. JANGAN menebak atau mengisi dari asumsi. Satu-satunya pengecualian: bila `query` tadi memakai kata di luar daftar atribut, boleh panggil sekali lagi dengan istilah dari daftar; bila tetap false, anggap memori tidak tahu.",
      "Atribut yang dikenal memori (pakai istilahnya saat menulis `query`):",
      vocabulary,
    ].join("\n"),
    inputSchema: jsonSchema(recallToolSchema),
    execute: (raw) =>
      recall(ctx, { ...pick(raw, ["query", "as_of", "limit"]), scope: readScopes ?? [scope] }),
  };

  const attributesTool: MemoryTool = {
    name: "memory_list_attributes",
    description:
      "Daftar atribut yang dikenal memori beserta tipe, kardinalitas, dan alias. Panggil bila ragu atribut mana yang dipakai untuk `memory_remember`.",
    inputSchema: jsonSchema(z.object({})),
    execute: async () => ({
      ok: true,
      vocabulary: ctx.registry.vocabulary,
      attributes: ctx.registry.all().map((a) => ({
        key: a.key,
        description: a.description,
        type: a.type,
        cardinality: a.cardinality,
        aliases: a.aliases,
      })),
    }),
  };

  return readOnly ? [recallTool, attributesTool] : [rememberTool, recallTool, attributesTool];
}
