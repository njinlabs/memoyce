import { type RecordId, RecordId as Rid } from "surrealdb";
import type { Ctx } from "./context";
import { newId } from "./ids";

export async function createSource(
  ctx: Ctx,
  input: {
    scope: string;
    content: string;
    meta?: Record<string, unknown>;
    receivedAt?: Date;
  },
): Promise<RecordId> {
  const row = await ctx.db.create<{ id: RecordId }>(new Rid("source", newId())).content({
    scope: input.scope,
    content: input.content,
    received_at: input.receivedAt ?? new Date(),
    meta: input.meta,
  });
  return row.id;
}

// Dengan `embedding`, entitas dan vektornya ditulis dalam satu transaksi.
export async function createEntity(
  ctx: Ctx,
  input: {
    scope: string;
    name: string;
    kind: string;
    aliases?: string[];
    embedding?: number[];
  },
): Promise<RecordId> {
  const id = new Rid("entity", newId());
  const content = {
    scope: input.scope,
    name: input.name,
    kind: input.kind,
    aliases: input.aliases ?? [],
  };

  if (input.embedding && ctx.vectors) {
    const table = await ctx.vectors.ensure("evec", input.scope);
    await ctx.db
      .query(
        `BEGIN;
         CREATE ONLY $id CONTENT $content;
         CREATE type::record($table, record::id($id))
           SET ref = $id, scope = $scope, embedding = $embedding;
         COMMIT;`,
        { id, content, table, scope: input.scope, embedding: input.embedding },
      )
      .collect();
    return id;
  }

  const row = await ctx.db.create<{ id: RecordId }>(id).content(content);
  return row.id;
}
