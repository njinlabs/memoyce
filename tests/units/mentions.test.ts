import { expect, test } from "bun:test";
import { ngrams, shadowedEntities } from "../../src/core/mentions";

const maju = { id: "entity:maju", scope: "s", keys: ["pt maju"] };
const jaya = { id: "entity:jaya", scope: "s", keys: ["pt maju jaya"] };

test("ngrams: kata 1..8, huruf kecil, tanpa tanda baca", () => {
  const grams = ngrams("Berapa anggaran PT. Maju Jaya?");
  expect(grams).toContain("pt maju jaya");
  expect(grams).toContain("berapa anggaran pt maju jaya");
  expect(ngrams("")).toEqual([]);

  const long = ngrams("satu dua tiga empat lima enam tujuh delapan sembilan");
  expect(long).toContain("satu dua tiga empat lima enam tujuh delapan");
  expect(long).not.toContain("satu dua tiga empat lima enam tujuh delapan sembilan");
});

test("ngrams: batas per ukuran, bukan total, jadi potongan panjang tidak terbuang lebih dulu", () => {
  const query = Array.from({ length: 150 }, (_, i) => `k${i}`).join(" ");
  const grams = ngrams(query);
  const bySize = (n: number) => grams.filter((g) => g.split(" ").length === n).length;
  expect(bySize(1)).toBe(100);
  expect(bySize(8)).toBe(100);
  expect(grams).toHaveLength(800);
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

test("nama panjang (6 kata) cocok persis dan membayangi nama pendek yang ada di dalamnya", () => {
  const panjang = {
    id: "entity:panjang",
    scope: "s",
    keys: ["pt karya mandiri utama sejahtera tbk"],
  };
  const pendek = { id: "entity:pendek", scope: "s", keys: ["pt karya mandiri"] };
  const query = "Berapa anggaran PT Karya Mandiri Utama Sejahtera Tbk?";
  expect(ngrams(query)).toContain("pt karya mandiri utama sejahtera tbk");
  expect([...shadowedEntities(query, [panjang, pendek])]).toEqual([pendek.id]);
});
