import type { SurrealSession } from "surrealdb";
import { MemoryError } from "./errors";

export interface Migration {
  version: number;
  // SurrealQL idempoten (DEFINE ... IF NOT EXISTS). Perubahan harus aditif bila mungkin.
  up: string;
}

// Hanya boleh ditambah di akhir. Migrasi yang sudah dirilis tidak boleh diubah.
export const migrations: Migration[] = [
  {
    version: 1,
    up: `
      DEFINE TABLE IF NOT EXISTS source SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS scope ON source TYPE string ASSERT string::len($value) > 0;
      DEFINE FIELD IF NOT EXISTS content ON source TYPE string ASSERT string::len($value) > 0;
      DEFINE FIELD IF NOT EXISTS received_at ON source TYPE datetime DEFAULT time::now();
      DEFINE FIELD IF NOT EXISTS meta ON source TYPE option<object> FLEXIBLE;
      DEFINE INDEX IF NOT EXISTS source_scope ON source FIELDS scope, received_at;

      DEFINE TABLE IF NOT EXISTS entity SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS scope ON entity TYPE string ASSERT string::len($value) > 0;
      DEFINE FIELD IF NOT EXISTS name ON entity TYPE string ASSERT string::len($value) > 0;
      DEFINE FIELD IF NOT EXISTS kind ON entity TYPE string;
      DEFINE FIELD IF NOT EXISTS aliases ON entity TYPE array<string> DEFAULT [];
      DEFINE FIELD IF NOT EXISTS embedding ON entity TYPE option<array<float>>;
      DEFINE FIELD IF NOT EXISTS created_at ON entity TYPE datetime DEFAULT time::now();
      DEFINE INDEX IF NOT EXISTS entity_scope_name ON entity FIELDS scope, name;

      DEFINE TABLE IF NOT EXISTS attribute SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS description ON attribute TYPE string;
      DEFINE FIELD IF NOT EXISTS type ON attribute TYPE string;
      DEFINE FIELD IF NOT EXISTS cardinality ON attribute TYPE string;
      DEFINE FIELD IF NOT EXISTS aliases ON attribute TYPE array<string>;
      DEFINE FIELD IF NOT EXISTS active ON attribute TYPE bool;

      DEFINE TABLE IF NOT EXISTS fact SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS scope ON fact TYPE string ASSERT string::len($value) > 0;
      DEFINE FIELD IF NOT EXISTS entity ON fact TYPE record<entity>
        ASSERT $value.scope = $this.scope;
      DEFINE FIELD IF NOT EXISTS attribute ON fact TYPE string ASSERT string::len($value) > 0;
      DEFINE FIELD IF NOT EXISTS value ON fact TYPE any ASSERT $value != NONE AND $value != NULL;
      DEFINE FIELD IF NOT EXISTS valid_from ON fact TYPE datetime;
      DEFINE FIELD IF NOT EXISTS valid_to ON fact TYPE option<datetime>
        ASSERT $value = NONE OR $value >= $this.valid_from;
      DEFINE FIELD IF NOT EXISTS source ON fact TYPE record<source>
        ASSERT $value.scope = $this.scope;
      DEFINE FIELD IF NOT EXISTS created_at ON fact TYPE datetime DEFAULT time::now();
      DEFINE INDEX IF NOT EXISTS fact_current ON fact FIELDS scope, entity, attribute, valid_to;
    `,
  },
];

export const latestVersion = (): number => migrations.at(-1)?.version ?? 0;

export async function currentVersion(db: SurrealSession): Promise<number> {
  await db.query("DEFINE TABLE IF NOT EXISTS meta SCHEMALESS");
  const [row] = await db
    .query<[{ version: number } | undefined]>("SELECT version FROM ONLY meta:schema")
    .collect();
  return row?.version ?? 0;
}

export type MigrateMode = "auto" | "check" | "off";

export async function migrate(db: SurrealSession, mode: MigrateMode): Promise<void> {
  if (mode === "off") return;

  const version = await currentVersion(db);
  if (version > latestVersion()) {
    throw new MemoryError(
      "migration",
      `database versi ${version} lebih baru dari library (versi ${latestVersion()}); perbarui library`,
      { version, latestVersion: latestVersion() },
    );
  }
  if (version === latestVersion()) return;
  if (mode === "check") {
    throw new MemoryError(
      "migration",
      `database versi ${version} belum dimigrasi ke versi ${latestVersion()}`,
      { version, latestVersion: latestVersion() },
    );
  }

  for (const migration of migrations.filter((m) => m.version > version)) {
    try {
      await db.query(
        `BEGIN;
         ${migration.up}
         UPSERT meta:schema SET version = $version, updated_at = time::now();
         COMMIT;`,
        { version: migration.version },
      );
    } catch (cause) {
      throw new MemoryError("migration", `migrasi ke versi ${migration.version} gagal`, {
        version: migration.version,
        cause: String(cause),
      });
    }
  }
}
