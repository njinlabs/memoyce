import type { RecordId } from "surrealdb";
import { z } from "zod";
import { type Attribute, checkValue } from "./attributes.ts";
import type { Ctx } from "./context.ts";
import { embedTexts } from "./embedder.ts";
import { type EntityMatch, entityKey, findEntities, getEntity } from "./entities.ts";
import { MemoryError, type MemoryErrorCode } from "./errors.ts";
import { assertFact, type FactStatus } from "./fact.ts";
import { idToString, parseId } from "./ids.ts";
import { createEntity, createSource } from "./records.ts";
import { isoTime } from "./schemas.ts";
import { displayValue, renderFactText } from "./text.ts";

const MAX_FACTS = 100;
const MIN_QUOTE = 3;
const DEFAULT_KIND = "unknown";

const entityRef = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), kind: z.string().min(1).optional() }),
  z.object({ id: z.string().min(1) }),
]);

export const rememberSchema = z.object({
  scope: z.string().min(1),
  source: z.object({
    content: z.string().min(1).describe("Teks asal persis seperti diterima"),
    meta: z.record(z.string(), z.unknown()).optional(),
    received_at: isoTime.optional(),
  }),
  facts: z
    .array(
      z.object({
        entity: entityRef.describe(
          "Subjek fakta: nama, { name, kind } (kind mis. person/organization), atau { id } dari hasil sebelumnya",
        ),
        attribute: z.string().min(1).describe("Salah satu atribut yang tersedia (atau aliasnya)"),
        value: z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.unknown()),
          z.record(z.string(), z.unknown()),
        ]),
        quote: z
          .string()
          .min(1)
          .describe(
            "Kutipan persis dari source.content yang mendukung fakta ini (min. 3 karakter)",
          ),
        valid_from: isoTime
          .optional()
          .describe(
            "Sejak kapan fakta berlaku, bila disebut di teks; default: waktu teks diterima",
          ),
      }),
    )
    .min(1)
    .max(MAX_FACTS),
});

export type RememberInput = z.input<typeof rememberSchema>;

export interface RememberError {
  index?: number;
  code: MemoryErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export interface EntityInfo {
  id: string;
  name: string;
  kind: string;
  created: boolean;
}

export type FactResult =
  | {
      index: number;
      ok: true;
      status: FactStatus;
      fact: string;
      entity: EntityInfo;
      attribute: string;
    }
  | { index: number; ok: false; error: RememberError };

// validation: tidak ada yang ditulis. write: sebagian fakta gagal saat ditulis (misalnya
// waktu lebih awal dari fakta berlaku); fakta yang berhasil tetap tersimpan.
export type RememberResult =
  | { ok: true; source: string; results: FactResult[] }
  | { ok: false; stage: "validation"; errors: RememberError[] }
  | { ok: false; stage: "write"; source: string; results: FactResult[] };

type Ref = { id: RecordId } | { name: string; kind?: string };

interface Prepared {
  index: number;
  entity: Ref;
  attribute: Attribute;
  value: unknown;
  valueRef?: Ref;
  quote: string;
  at: Date;
}

interface Planned {
  existing?: EntityMatch;
  create?: { name: string; kind?: string };
}

const squash = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replaceAll(/\s+/g, " ").trim();

function fail(
  code: MemoryErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MemoryError(code, message, details);
}

function toError(index: number | undefined, error: MemoryError): RememberError {
  return { index, code: error.code, message: error.message, details: error.details };
}

function parseRef(ref: z.output<typeof entityRef>): Ref {
  if (typeof ref === "string") return { name: ref.trim() };
  if ("id" in ref) {
    const id = parseId("entity", ref.id);
    if (!id) fail("invalid_input", `id entity tidak valid: "${ref.id}" (format entity:<id>)`);
    return { id };
  }
  return { name: ref.name.trim(), kind: ref.kind };
}

// Kutipan wajib benar-benar ada di teks sumber (tanpa membedakan huruf besar/kecil dan spasi).
function checkQuote(content: string, quote: string): void {
  const needle = squash(quote);
  if (needle.length < MIN_QUOTE) {
    fail("quote_not_found", `kutipan minimal ${MIN_QUOTE} karakter`, { quote });
  }
  if (!squash(content).includes(needle)) {
    fail("quote_not_found", "kutipan tidak ditemukan di teks sumber", { quote });
  }
}

function prepare(
  index: number,
  fact: z.output<typeof rememberSchema>["facts"][number],
  ctx: Ctx,
  content: string,
  receivedAt: Date,
): Prepared {
  const attribute = ctx.registry.resolve(fact.attribute);
  checkQuote(content, fact.quote);

  let value: unknown = fact.value;
  let valueRef: Ref | undefined;
  if (attribute.type === "entity") {
    const isRefShape =
      typeof value === "string" ||
      (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        ("id" in value || "name" in value));
    if (!isRefShape) {
      fail(
        "invalid_value",
        `nilai untuk atribut "${attribute.key}" harus nama atau referensi entity`,
        {
          attribute: attribute.key,
          expected: "entity",
        },
      );
    }
    valueRef = parseRef(entityRef.parse(value));
  } else {
    if (attribute.type === "date" && typeof value === "string") value = new Date(value);
    checkValue(attribute, value);
  }

  return {
    index,
    entity: parseRef(fact.entity),
    attribute,
    value,
    valueRef,
    quote: fact.quote,
    at: fact.valid_from ? new Date(fact.valid_from) : receivedAt,
  };
}

// Pembacaan saja: menentukan entitas yang sudah ada atau yang perlu dibuat, dan menolak
// referensi yang ambigu atau salah scope. Entitas yang sama disebut dua kali = satu rencana.
function createPlanner(ctx: Ctx, scope: string) {
  const plans = new Map<string, Planned>();

  async function resolve(ref: Ref): Promise<Planned> {
    if ("id" in ref) {
      const key = `id:${idToString(ref.id)}`;
      const known = plans.get(key);
      if (known) return known;
      const entity = await getEntity(ctx, ref.id);
      if (!entity) fail("not_found", "entity tidak ditemukan", { id: idToString(ref.id) });
      if (entity.scope !== scope) {
        fail("scope_mismatch", "entity berada di scope lain", { id: idToString(ref.id) });
      }
      const plan = { existing: { id: entity.id, name: entity.name, kind: entity.kind } };
      plans.set(key, plan);
      return plan;
    }

    const key = `name:${entityKey(ref.name)}`;
    const known = plans.get(key);
    if (known) {
      if (known.create && ref.kind && !known.create.kind) known.create.kind = ref.kind;
      return known;
    }

    let matches = await findEntities(ctx, scope, ref.name);
    if (matches.length > 1 && ref.kind) matches = matches.filter((m) => m.kind === ref.kind);
    if (matches.length > 1) {
      fail("ambiguous_entity", `"${ref.name}" cocok dengan lebih dari satu entity`, {
        name: ref.name,
        candidates: matches.map((m) => ({ id: idToString(m.id), name: m.name, kind: m.kind })),
      });
    }
    const [existing] = matches;
    const plan: Planned = existing ? { existing } : { create: { name: ref.name, kind: ref.kind } };
    plans.set(key, plan);
    return plan;
  }

  return { resolve, plans };
}

function validationFailure(error: z.ZodError): RememberResult {
  return {
    ok: false,
    stage: "validation",
    errors: error.issues.map((issue) => {
      const [head, index] = issue.path;
      return {
        index: head === "facts" && typeof index === "number" ? index : undefined,
        code: "invalid_input" as const,
        message: `${issue.path.join(".") || "input"}: ${issue.message}`,
        details: { path: issue.path },
      };
    }),
  };
}

// Menyimpan teks sumber dan fakta-fakta terstruktur yang diekstrak AI pemanggil.
// Tahap 1 (membaca saja): semua fakta divalidasi (atribut, nilai, kutipan, entitas). Satu
// saja yang tidak valid = tidak ada yang ditulis, dan semua galat dikembalikan sebagai data.
// Tahap 2: tulis sumber, entitas baru, lalu fakta berurutan menurut waktunya.
export async function remember(ctx: Ctx, raw: unknown): Promise<RememberResult> {
  const parsed = rememberSchema.safeParse(raw);
  if (!parsed.success) return validationFailure(parsed.error);
  const { scope, source: sourceInput, facts } = parsed.data;
  const receivedAt = sourceInput.received_at ? new Date(sourceInput.received_at) : new Date();

  const planner = createPlanner(ctx, scope);
  const errors: RememberError[] = [];
  const prepared: (Prepared & { plan: Planned; valuePlan?: Planned })[] = [];

  for (const [index, fact] of facts.entries()) {
    try {
      const item = prepare(index, fact, ctx, sourceInput.content, receivedAt);
      const plan = await planner.resolve(item.entity);
      const valuePlan = item.valueRef ? await planner.resolve(item.valueRef) : undefined;
      prepared.push({ ...item, plan, valuePlan });
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      errors.push(toError(index, error));
    }
  }
  if (errors.length > 0) return { ok: false, stage: "validation", errors };

  // Kalimat fakta selalu dibuat (untuk full-text). Embedding fakta dan entitas baru dibuat
  // dalam satu batch SEBELUM menulis apa pun: embedder gagal = tidak ada data setengah tertulis.
  const nameOf = (plan: Planned): string => plan.existing?.name ?? plan.create?.name ?? "";
  const texts = prepared.map((item) =>
    renderFactText({
      entity: nameOf(item.plan),
      attribute: item.attribute,
      value: displayValue(item.value, item.valuePlan ? nameOf(item.valuePlan) : undefined),
      quote: item.quote,
    }),
  );
  const newPlans = [
    ...new Set(prepared.flatMap((i) => [i.plan, i.valuePlan]).filter((p) => p?.create)),
  ] as Planned[];
  const vectors = ctx.embedder
    ? await embedTexts(ctx.embedder, [...texts, ...newPlans.map(nameOf)], "document")
    : [];
  const entityVectors = new Map(newPlans.map((plan, i) => [plan, vectors[texts.length + i]]));
  const items = prepared.map((item, i) => ({ ...item, text: texts[i], embedding: vectors[i] }));

  const sourceId = await createSource(ctx, {
    scope,
    content: sourceInput.content,
    meta: sourceInput.meta,
    receivedAt,
  });

  const resolved = new Map<Planned, EntityInfo & { rid: RecordId }>();
  async function materialize(plan: Planned): Promise<EntityInfo & { rid: RecordId }> {
    const known = resolved.get(plan);
    if (known) return known;
    let info: EntityInfo & { rid: RecordId };
    if (plan.existing) {
      const { id, name, kind } = plan.existing;
      info = { rid: id, id: idToString(id), name, kind, created: false };
    } else {
      const create = plan.create as { name: string; kind?: string };
      const kind = create.kind ?? DEFAULT_KIND;
      const rid = await createEntity(ctx, {
        scope,
        name: create.name,
        kind,
        embedding: entityVectors.get(plan),
      });
      info = { rid, id: idToString(rid), name: create.name, kind, created: true };
    }
    resolved.set(plan, info);
    return info;
  }

  // Urut menurut waktu berlaku (stabil): urutan input AI tidak boleh memicu "waktu mundur".
  const ordered = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
  const results: FactResult[] = [];
  for (const item of ordered) {
    const entity = await materialize(item.plan);
    const value = item.valuePlan ? (await materialize(item.valuePlan)).rid : item.value;
    try {
      const outcome = await assertFact(ctx, {
        scope,
        entity: entity.rid,
        attribute: item.attribute.key,
        value,
        source: sourceId,
        quote: item.quote,
        text: item.text,
        embedding: item.embedding,
        at: item.at,
      });
      results.push({
        index: item.index,
        ok: true,
        status: outcome.status,
        fact: idToString(outcome.id),
        entity: { id: entity.id, name: entity.name, kind: entity.kind, created: entity.created },
        attribute: item.attribute.key,
      });
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      results.push({ index: item.index, ok: false, error: toError(item.index, error) });
    }
  }
  results.sort((a, b) => a.index - b.index);

  const source = idToString(sourceId);
  return results.every((r) => r.ok)
    ? { ok: true, source, results }
    : { ok: false, stage: "write", source, results };
}
