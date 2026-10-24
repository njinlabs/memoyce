import { type RecordId, RecordId as Rid } from "surrealdb";
import type { Ctx } from "./context";

export async function createSource(
  ctx: Ctx,
  input: {
    scope: string;
    content: string;
    meta?: Record<string, unknown>;
    receivedAt?: Date;
  },
): Promise<RecordId> {
  const row = await ctx.db
    .create<{ id: RecordId }>(new Rid("source", crypto.randomUUID()))
    .content({
      scope: input.scope,
      content: input.content,
      received_at: input.receivedAt ?? new Date(),
      meta: input.meta,
    });
  return row.id;
}

export async function createEntity(
  ctx: Ctx,
  input: { scope: string; name: string; kind: string; aliases?: string[] },
): Promise<RecordId> {
  const row = await ctx.db
    .create<{ id: RecordId }>(new Rid("entity", crypto.randomUUID()))
    .content({
      scope: input.scope,
      name: input.name,
      kind: input.kind,
      aliases: input.aliases ?? [],
    });
  return row.id;
}
