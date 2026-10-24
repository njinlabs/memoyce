import type { DateTime, RecordId } from "surrealdb";
import { z } from "zod";
import type { Ctx } from "./context";
import { type EntityRefInfo, type FactDetail, loadFacts, recall } from "./recall";
import type { RememberError } from "./remember";
import { isoTime } from "./schemas";

const DEFAULT_QUERY_LIMIT = 8;
const DEFAULT_BRIEFING_LIMIT = 20;

export const contextSchema = z.object({
  scope: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]),
  // Tanpa query: briefing fakta terbaru. Dengan query: fakta yang relevan dengannya.
  query: z.string().trim().min(1).max(2000).optional(),
  as_of: isoTime.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  // Sertakan kutipan sumber pada setiap baris teks (lebih panjang, lebih berbukti).
  quotes: z.boolean().default(false),
});

export type ContextInput = z.input<typeof contextSchema>;

export type ContextResult =
  | {
      ok: true;
      // false bila memori kosong (tanpa query) atau tidak punya jawaban (dengan query).
      found: boolean;
      as_of: string;
      // Blok teks ringkas siap disuntik ke prompt (system prompt atau pesan awal).
      text: string;
      // Bukti terstruktur di balik teks; dengan query, berupa RecallItem lengkap dengan skor.
      items: FactDetail[];
      entities: EntityRefInfo[];
    }
  | { ok: false; errors: RememberError[] };

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(display).join(", ");
  if (typeof value === "object" && value !== null) {
    const ref = value as { id?: unknown; name?: unknown };
    if (typeof ref.id === "string") return typeof ref.name === "string" ? ref.name : ref.id;
    return JSON.stringify(value);
  }
  return String(value);
}

function format(
  ctx: Ctx,
  items: FactDetail[],
  header: string,
  empty: string,
  quotes: boolean,
): { text: string; entities: EntityRefInfo[] } {
  if (items.length === 0) return { text: empty, entities: [] };

  const groups = new Map<string, { entity: EntityRefInfo; lines: string[] }>();
  for (const item of items) {
    let group = groups.get(item.entity.id);
    if (!group) {
      group = { entity: item.entity, lines: [] };
      groups.set(item.entity.id, group);
    }
    const description = ctx.registry.all().find((a) => a.key === item.attribute)?.description;
    // Deskripsi bisa memuat daftar nilai dalam kurung; untuk teks ringkas cukup bagian depannya.
    const label = (description ?? item.attribute).split(" (")[0];
    const quote = quotes && item.quote ? ` — "${item.quote}"` : "";
    group.lines.push(
      `- ${label}: ${display(item.value)}, sejak ${item.valid_from.slice(0, 10)}${quote}`,
    );
  }

  const body = [...groups.values()].map(
    (g) => `${g.entity.name} (${g.entity.kind})\n${g.lines.join("\n")}`,
  );
  return {
    text: [header, ...body].join("\n"),
    entities: [...groups.values()].map((g) => g.entity),
  };
}

// Konteks siap pakai untuk AI stateless atau awal sesi baru, tanpa AI perlu memanggil tool.
//   - Tanpa `query`: briefing "apa yang kita ketahui sekarang", fakta berlaku terbaru lebih dulu.
//     Ini yang memungkinkan AI berinisiatif (menyapa dengan rekap) tanpa menunggu pertanyaan.
//   - Dengan `query`: fakta relevan (sama seperti recall), dalam bentuk teks ringkas.
// Hasilnya selalu menyatakan dengan tegas bila memori kosong atau tidak punya jawaban.
export async function memoryContext(ctx: Ctx, raw: unknown): Promise<ContextResult> {
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "invalid_input" as const,
        message: `${issue.path.join(".") || "input"}: ${issue.message}`,
        details: { path: issue.path },
      })),
    };
  }
  const input = parsed.data;
  const scopes = Array.isArray(input.scope) ? input.scope : [input.scope];
  const asOf = input.as_of ? new Date(input.as_of) : new Date();
  const date = asOf.toISOString().slice(0, 10);

  if (input.query) {
    const result = await recall(ctx, {
      scope: input.scope,
      query: input.query,
      as_of: input.as_of,
      limit: input.limit ?? DEFAULT_QUERY_LIMIT,
    });
    if (!result.ok) return result;
    const { text, entities } = format(
      ctx,
      result.items,
      `Memori jangka panjang yang relevan (keadaan per ${date}):`,
      `Memori jangka panjang: tidak ada informasi yang relevan dengan "${input.query}". Jangan menebak.`,
      input.quotes,
    );
    return {
      ok: true,
      found: result.found,
      as_of: result.as_of,
      text,
      items: result.items,
      entities: entities.length > 0 ? entities : result.linked_entities,
    };
  }

  const limit = input.limit ?? DEFAULT_BRIEFING_LIMIT;
  const perScope = await Promise.all(
    scopes.map(async (scope) => {
      const [rows = []] = await ctx.db
        .query<[{ id: RecordId; valid_from: DateTime }[]]>(
          `SELECT id, valid_from FROM fact
           WHERE scope = $scope AND valid_from <= $asOf AND (valid_to = NONE OR valid_to > $asOf)
           ORDER BY valid_from DESC LIMIT $limit`,
          { scope, asOf, limit },
        )
        .collect();
      return rows;
    }),
  );
  const newest = perScope
    .flat()
    .sort((a, b) => b.valid_from.toDate().getTime() - a.valid_from.toDate().getTime())
    .slice(0, limit);
  const details = await loadFacts(
    ctx,
    newest.map((r) => r.id),
    scopes,
  );
  const items = newest
    .map((r) => details.get(r.id.toString()))
    .filter((d): d is FactDetail => d !== undefined);

  const { text, entities } = format(
    ctx,
    items,
    `Memori jangka panjang (keadaan per ${date}, yang terbaru lebih dulu):`,
    "Memori jangka panjang: belum ada informasi yang tersimpan.",
    input.quotes,
  );
  return { ok: true, found: items.length > 0, as_of: asOf.toISOString(), text, items, entities };
}
