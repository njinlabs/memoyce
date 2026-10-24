import { DateTime, RecordId } from "surrealdb";
import { z } from "zod";
import type { Ctx } from "./context";
import { embedTexts } from "./embedder";
import { idToString } from "./ids";
import type { RememberError } from "./remember";
import { isoTime } from "./schemas";
import { contentTerms, tokenize } from "./text";

const DEFAULT_LIMIT = 8;
const RRF_K = 60;
// Bobot kanal pada fusi. Graf lebih kecil: ia memperluas kandidat, bukan bukti isi.
const WEIGHT = { vector: 1, keyword: 1, graph: 0.5 } as const;
const MAX_NGRAM = 4;
const MAX_ANN = 2000;
const GRAPH_CAP = 200;

export const recallSchema = z.object({
  scope: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]),
  query: z.string().trim().min(1).max(2000),
  as_of: isoTime.optional(),
  limit: z.number().int().min(1).max(50).default(DEFAULT_LIMIT),
  // Mengganti ambang bawaan dari opsi retrieval untuk panggilan ini.
  min_similarity: z.number().min(-1).max(1).optional(),
  min_keyword_coverage: z.number().min(0).max(1).optional(),
});

export type RecallInput = z.input<typeof recallSchema>;

export interface EntityRefInfo {
  id: string;
  name: string;
  kind: string;
}

export interface RecallItem {
  fact: string;
  scope: string;
  entity: EntityRefInfo;
  attribute: string;
  value: unknown;
  text: string;
  quote?: string;
  valid_from: string;
  valid_to?: string;
  source: { id: string; received_at: string };
  score: number;
  // Bukti per kanal: kemiripan kosinus, porsi istilah query yang ada di teks fakta (0..1), dan
  // hubungan dengan entitas yang disebut.
  signals: { vector?: number; keyword?: number; entity?: "direct" | "related" };
}

export type RecallResult =
  | {
      ok: true;
      found: boolean;
      as_of: string;
      items: RecallItem[];
      linked_entities: EntityRefInfo[];
      message?: string;
    }
  | { ok: false; errors: RememberError[] };

interface Candidate {
  id: RecordId;
  scope?: string;
  vector?: number;
  // Porsi istilah query yang ditemukan di teks fakta, dan skor BM25 (hanya untuk peringkat:
  // pada korpus kecil skor BM25 bisa 0 walau kata cocok persis).
  keyword?: number;
  bm25?: number;
  entity?: "direct" | "related";
  graphRank?: number;
}

interface EntityRow {
  id: RecordId;
  name: string;
  kind: string;
  scope: string;
}

const key = (id: RecordId): string => id.toString();

// n-gram kata (1..4) dari query, untuk mencocokkan nama/alias entitas secara persis.
function ngrams(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let size = 1; size <= MAX_NGRAM; size++) {
    for (let i = 0; i + size <= words.length; i++) grams.add(words.slice(i, i + size).join(" "));
  }
  return [...grams].slice(0, 300);
}

function jsonValue(value: unknown, names: Map<string, string>): unknown {
  if (value instanceof DateTime) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) {
    return { id: idToString(value), name: names.get(key(value)) };
  }
  if (Array.isArray(value)) return value.map((v) => jsonValue(v, names));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v, names)]));
  }
  return value;
}

const iso = (value: unknown): string =>
  value instanceof DateTime ? value.toDate().toISOString() : String(value);

// Mencari memori yang relevan dengan `query` lewat tiga kanal yang digabung:
//   vektor (makna), BM25 (kata kunci), dan graf (fakta milik/berelasi dengan entitas yang disebut).
// Hasil digabung dengan RRF. Skor RRF berbasis peringkat sehingga selalu menghasilkan sesuatu;
// yang menentukan "tahu atau tidak" adalah ambang absolut pada kemiripan dan skor BM25. Fakta
// yang hanya terhubung lewat entitas tanpa bukti isi TIDAK dikembalikan.
export async function recall(ctx: Ctx, raw: unknown): Promise<RecallResult> {
  const parsed = recallSchema.safeParse(raw);
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
  const minSimilarity = input.min_similarity ?? ctx.retrieval.minSimilarity;
  const minKeyword = input.min_keyword_coverage ?? ctx.retrieval.minKeywordCoverage;
  const queryTerms = contentTerms(input.query);
  const { limit } = input;

  const queryVector =
    ctx.embedder && ctx.vectors
      ? (await embedTexts(ctx.embedder, [input.query], "query"))[0]
      : undefined;

  const candidates = new Map<string, Candidate>();
  const upsert = (id: RecordId, scope?: string): Candidate => {
    let candidate = candidates.get(key(id));
    if (!candidate) {
      candidate = { id, scope };
      candidates.set(key(id), candidate);
    }
    return candidate;
  };

  // --- Entitas yang disebut di query: nama/alias persis, dan kemiripan makna ---
  const linked = new Map<string, EntityRow>();
  const [named = []] = await ctx.db
    .query<[EntityRow[]]>(
      "SELECT id, name, kind, scope FROM entity WHERE scope IN $scopes AND keys CONTAINSANY $grams LIMIT 50",
      { scopes, grams: ngrams(input.query) },
    )
    .collect();
  for (const entity of named) linked.set(key(entity.id), entity);

  if (queryVector && ctx.vectors) {
    for (const scope of scopes) {
      const table = await ctx.vectors.ensure("evec", scope);
      const [near = []] = await ctx.db
        .query<[{ ref: RecordId; d: number }[]]>(
          `SELECT ref, vector::distance::knn() AS d FROM type::table($table)
           WHERE embedding <|5,64|> $vector`,
          { table, vector: queryVector },
        )
        .collect();
      const ids = near.filter((n) => 1 - n.d >= minSimilarity).map((n) => n.ref);
      if (ids.length === 0) continue;
      const [rows = []] = await ctx.db
        .query<[EntityRow[]]>("SELECT id, name, kind, scope FROM entity WHERE id IN $ids", { ids })
        .collect();
      for (const entity of rows) linked.set(key(entity.id), entity);
    }
  }

  // --- Kanal graf: fakta entitas yang disebut, dan fakta yang berelasi dengannya ---
  const linkedIds = [...linked.values()].map((e) => e.id);
  if (linkedIds.length > 0) {
    const validity = "valid_from <= $asOf AND (valid_to = NONE OR valid_to > $asOf)";
    const [direct = []] = await ctx.db
      .query<[{ id: RecordId; value: unknown; scope: string }[]]>(
        `SELECT id, value, scope FROM fact
         WHERE scope IN $scopes AND entity IN $entities AND ${validity}
         ORDER BY valid_from DESC LIMIT ${GRAPH_CAP}`,
        { scopes, entities: linkedIds, asOf },
      )
      .collect();
    let rank = 0;
    for (const row of direct) {
      const c = upsert(row.id, row.scope);
      c.entity = "direct";
      c.graphRank = rank++;
    }
    // Hubungan satu lompatan: fakta yang menunjuk ke entitas yang disebut, dan fakta milik
    // entitas yang ditunjuk fakta-fakta langsungnya.
    const referenced = direct
      .map((d) => d.value)
      .filter((v): v is RecordId => v instanceof RecordId);
    const [related = []] = await ctx.db
      .query<[{ id: RecordId; scope: string }[]]>(
        `SELECT id, scope FROM fact
         WHERE scope IN $scopes AND (value IN $entities OR entity IN $referenced) AND ${validity}
         ORDER BY valid_from DESC LIMIT ${GRAPH_CAP}`,
        { scopes, entities: linkedIds, referenced, asOf },
      )
      .collect();
    for (const row of related) {
      const c = upsert(row.id, row.scope);
      if (!c.entity) {
        c.entity = "related";
        c.graphRank = rank++;
      }
    }
  }

  // --- Kanal vektor: ANN tanpa filter di dalam partisi scope, validitas disaring sesudahnya ---
  if (queryVector && ctx.vectors) {
    for (const scope of scopes) {
      const table = await ctx.vectors.ensure("fvec", scope);
      let k = Math.max(limit * 8, 50);
      for (;;) {
        const ef = Math.max(k * 2, 100);
        const [near = []] = await ctx.db
          .query<[{ ref: RecordId; d: number; valid_from: DateTime; valid_to?: DateTime }[]]>(
            `SELECT ref, valid_from, valid_to, vector::distance::knn() AS d
             FROM type::table($table) WHERE embedding <|${k},${ef}|> $vector`,
            { table, vector: queryVector },
          )
          .collect();
        const valid = near.filter(
          (n) => n.valid_from.toDate() <= asOf && (!n.valid_to || n.valid_to.toDate() > asOf),
        );
        for (const n of valid) upsert(n.ref, scope).vector = 1 - n.d;
        if (valid.length >= limit * 2 || near.length < k || k >= MAX_ANN) break;
        k *= 4;
      }

      // Kandidat graf yang lolos dari ANN tetap dinilai kemiripannya (lookup langsung per id).
      const missing = [...candidates.values()].filter(
        (c) => c.scope === scope && c.vector === undefined && c.entity,
      );
      if (missing.length > 0) {
        const records = missing.map((c) => new RecordId(table, String(c.id.id)));
        const [sims = []] = await ctx.db
          .query<[{ ref: RecordId; sim: number }[]]>(
            "SELECT ref, vector::similarity::cosine(embedding, $vector) AS sim FROM $records",
            { records, vector: queryVector },
          )
          .collect();
        for (const s of sims) {
          const c = candidates.get(key(s.ref));
          if (c) c.vector = s.sim;
        }
      }
    }
  }

  // --- Kanal kata kunci: BM25 dengan semantik OR pada kalimat fakta ---
  const [keyword = []] = await ctx.db
    .query<[{ id: RecordId; scope: string; text: string; s: number }[]]>(
      `SELECT id, scope, text, search::score(0) AS s FROM fact
       WHERE scope IN $scopes AND text @0,OR@ $query
         AND valid_from <= $asOf AND (valid_to = NONE OR valid_to > $asOf)
       ORDER BY s DESC LIMIT ${Math.max(limit * 5, 50)}`,
      { scopes, query: input.query, asOf },
    )
    .collect();
  for (const row of keyword) {
    const words = new Set(tokenize(row.text));
    const candidate = upsert(row.id, row.scope);
    candidate.bm25 = row.s;
    candidate.keyword = queryTerms.filter((term) => words.has(term)).length / queryTerms.length;
  }

  // --- Fusi (RRF) dan ambang bukti ---
  const all = [...candidates.values()];
  const ranked = (pick: (c: Candidate) => number | undefined, order: 1 | -1) => {
    const list = all
      .filter((c) => pick(c) !== undefined)
      .sort((a, b) => order * ((pick(a) as number) - (pick(b) as number)));
    return new Map(list.map((c, i) => [key(c.id), i]));
  };
  const vectorRank = ranked((c) => c.vector, -1);
  // Peringkat kata kunci: cakupan istilah dulu, BM25 sebagai pemisah (skor kecil diperhitungkan).
  const keywordRank = ranked(
    (c) => (c.keyword === undefined ? undefined : c.keyword * 1000 + (c.bm25 ?? 0)),
    -1,
  );
  const graphRank = ranked((c) => c.graphRank, 1);
  const fused = (c: Candidate): number => {
    const part = (rank: number | undefined, weight: number) =>
      rank === undefined ? 0 : weight / (RRF_K + rank + 1);
    return (
      part(vectorRank.get(key(c.id)), WEIGHT.vector) +
      part(keywordRank.get(key(c.id)), WEIGHT.keyword) +
      part(graphRank.get(key(c.id)), WEIGHT.graph)
    );
  };

  const supported = all
    .filter(
      (c) =>
        (c.vector !== undefined && c.vector >= minSimilarity) ||
        (c.keyword !== undefined && c.keyword >= minKeyword),
    )
    .sort((a, b) => fused(b) - fused(a))
    .slice(0, limit);

  const linkedInfo: EntityRefInfo[] = [...linked.values()].map((e) => ({
    id: idToString(e.id),
    name: e.name,
    kind: e.kind,
  }));

  const notFound = (): RecallResult => {
    const known =
      linkedInfo.length > 0 ? ` Entitas dikenal: ${linkedInfo.map((e) => e.name).join(", ")}.` : "";
    return {
      ok: true,
      found: false,
      as_of: asOf.toISOString(),
      items: [],
      linked_entities: linkedInfo,
      message: `Tidak ada memori yang relevan dengan pertanyaan ini.${known} Jangan menebak.`,
    };
  };
  if (supported.length === 0) return notFound();

  // --- Ambil detail hanya untuk hasil akhir ---
  const [rows = []] = await ctx.db
    .query<
      [
        {
          id: RecordId;
          scope: string;
          attribute: string;
          value: unknown;
          text?: string;
          quote?: string;
          valid_from: DateTime;
          valid_to?: DateTime;
          entity: RecordId;
          entity_name: string;
          entity_kind: string;
          source: RecordId;
          received_at: DateTime;
        }[],
      ]
    >(
      `SELECT id, scope, attribute, value, text, quote, valid_from, valid_to, entity, source,
              entity.name AS entity_name, entity.kind AS entity_kind,
              source.received_at AS received_at
       FROM fact WHERE id IN $ids AND scope IN $scopes`,
      { ids: supported.map((c) => c.id), scopes },
    )
    .collect();
  const byId = new Map(rows.map((r) => [key(r.id), r]));

  const refIds = rows.map((r) => r.value).filter((v): v is RecordId => v instanceof RecordId);
  const names = new Map<string, string>();
  if (refIds.length > 0) {
    const [named2 = []] = await ctx.db
      .query<[{ id: RecordId; name: string }[]]>("SELECT id, name FROM entity WHERE id IN $ids", {
        ids: refIds,
      })
      .collect();
    for (const n of named2) names.set(key(n.id), n.name);
  }

  const items: RecallItem[] = [];
  for (const candidate of supported) {
    const row = byId.get(key(candidate.id));
    if (!row) continue;
    items.push({
      fact: idToString(row.id),
      scope: row.scope,
      entity: { id: idToString(row.entity), name: row.entity_name, kind: row.entity_kind },
      attribute: row.attribute,
      value: jsonValue(row.value, names),
      text: row.text ?? "",
      quote: row.quote,
      valid_from: iso(row.valid_from),
      valid_to: row.valid_to ? iso(row.valid_to) : undefined,
      source: { id: idToString(row.source), received_at: iso(row.received_at) },
      score: fused(candidate),
      signals: {
        vector: candidate.vector,
        keyword: candidate.keyword,
        entity: candidate.entity,
      },
    });
  }

  // Fakta bisa hilang dari DB di antara dua query (mis. permintaan privasi): perlakukan sebagai tidak tahu.
  if (items.length === 0) return notFound();
  return { ok: true, found: true, as_of: asOf.toISOString(), items, linked_entities: linkedInfo };
}
