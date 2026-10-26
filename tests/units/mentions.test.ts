import { expect, test } from "bun:test";
import { ngrams, shadowedEntities } from "../../src/core/mentions";

const maju = { id: "entity:maju", scope: "s", keys: ["pt maju"] };
const jaya = { id: "entity:jaya", scope: "s", keys: ["pt maju jaya"] };

test("ngrams: kata 1..4, huruf kecil, tanpa tanda baca", () => {
  const grams = ngrams("Berapa anggaran PT. Maju Jaya?");
  expect(grams).toContain("pt maju jaya");
  expect(grams).toContain("berapa anggaran pt maju");
  expect(grams).not.toContain("berapa anggaran pt maju jaya");
  expect(ngrams("")).toEqual([]);
});

test("kecocokan terpanjang menang: PT Maju bayangan dari PT Maju Jaya", () => {
  expect([...shadowedEntities("Berapa anggaran PT Maju Jaya?", [maju, jaya])]).toEqual([maju.id]);
});

test("tanpa nama yang lebih panjang, tidak ada yang dibayangi", () => {
  expect(shadowedEntities("Berapa anggaran PT Maju?", [maju]).size).toBe(0);
  expect(shadowedEntities("Berapa anggaran PT Maju?", [maju, jaya]).size).toBe(0);
});

test("entitas yang juga disebut di tempat lain tetap dianggap disebut", () => {
  const query = "Bandingkan PT Maju dengan PT Maju Jaya";
  expect(shadowedEntities(query, [maju, jaya]).size).toBe(0);
});

test("alias: semua kunci entitas diperiksa", () => {
  const aliased = { id: "entity:a", scope: "s", keys: ["pt maju", "maju sejahtera"] };
  expect([
    ...shadowedEntities("data maju sejahtera abadi", [
      aliased,
      { id: "entity:b", scope: "s", keys: ["maju sejahtera abadi"] },
    ]),
  ]).toEqual([aliased.id]);
});

test("beda scope tidak saling membayangi; entitas tanpa penyebutan diabaikan", () => {
  const other = { ...jaya, scope: "t" };
  expect(shadowedEntities("PT Maju Jaya", [maju, other]).size).toBe(0);
  expect(shadowedEntities("sesuatu lain", [maju, jaya]).size).toBe(0);
  expect(shadowedEntities("PT Maju", [{ id: "entity:x", scope: "s", keys: [""] }]).size).toBe(0);
});

test("nama sama panjang tidak saling membayangi", () => {
  const a = { id: "entity:a", scope: "s", keys: ["budi"] };
  const b = { id: "entity:b", scope: "s", keys: ["budi"] };
  expect(shadowedEntities("kabar Budi", [a, b]).size).toBe(0);
});
