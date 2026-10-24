import { RecordId } from "surrealdb";
import type { Ctx } from "./context";
import { embedTexts } from "./embedder";
import { MemoryError } from "./errors";
import { displayValue, renderFactText } from "./text";

const PAGE = 256;

interface EntityRow {
  id: RecordId;
  scope: string;
  name: string;
}

interface FactRow {
  id: RecordId;
  scope: string;
  attribute: string;
  value: unknown;
  quote?: string;
  text?: string;
  valid_from: unknown;
  valid_to?: unknown;
  entity_name: string;
}

function requireVectors(ctx: Ctx) {
  if (!ctx.embedder || !ctx.vectors) {
    throw new MemoryError("embedder", "tidak ada embedder yang dikonfigurasi");
  }
  return { embedder: ctx.embedder, vectors: ctx.vectors };
}

async function writeMeta(ctx: Ctx): Promise<void> {
  const { embedder } = requireVectors(ctx);
  await ctx.db
    .query(
      "UPSERT meta:embedding SET model = $model, dimension = $dimension, updated_at = time::now()",
      { model: embedder.model, dimension: embedder.dimension },
    )
    .collect();
}

// Memastikan embedder yang dipakai sama dengan yang tercatat di DB. Vektor model berbeda tidak
// boleh bercampur dalam satu index, dan vektor tidak ada untuk data yang ditulis sebelum
// embedder dipasang.
export async function checkEmbedding(ctx: Ctx, mode: "error" | "reindex"): Promise<void> {
  const { embedder } = requireVectors(ctx);
  const [recorded] = await ctx.db
    .query<[{ model: string; dimension: number } | undefined]>(
      "SELECT model, dimension FROM ONLY meta:embedding",
    )
    .collect();

  if (recorded) {
    if (recorded.model === embedder.model && recorded.dimension === embedder.dimension) return;
  } else {
    const [existing] = await ctx.db.query<[unknown[]]>("SELECT id FROM fact LIMIT 1").collect();
    if (!existing || existing.length === 0) return writeMeta(ctx);
  }

  if (mode === "reindex") {
    await reindex(ctx);
    return;
  }
  throw new MemoryError(
    "embedder_mismatch",
    recorded
      ? `database memakai embedding ${recorded.model} (${recorded.dimension}d), embedder sekarang ${embedder.model} (${embedder.dimension}d); jalankan reindex (onEmbedderChange: "reindex")`
      : 'data lama belum punya vektor; jalankan reindex (onEmbedderChange: "reindex")',
    { recorded, configured: { model: embedder.model, dimension: embedder.dimension } },
  );
}

async function dropPartitions(ctx: Ctx): Promise<void> {
  const [info] = await ctx.db.query<[{ tables: Record<string, string> }]>("INFO FOR DB").collect();
  const tables = Object.keys(info?.tables ?? {}).filter((t) => /^[fe]vec_[0-9a-f]{16}$/.test(t));
  for (const table of tables) await ctx.db.query(`REMOVE TABLE IF EXISTS ${table}`).collect();
  ctx.vectors?.reset();
}

// Membangun ulang seluruh vektor (fakta dan entitas) dari data yang ada, dan mengisi `text`
// fakta yang belum punya. Aman dijalankan ulang. Vektor adalah data turunan: tidak ada fakta
// yang disentuh selain `text`.
export async function reindex(ctx: Ctx): Promise<{ entities: number; facts: number }> {
  const { embedder, vectors } = requireVectors(ctx);
  await dropPartitions(ctx);

  let entities = 0;
  for (let last: RecordId | undefined; ; ) {
    const [rows = []] = await ctx.db
      .query<[EntityRow[]]>(
        "SELECT id, scope, name FROM entity WHERE $last = NONE OR id > $last ORDER BY id LIMIT $n",
        { last, n: PAGE },
      )
      .collect();
    if (rows.length === 0) break;
    const embeddings = await embedTexts(
      embedder,
      rows.map((r) => r.name),
      "document",
    );
    for (const [i, row] of rows.entries()) {
      const table = await vectors.ensure("evec", row.scope);
      await ctx.db
        .query(
          "CREATE type::record($table, record::id($id)) SET ref = $id, scope = $scope, embedding = $embedding",
          { table, id: row.id, scope: row.scope, embedding: embeddings[i] },
        )
        .collect();
    }
    entities += rows.length;
    last = rows.at(-1)?.id;
  }

  let facts = 0;
  for (let last: RecordId | undefined; ; ) {
    const [rows = []] = await ctx.db
      .query<[FactRow[]]>(
        `SELECT id, scope, attribute, value, quote, text, valid_from, valid_to,
                entity.name AS entity_name
         FROM fact WHERE $last = NONE OR id > $last ORDER BY id LIMIT $n`,
        { last, n: PAGE },
      )
      .collect();
    if (rows.length === 0) break;

    const refIds = rows.map((r) => r.value).filter((v): v is RecordId => v instanceof RecordId);
    const names = new Map<string, string>();
    if (refIds.length > 0) {
      const [named = []] = await ctx.db
        .query<[{ id: RecordId; name: string }[]]>("SELECT id, name FROM entity WHERE id IN $ids", {
          ids: refIds,
        })
        .collect();
      for (const n of named) names.set(n.id.toString(), n.name);
    }

    const texts = rows.map((row) => {
      if (row.text) return row.text;
      const label = ctx.registry.all().find((a) => a.key === row.attribute)?.description;
      const refName = row.value instanceof RecordId ? names.get(row.value.toString()) : undefined;
      return renderFactText({
        entity: row.entity_name,
        attribute: { description: label ?? row.attribute },
        value: displayValue(row.value, refName),
        quote: row.quote,
      });
    });
    for (const [i, row] of rows.entries()) {
      if (!row.text) {
        await ctx.db.query("UPDATE $id SET text = $text", { id: row.id, text: texts[i] }).collect();
      }
    }

    const embeddings = await embedTexts(embedder, texts, "document");
    for (const [i, row] of rows.entries()) {
      const table = await vectors.ensure("fvec", row.scope);
      await ctx.db
        .query(
          `CREATE type::record($table, record::id($id)) SET ref = $id, scope = $scope,
             embedding = $embedding, valid_from = $valid_from, valid_to = $valid_to`,
          {
            table,
            id: row.id,
            scope: row.scope,
            embedding: embeddings[i],
            valid_from: row.valid_from,
            valid_to: row.valid_to,
          },
        )
        .collect();
    }
    facts += rows.length;
    last = rows.at(-1)?.id;
  }

  await writeMeta(ctx);
  return { entities, facts };
}
