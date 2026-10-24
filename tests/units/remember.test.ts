import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { DateTime } from "surrealdb";
import { z } from "zod";
import { findEntities } from "../../src/core/entities";
import { factsAt } from "../../src/core/fact";
import { idToString, parseId } from "../../src/core/ids";
import { createEntity } from "../../src/core/records";
import {
  type FactResult,
  type RememberInput,
  type RememberResult,
  remember,
  rememberSchema,
} from "../../src/core/remember";
import { openTestContext, type TestContext } from "../support/context";

let t: TestContext;

beforeAll(async () => {
  t = await openTestContext();
});

afterAll(() => t.close());

let counter = 0;
const newScope = () => `scope-${++counter}`;
const CONTENT = "Budi bekerja di Acme sejak 2022. Ia tinggal di Bandung dan hobi catur.";

const input = (overrides: Partial<RememberInput> = {}, scope = newScope()): RememberInput => ({
  scope,
  source: { content: CONTENT, received_at: "2025-03-01T00:00:00Z" },
  facts: [{ entity: "Budi", attribute: "employer", value: "Acme", quote: "bekerja di Acme" }],
  ...overrides,
});

const succeed = (result: RememberResult) => {
  if (!result.ok) throw new Error(`seharusnya sukses: ${JSON.stringify(result)}`);
  return result;
};

const invalid = (result: RememberResult) => {
  if (result.ok || result.stage !== "validation") {
    throw new Error(`seharusnya gagal validasi: ${JSON.stringify(result)}`);
  }
  return result.errors;
};

const written = (result: FactResult) => {
  if (!result.ok) throw new Error("seharusnya sukses");
  return result;
};

const count = async (table: string, scope: string): Promise<number> => {
  const [rows] = await t.ctx.db
    .query<[unknown[]]>(`SELECT id FROM ${table} WHERE scope = $scope`, { scope })
    .collect();
  return rows?.length ?? 0;
};

const current = async (scope: string, entityId: string) => {
  const entity = parseId("entity", entityId);
  if (!entity) throw new Error("id tidak valid");
  return factsAt(t.ctx, { scope, entity, at: new Date("2030-01-01") });
};

test("menyimpan sumber, entitas baru, dan fakta lengkap dengan kutipan", async () => {
  const request = input({
    source: { content: CONTENT, received_at: "2025-03-01T00:00:00Z", meta: { channel: "chat" } },
  });
  const result = succeed(await remember(t.ctx, request));
  const [first] = result.results.map(written);

  expect(result.source).toStartWith("source:");
  expect(first).toMatchObject({
    index: 0,
    status: "created",
    attribute: "employer",
    entity: { name: "Budi", kind: "unknown", created: true },
  });
  expect(first?.fact).toStartWith("fact:");
  expect(first?.entity.id).toStartWith("entity:");

  const [fact] = await current(request.scope, first?.entity.id ?? "");
  expect(fact).toMatchObject({ value: "Acme", quote: "bekerja di Acme" });
  expect(fact?.valid_from.toDate()).toEqual(new Date("2025-03-01T00:00:00Z"));

  const [source] = await t.ctx.db
    .query<[{ content: string; meta: unknown }]>("SELECT content, meta FROM ONLY $id", {
      id: parseId("source", result.source),
    })
    .collect();
  expect(source).toEqual({ content: CONTENT, meta: { channel: "chat" } });
});

test("entitas yang sama dikenali lewat nama (tanpa beda huruf) dan alias; pernyataan ulang unchanged", async () => {
  const scope = newScope();
  const first = succeed(await remember(t.ctx, input({}, scope)));
  const entityId = written(first.results[0] as FactResult).entity.id;

  const again = succeed(
    await remember(
      t.ctx,
      input(
        { facts: [{ entity: "  BUDI ", attribute: "company", value: "Acme", quote: "Acme" }] },
        scope,
      ),
    ),
  );
  const result = written(again.results[0] as FactResult);
  expect(result).toMatchObject({ status: "unchanged", entity: { id: entityId, created: false } });

  // Alias: entitas dibuat dengan alias, lalu dirujuk lewat alias itu.
  const siti = await createEntity(t.ctx, {
    scope,
    name: "Siti Rahma",
    kind: "person",
    aliases: ["Bu Siti"],
  });
  const viaAlias = succeed(
    await remember(
      t.ctx,
      input(
        { facts: [{ entity: "bu siti", attribute: "city", value: "Bandung", quote: "Bandung" }] },
        scope,
      ),
    ),
  );
  expect(written(viaAlias.results[0] as FactResult).entity.id).toBe(idToString(siti));
});

test("nilai baru menutup nilai lama; riwayat tetap ada", async () => {
  const scope = newScope();
  succeed(await remember(t.ctx, input({}, scope)));
  const second = succeed(
    await remember(
      t.ctx,
      input(
        {
          source: { content: "Budi pindah ke Globex.", received_at: "2025-06-01T00:00:00Z" },
          facts: [
            { entity: "Budi", attribute: "employer", value: "Globex", quote: "pindah ke Globex" },
          ],
        },
        scope,
      ),
    ),
  );
  const result = written(second.results[0] as FactResult);
  expect(result.status).toBe("updated");
  expect(await count("fact", scope)).toBe(2);
  expect((await current(scope, result.entity.id)).map((f) => f.value)).toEqual(["Globex"]);
});

test("valid_from eksplisit (tanggal atau datetime) dipakai; urutan input tidak memicu waktu mundur", async () => {
  const scope = newScope();
  const result = succeed(
    await remember(
      t.ctx,
      input(
        {
          source: { content: "Budi di Globex sejak 2023, sebelumnya di Acme sejak 2022." },
          facts: [
            {
              entity: "Budi",
              attribute: "employer",
              value: "Globex",
              quote: "Globex sejak 2023",
              valid_from: "2023-06-01",
            },
            {
              entity: "Budi",
              attribute: "employer",
              value: "Acme",
              quote: "Acme sejak 2022",
              valid_from: "2022-01-01T00:00:00Z",
            },
          ],
        },
        scope,
      ),
    ),
  );
  const [globex, acme] = result.results.map(written);
  expect(acme?.status).toBe("created");
  expect(globex?.status).toBe("updated");
  // Hasil dikembalikan menurut urutan input, bukan urutan penulisan.
  expect(result.results.map((r) => r.index)).toEqual([0, 1]);

  const entity = parseId("entity", acme?.entity.id ?? "");
  const at = async (date: string) =>
    entity ? (await factsAt(t.ctx, { scope, entity, at: new Date(date) })).map((f) => f.value) : [];
  expect(await at("2022-06-01")).toEqual(["Acme"]);
  expect(await at("2024-01-01")).toEqual(["Globex"]);
});

test.each([
  ["scope kosong", { scope: "" }],
  ["tanpa fakta", { facts: [] }],
  ["source kosong", { source: { content: "" } }],
  ["received_at bukan ISO", { source: { content: CONTENT, received_at: "kemarin" } }],
  [
    "terlalu banyak fakta",
    {
      facts: Array.from({ length: 101 }, () => ({
        entity: "Budi",
        attribute: "city",
        value: "x",
        quote: "Budi",
      })),
    },
  ],
])("input tidak valid ditolak sebagai data: %s", async (_name, override) => {
  const scope = newScope();
  const errors = invalid(await remember(t.ctx, { ...input({}, scope), ...override }));
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every((e) => e.code === "invalid_input")).toBe(true);
  expect(await count("source", scope)).toBe(0);
});

test.each([
  ["bukan objek", "halo"],
  ["null", null],
  ["tanpa quote", { ...input(), facts: [{ entity: "Budi", attribute: "city", value: "x" }] }],
  [
    "nilai null",
    { ...input(), facts: [{ entity: "Budi", attribute: "city", value: null, quote: "Budi" }] },
  ],
  [
    "valid_from bukan ISO",
    {
      ...input(),
      facts: [
        { entity: "Budi", attribute: "city", value: "x", quote: "Budi", valid_from: "besok" },
      ],
    },
  ],
])("bentuk input salah: %s", async (_name, raw) => {
  const errors = invalid(await remember(t.ctx, raw));
  expect(errors.every((e) => e.code === "invalid_input")).toBe(true);
});

test("galat fakta membawa index-nya", async () => {
  const errors = invalid(
    await remember(t.ctx, {
      ...input(),
      facts: [
        { entity: "Budi", attribute: "city", value: "Bandung", quote: "Bandung" },
        { entity: "Budi", attribute: "city", value: "x" },
      ],
    }),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.index).toBe(1);
});

test("satu fakta tidak valid membatalkan semuanya, semua galat dikembalikan", async () => {
  const scope = newScope();
  const errors = invalid(
    await remember(
      t.ctx,
      input(
        {
          facts: [
            { entity: "Budi", attribute: "employer", value: "Acme", quote: "bekerja di Acme" },
            { entity: "Budi", attribute: "employe", value: "Acme", quote: "bekerja di Acme" },
            { entity: "Budi", attribute: "city", value: "Bandung", quote: "tidak ada di teks" },
          ],
        },
        scope,
      ),
    ),
  );
  expect(errors.map((e) => [e.index, e.code])).toEqual([
    [1, "unknown_attribute"],
    [2, "quote_not_found"],
  ]);
  expect(errors[0]?.details.suggestions).toEqual(["employer"]);
  expect(await count("source", scope)).toBe(0);
  expect(await count("entity", scope)).toBe(0);
  expect(await count("fact", scope)).toBe(0);
});

test("kutipan: tidak sensitif huruf dan spasi, minimal 3 karakter", async () => {
  const ok = (quote: string) =>
    remember(
      t.ctx,
      input({ facts: [{ entity: "Budi", attribute: "city", value: "Bandung", quote }] }),
    );

  succeed(await ok("TINGGAL   di\nBANDUNG"));
  succeed(await ok("ｔｉｎｇｇａｌ ｄｉ"));
  expect(invalid(await ok("Bd"))[0]?.message).toContain("minimal");
  expect(invalid(await ok("   "))[0]?.code).toBe("quote_not_found");
  expect(invalid(await ok("tinggal di Surabaya"))[0]?.code).toBe("quote_not_found");
});

test("nilai bertipe salah ditolak; tanggal ISO dikonversi", async () => {
  const tryFact = (attribute: string, value: unknown) =>
    remember(
      t.ctx,
      input({ facts: [{ entity: "Budi", attribute, value: value as string, quote: "Budi" }] }),
    );

  expect(invalid(await tryFact("age", "30"))[0]?.code).toBe("invalid_value");
  expect(invalid(await tryFact("birthday", "bukan tanggal"))[0]?.code).toBe("invalid_value");
  expect(invalid(await tryFact("works_for", 5))[0]?.code).toBe("invalid_value");
  expect(invalid(await tryFact("works_for", ["Acme"]))[0]?.code).toBe("invalid_value");
  expect(invalid(await tryFact("works_for", { id: "salah" }))[0]?.code).toBe("invalid_input");

  const scope = newScope();
  const stored = succeed(
    await remember(
      t.ctx,
      input(
        { facts: [{ entity: "Budi", attribute: "birthday", value: "1990-05-05", quote: "Budi" }] },
        scope,
      ),
    ),
  );
  const [fact] = await current(scope, written(stored.results[0] as FactResult).entity.id);
  expect((fact?.value as DateTime | undefined)?.toDate()).toEqual(new Date("1990-05-05"));
});

test("bentuk rujukan entitas: nama+kind, id, id tidak valid, tidak ada, scope lain", async () => {
  const scope = newScope();
  const first = succeed(
    await remember(
      t.ctx,
      input(
        {
          facts: [
            {
              entity: { name: "Budi", kind: "person" },
              attribute: "city",
              value: "Bandung",
              quote: "Bandung",
            },
          ],
        },
        scope,
      ),
    ),
  );
  const budi = written(first.results[0] as FactResult).entity;
  expect(budi).toMatchObject({ kind: "person", created: true });

  const byId = (id: string, forScope = scope) =>
    remember(
      t.ctx,
      input(
        { facts: [{ entity: { id }, attribute: "hobby", value: "catur", quote: "catur" }] },
        forScope,
      ),
    );

  expect(written(succeed(await byId(budi.id)).results[0] as FactResult).entity.id).toBe(budi.id);
  expect(invalid(await byId("budi"))[0]?.code).toBe("invalid_input");
  expect(invalid(await byId("entity:"))[0]?.code).toBe("invalid_input");
  expect(invalid(await byId("entity:tidak-ada"))[0]?.code).toBe("not_found");
  expect(invalid(await byId(budi.id, newScope()))[0]?.code).toBe("scope_mismatch");
});

test("nama ambigu: kandidat dikembalikan; kind menyelesaikan; kind lain membuat entitas baru", async () => {
  const scope = newScope();
  const person = await createEntity(t.ctx, { scope, name: "Budi", kind: "person" });
  await createEntity(t.ctx, { scope, name: "Budi", kind: "organization" });

  const withKind = (entity: RememberInput["facts"][number]["entity"]) =>
    remember(
      t.ctx,
      input({ facts: [{ entity, attribute: "city", value: "Bandung", quote: "Bandung" }] }, scope),
    );

  const [error] = invalid(await withKind("Budi"));
  expect(error?.code).toBe("ambiguous_entity");
  expect(
    ((error?.details.candidates ?? []) as { kind: string }[]).map((c) => c.kind).sort(),
  ).toEqual(["organization", "person"]);

  const resolved = succeed(await withKind({ name: "Budi", kind: "person" }));
  expect(written(resolved.results[0] as FactResult).entity.id).toBe(idToString(person));

  const fresh = succeed(await withKind({ name: "Budi", kind: "animal" }));
  expect(written(fresh.results[0] as FactResult).entity).toMatchObject({
    kind: "animal",
    created: true,
  });
});

test("entitas baru yang disebut berkali-kali dalam satu panggilan hanya dibuat sekali", async () => {
  const scope = newScope();
  const result = succeed(
    await remember(
      t.ctx,
      input(
        {
          facts: [
            { entity: "Budi", attribute: "city", value: "Bandung", quote: "Bandung" },
            {
              entity: { name: "budi", kind: "person" },
              attribute: "hobby",
              value: "catur",
              quote: "catur",
            },
            { entity: "BUDI", attribute: "employer", value: "Acme", quote: "Acme" },
          ],
        },
        scope,
      ),
    ),
  );
  const entities = result.results.map((r) => written(r).entity);
  expect(new Set(entities.map((e) => e.id)).size).toBe(1);
  expect(entities[0]).toMatchObject({ kind: "person", name: "Budi" });
  expect(await count("entity", scope)).toBe(1);
  expect(await findEntities(t.ctx, scope, "budi")).toHaveLength(1);
});

test("atribut bertipe entity: nilai dibuat atau dipakai ulang sebagai entitas", async () => {
  const scope = newScope();
  const put = (value: unknown, entity: unknown = "Budi") =>
    remember(
      t.ctx,
      input(
        {
          facts: [
            {
              entity: entity as string,
              attribute: "works_for",
              value: value as string,
              quote: "Acme",
            },
          ],
        },
        scope,
      ),
    );

  const first = succeed(await put("Acme"));
  const budi = written(first.results[0] as FactResult).entity;
  const [fact] = await current(scope, budi.id);
  const acme = await findEntities(t.ctx, scope, "Acme");
  expect(acme).toHaveLength(1);
  expect(acme[0]?.kind).toBe("unknown");
  expect(idToString(fact?.value as never)).toBe(idToString(acme[0]?.id as never));

  // Menyebut organisasi yang sama lagi tidak membuat entitas baru, dan faktanya unchanged.
  const again = succeed(await put({ name: "acme", kind: "organization" }));
  expect(written(again.results[0] as FactResult).status).toBe("unchanged");
  expect(await findEntities(t.ctx, scope, "Acme")).toHaveLength(1);

  // Subjek dan nilai bisa entitas yang sama dalam satu panggilan.
  const self = succeed(await put("Budi", "Budi"));
  expect(written(self.results[0] as FactResult).status).toBe("updated");
  expect(await findEntities(t.ctx, scope, "Budi")).toHaveLength(1);

  // Nilai bisa berupa id entitas yang sudah ada.
  const byId = succeed(await put({ id: idToString(acme[0]?.id as never) }));
  expect(written(byId.results[0] as FactResult).status).toBe("updated");
});

test("kegagalan saat menulis: yang berhasil tetap tersimpan, galat dilaporkan per fakta", async () => {
  const scope = newScope();
  succeed(
    await remember(
      t.ctx,
      input({ source: { content: CONTENT, received_at: "2025-06-01T00:00:00Z" } }, scope),
    ),
  );

  const result = await remember(
    t.ctx,
    input(
      {
        source: { content: "Budi dulu di Initech. Sekarang tinggal di Bandung." },
        facts: [
          {
            entity: "Budi",
            attribute: "employer",
            value: "Initech",
            quote: "dulu di Initech",
            valid_from: "2020-01-01",
          },
          {
            entity: "Budi",
            attribute: "city",
            value: "Bandung",
            quote: "tinggal di Bandung",
            valid_from: "2025-07-01",
          },
        ],
      },
      scope,
    ),
  );

  if (result.ok || result.stage !== "write") throw new Error("seharusnya gagal saat menulis");
  const [stale, city] = result.results;
  expect(stale).toMatchObject({ ok: false, error: { code: "stale_time", index: 0 } });
  expect(city).toMatchObject({ ok: true, status: "created" });
  expect(await count("fact", scope)).toBe(2);
});

test("atribut multi lewat remember", async () => {
  const scope = newScope();
  const result = succeed(
    await remember(
      t.ctx,
      input(
        {
          source: { content: "Hobi Budi: catur dan renang." },
          facts: [
            { entity: "Budi", attribute: "hobby", value: "catur", quote: "catur" },
            { entity: "Budi", attribute: "hobby", value: "renang", quote: "renang" },
          ],
        },
        scope,
      ),
    ),
  );
  const { entity } = written(result.results[0] as FactResult);
  expect((await current(scope, entity.id)).map((f) => f.value).sort()).toEqual(["catur", "renang"]);
});

test("scope memisahkan entitas bernama sama", async () => {
  const [a, b] = [newScope(), newScope()];
  const ra = succeed(await remember(t.ctx, input({}, a)));
  const rb = succeed(await remember(t.ctx, input({}, b)));
  expect(written(ra.results[0] as FactResult).entity.id).not.toBe(
    written(rb.results[0] as FactResult).entity.id,
  );
  expect(written(rb.results[0] as FactResult).entity.created).toBe(true);
});

test("galat tak terduga dari DB dilempar, bukan disamarkan sebagai data", async () => {
  const failAt = (n: number) => {
    let calls = 0;
    const original = t.ctx.db.query.bind(t.ctx.db);
    return spyOn(t.ctx.db, "query").mockImplementation(((...args: Parameters<typeof original>) => {
      calls++;
      if (calls === n) throw new Error("db mati");
      return original(...args);
    }) as never);
  };

  // Query ke-1 = pencarian entitas (tahap validasi); ke-2 = assertFact (tahap tulis).
  for (const n of [1, 2]) {
    const spy = failAt(n);
    try {
      await expect(remember(t.ctx, input())).rejects.toThrow("db mati");
    } finally {
      spy.mockRestore();
    }
  }
});

test("rememberSchema bisa dijadikan JSON Schema untuk tool AI", () => {
  const schema = z.toJSONSchema(rememberSchema) as {
    required: string[];
    properties: Record<string, unknown>;
  };
  expect(schema.required).toEqual(expect.arrayContaining(["scope", "source", "facts"]));
  expect(Object.keys(schema.properties)).toEqual(["scope", "source", "facts"]);
});
