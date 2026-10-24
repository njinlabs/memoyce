import { afterAll, beforeAll, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { db } from "../../src/core/db";
import { createEntity, createSource } from "../../src/core/fact";
import { setupTestDb } from "../support/db";

let teardown: () => Promise<void>;

beforeAll(async () => {
  teardown = await setupTestDb();
});

afterAll(() => teardown());

// Builder SDK bersifat thenable, bukan Promise, jadi `.rejects` perlu dibungkus.
const createFact = async (data: Record<string, unknown>): Promise<void> => {
  await db.create(new RecordId("fact", crypto.randomUUID())).content(data);
};
const run = async (sql: string, vars: Record<string, unknown>): Promise<void> => {
  await db.query(sql, vars);
};

const now = new Date("2025-01-01");
const later = new Date("2025-06-01");

test("source: content kosong ditolak", async () => {
  await expect(createSource("")).rejects.toThrow();
});

test("entity: nama kosong ditolak", async () => {
  await expect(createEntity("", "person")).rejects.toThrow();
});

test("fact: tanpa source ditolak", async () => {
  const entity = await createEntity("A", "person");
  await expect(
    createFact({
      entity,
      attribute: "x",
      value: 1,
      valid_from: now,
    }),
  ).rejects.toThrow();
});

test("fact: valid_to lebih awal dari valid_from ditolak", async () => {
  const entity = await createEntity("B", "person");
  const source = await createSource("teks");
  await expect(
    createFact({
      entity,
      attribute: "x",
      value: 1,
      valid_from: later,
      valid_to: now,
      source,
    }),
  ).rejects.toThrow();
});

test("fact: value NULL ditolak", async () => {
  const entity = await createEntity("C", "person");
  const source = await createSource("teks");
  await expect(
    createFact({
      entity,
      attribute: "x",
      value: null,
      valid_from: now,
      source,
    }),
  ).rejects.toThrow();
});

test("fact: field di luar skema ditolak (SCHEMAFULL)", async () => {
  const entity = await createEntity("D", "person");
  const source = await createSource("teks");
  await expect(
    createFact({
      entity,
      attribute: "x",
      value: 1,
      valid_from: now,
      source,
      liar: true,
    }),
  ).rejects.toThrow();
});

test("relates: edge valid dengan rentang waktu dan sumber", async () => {
  const a = await createEntity("E", "person");
  const b = await createEntity("F", "organization");
  const source = await createSource("E bekerja di F");
  await db.query(
    "RELATE $a->relates->$b SET relation = 'works_at', valid_from = $at, source = $s",
    {
      a,
      b,
      at: now,
      s: source,
    },
  );
  const [rows] = await db
    .query<[{ relation: string }[]]>("SELECT relation FROM relates WHERE in = $a AND out = $b", {
      a,
      b,
    })
    .collect();
  expect(rows).toEqual([{ relation: "works_at" }]);
});

test("relates: tanpa source ditolak", async () => {
  const a = await createEntity("G", "person");
  const b = await createEntity("H", "person");
  await expect(
    run("RELATE $a->relates->$b SET relation = 'knows', valid_from = $at", { a, b, at: now }),
  ).rejects.toThrow();
});

test("relates: ujung edge harus entity", async () => {
  const a = await createEntity("I", "person");
  const source = await createSource("teks");
  await expect(
    run("RELATE $a->relates->$b SET relation = 'knows', valid_from = $at, source = $s", {
      a,
      b: source,
      at: now,
      s: source,
    }),
  ).rejects.toThrow();
});
