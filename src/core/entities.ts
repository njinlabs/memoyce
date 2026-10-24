import type { RecordId } from "surrealdb";
import type { Ctx } from "./context";

// Harus identik dengan ekspresi `keys` di migrasi v2 (trim + huruf kecil).
export function entityKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface EntityMatch {
  id: RecordId;
  name: string;
  kind: string;
}

// Entitas di scope ini yang nama atau aliasnya sama (tanpa membedakan huruf besar/kecil).
export async function findEntities(ctx: Ctx, scope: string, name: string): Promise<EntityMatch[]> {
  const [rows] = await ctx.db
    .query<[EntityMatch[]]>(
      "SELECT id, name, kind FROM entity WHERE scope = $scope AND keys CONTAINS $key",
      { scope, key: entityKey(name) },
    )
    .collect();
  return rows ?? [];
}

export async function getEntity(
  ctx: Ctx,
  id: RecordId,
): Promise<(EntityMatch & { scope: string }) | undefined> {
  const [row] = await ctx.db
    .query<[(EntityMatch & { scope: string }) | undefined]>(
      "SELECT id, name, kind, scope FROM ONLY $id",
      { id },
    )
    .collect();
  return row ?? undefined;
}
