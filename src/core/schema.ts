import { db } from "./db";

// Idempoten: aman dijalankan setiap start.
// Indeks vektor belum didefinisikan: dimensi bergantung pada model embedding.
const schema = `
DEFINE TABLE IF NOT EXISTS source SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content ON source TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS received_at ON source TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS meta ON source TYPE option<object> FLEXIBLE;

DEFINE TABLE IF NOT EXISTS entity SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON entity TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS kind ON entity TYPE string;
DEFINE FIELD IF NOT EXISTS aliases ON entity TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS embedding ON entity TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS created_at ON entity TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS fact SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS entity ON fact TYPE record<entity>;
DEFINE FIELD IF NOT EXISTS attribute ON fact TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS value ON fact TYPE any ASSERT $value != NONE AND $value != NULL;
DEFINE FIELD IF NOT EXISTS valid_from ON fact TYPE datetime;
DEFINE FIELD IF NOT EXISTS valid_to ON fact TYPE option<datetime>
  ASSERT $value = NONE OR $value >= $this.valid_from;
DEFINE FIELD IF NOT EXISTS source ON fact TYPE record<source>;
DEFINE FIELD IF NOT EXISTS created_at ON fact TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS fact_current ON fact FIELDS entity, attribute, valid_to;

DEFINE TABLE IF NOT EXISTS relates TYPE RELATION IN entity OUT entity SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS relation ON relates TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS valid_from ON relates TYPE datetime;
DEFINE FIELD IF NOT EXISTS valid_to ON relates TYPE option<datetime>
  ASSERT $value = NONE OR $value >= $this.valid_from;
DEFINE FIELD IF NOT EXISTS source ON relates TYPE record<source>;
`;

export async function applySchema(): Promise<void> {
  await db.query(schema);
}
