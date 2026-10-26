import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { distractors, questions, seedSteps } from "../../evals/dataset";
import { cacheQueryEmbeddings, evaluate, seed, sweep, throttleEmbedder } from "../../evals/harness";
import {
  byCategory,
  matches,
  pickThreshold,
  type Score,
  scoreQuestion,
  summarize,
} from "../../evals/metrics";
import { salesAttributes } from "../../examples/cli/attributes";
import { createMemory, type Memory, type RecallItem, type RecallResult } from "../../src/index";
import { createFakeEmbedder } from "../support/embedder";

// Set evaluasi harus konsisten: korpus bisa disimpan (kutipan benar, atribut dikenal) dan setiap
// label menunjuk fakta yang memang ada di korpus. Mutu retrieval sendiri tidak diuji di sini
// (embedder palsu); itu urusan `bun run eval` dengan embedding sungguhan.

const item = (entity: string, attribute: string, value: unknown): RecallItem => ({
  fact: "fact:x",
  scope: "org:1",
  entity: { id: "entity:x", name: entity, kind: "unknown" },
  attribute,
  value,
  text: "",
  valid_from: "2026-01-01T00:00:00.000Z",
  source: { id: "source:x", received_at: "2026-01-01T00:00:00.000Z" },
  score: 1,
  signals: {},
});

const found = (...items: RecallItem[]): RecallResult => ({
  ok: true,
  found: items.length > 0,
  as_of: "2026-01-01T00:00:00.000Z",
  items,
  linked_entities: [],
});

describe("dataset", () => {
  let memory: Memory;

  beforeAll(async () => {
    memory = await createMemory({
      storage: { url: "mem://" },
      attributes: salesAttributes,
      embedder: createFakeEmbedder(),
    });
  });
  afterAll(async () => {
    await memory.close();
  });

  test("korpus tersimpan seluruhnya (kutipan terverifikasi, atribut dikenal)", async () => {
    const facts = await seed(memory, seedSteps);
    expect(facts).toBe(seedSteps.reduce((sum, s) => sum + s.facts.length, 0));
    expect(distractors.length).toBeGreaterThan(20);
  });

  test("id pertanyaan unik dan tiap kategori terwakili", () => {
    const ids = questions.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(questions.map((x) => x.category));
    for (const c of [
      "direct",
      "paraphrase",
      "multi",
      "temporal",
      "relation",
      "near_miss",
      "entity_variant",
      "scope",
      "scale",
      "unanswerable",
    ]) {
      expect(categories.has(c as never)).toBe(true);
    }
    // Keseimbangan: harus ada cukup pertanyaan tak terjawab agar "berani bilang tidak tahu" terukur.
    const unanswerable = questions.filter((x) => x.answers.length === 0).length;
    expect(unanswerable / questions.length).toBeGreaterThan(0.25);
  });

  test("setiap jawaban berlabel menunjuk fakta yang ada di korpus", () => {
    const stored = seedSteps.flatMap((step) =>
      step.facts.map((f) => ({
        scope: step.scope,
        entity: typeof f.entity === "string" ? f.entity : "name" in f.entity ? f.entity.name : "",
        attribute: f.attribute,
        value:
          typeof f.value === "object" && f.value !== null && "name" in f.value
            ? (f.value as { name: string }).name
            : f.value,
      })),
    );
    for (const question of questions) {
      const scopes = Array.isArray(question.scope) ? question.scope : [question.scope];
      for (const answer of question.answers) {
        const exists = stored.some(
          (s) =>
            scopes.includes(s.scope) &&
            s.entity.toLowerCase() === answer.entity.toLowerCase() &&
            s.attribute === answer.attribute &&
            String(s.value).toLowerCase() === String(answer.value).toLowerCase(),
        );
        expect(exists, `${question.id}: ${answer.entity}/${answer.attribute}/${answer.value}`).toBe(
          true,
        );
      }
    }
  });

  test("harness berjalan ujung ke ujung (embedder palsu: hanya mekanisme)", async () => {
    const scores = await evaluate(memory, questions);
    expect(scores).toHaveLength(questions.length);
    const summary = summarize(scores);
    expect(summary.total).toBe(questions.length);
    // Pertanyaan lintas-scope tidak boleh bocor walau embedder palsu.
    const leaks = scores.filter((s) => s.category === "scope" && s.leaked);
    expect(leaks).toEqual([]);
  });

  test("sapuan ambang menghasilkan satu titik per kombinasi", async () => {
    const subset = questions.slice(0, 6);
    const points = await sweep(memory, subset, { similarities: [0.3, 0.6], coverages: [0.5, 1] });
    expect(points).toHaveLength(4);
    expect(points[0]?.summary.total).toBe(6);
  });
});

describe("cacheQueryEmbeddings", () => {
  test("query yang sama hanya di-embed sekali; dokumen tidak di-cache", async () => {
    const fake = createFakeEmbedder();
    const cached = cacheQueryEmbeddings(fake);
    const a = await cached.embed(["halo", "dunia"], { kind: "query" });
    const b = await cached.embed(["dunia", "halo", "baru"], { kind: "query" });
    expect(b[0]).toEqual(a[1]);
    expect(b[1]).toEqual(a[0]);
    const queryTexts = fake.calls.filter((c) => c.kind === "query").flatMap((c) => c.texts);
    expect(queryTexts.sort()).toEqual(["baru", "dunia", "halo"]);

    await cached.embed(["halo"], { kind: "document" });
    await cached.embed(["halo"], { kind: "document" });
    expect(fake.calls.filter((c) => c.kind === "document")).toHaveLength(2);
    expect(cached.model).toBe(fake.model);
    expect(cached.dimension).toBe(fake.dimension);
  });
});

describe("throttleEmbedder", () => {
  test("memberi jeda antar panggilan dan mengulang saat kuota habis", async () => {
    const fake = createFakeEmbedder();
    const sleeps: number[] = [];
    const throttled = throttleEmbedder(fake, {
      minIntervalMs: 50,
      retries: 2,
      retryDelayMs: 7,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    fake.failNext(new Error("429 RESOURCE_EXHAUSTED"));
    const vectors = await throttled.embed(["halo"], { kind: "query" });
    expect(vectors).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toContain(7);
    expect(throttled.model).toBe(fake.model);
    expect(throttled.dimension).toBe(fake.dimension);
  });

  test("galat selain kuota, atau kuota yang tak kunjung pulih, dilempar", async () => {
    const fake = createFakeEmbedder();
    const throttled = throttleEmbedder(fake, {
      minIntervalMs: 0,
      retries: 1,
      retryDelayMs: 0,
      sleep: async () => {},
    });
    fake.failNext(new Error("jaringan putus"));
    await expect(throttled.embed(["a"], { kind: "query" })).rejects.toThrow("jaringan putus");

    const quota = throttleEmbedder(
      {
        ...fake,
        embed: async () => {
          throw new Error("429");
        },
      },
      { minIntervalMs: 0, retries: 1, retryDelayMs: 0, sleep: async () => {} },
    );
    await expect(quota.embed(["a"], { kind: "query" })).rejects.toThrow("429");
  });
});

describe("seed", () => {
  test("galat jelas bila langkah ditolak", async () => {
    const memory = await createMemory({
      storage: { url: "mem://" },
      attributes: salesAttributes,
    });
    const bad = {
      scope: "org:x",
      source: { content: "PT A anggaran 5 juta", received_at: "2026-01-01T00:00:00Z" },
      facts: [{ entity: "PT A", attribute: "budget", value: 5, quote: "tidak ada di teks" }],
    };
    await expect(seed(memory, [bad])).rejects.toThrow("ditolak");
    await memory.close();
  });

  test("galat bila penulisan fakta gagal (stale_time)", async () => {
    const memory = await createMemory({
      storage: { url: "mem://" },
      attributes: salesAttributes,
    });
    const step = (at: string, juta: number) => ({
      scope: "org:x",
      source: { content: `PT A anggaran ${juta} juta`, received_at: at },
      facts: [
        {
          entity: "PT A",
          attribute: "budget",
          value: juta,
          quote: `anggaran ${juta} juta`,
          valid_from: at,
        },
      ],
    });
    // Urutan seed diurutkan menurut waktu, jadi kegagalan ditimbulkan dua langkah dengan waktu
    // sama tetapi nilai berbeda: yang kedua menutup yang pertama pada waktu yang sama.
    const first = await seed(memory, [step("2026-01-01T00:00:00Z", 5)]);
    expect(first).toBe(1);
    await expect(seed(memory, [step("2025-12-01T00:00:00Z", 9)])).rejects.toThrow("gagal menulis");
    await memory.close();
  });
});

describe("metrics", () => {
  test("matches: nama entitas, atribut, dan nilai (termasuk rujukan entitas)", () => {
    expect(matches(item("PT Maju", "budget", 75), { entity: "pt maju", attribute: "budget" })).toBe(
      true,
    );
    expect(
      matches(item("PT Maju", "attribute:budget", 75), {
        entity: "PT Maju",
        attribute: "budget",
        value: 75,
      }),
    ).toBe(true);
    expect(matches(item("PT Maju", "budget", 75), { entity: "PT Maju", attribute: "city" })).toBe(
      false,
    );
    expect(matches(item("PT Lain", "budget", 75), { entity: "PT Maju", attribute: "budget" })).toBe(
      false,
    );
    expect(
      matches(item("PT Maju", "budget", 50), { entity: "PT Maju", attribute: "budget", value: 75 }),
    ).toBe(false);
    expect(
      matches(item("PT Maju", "decision_maker", { id: "entity:s", name: "Sari" }), {
        entity: "PT Maju",
        attribute: "decision_maker",
        value: "sari",
      }),
    ).toBe(true);
  });

  const answerable = {
    id: "a",
    category: "direct" as const,
    scope: "s",
    query: "q",
    answers: [
      { entity: "A", attribute: "x", value: 1 },
      { entity: "A", attribute: "x", value: 2 },
    ],
    forbidden: [{ entity: "A", attribute: "x", value: 9 }],
  };
  const unanswerable = {
    id: "u",
    category: "unanswerable" as const,
    scope: "s",
    query: "q",
    answers: [],
    forbidden: [{ entity: "B", attribute: "y" }],
  };

  test("scoreQuestion: bisa dijawab", () => {
    const full = scoreQuestion(answerable, found(item("A", "x", 2), item("A", "x", 1)));
    expect(full).toMatchObject({ recall: 1, firstRank: 1, leaked: false, correct: true });

    const partial = scoreQuestion(answerable, found(item("Z", "x", 0), item("A", "x", 2)));
    expect(partial).toMatchObject({ recall: 0.5, firstRank: 2, correct: false });

    const leaked = scoreQuestion(
      answerable,
      found(item("A", "x", 1), item("A", "x", 2), item("A", "x", 9)),
    );
    expect(leaked).toMatchObject({ recall: 1, leaked: true, correct: false });

    const none = scoreQuestion(answerable, found());
    expect(none).toMatchObject({ found: false, recall: 0, correct: false });
    expect(none.firstRank).toBeUndefined();
  });

  test("scoreQuestion: tidak bisa dijawab", () => {
    expect(scoreQuestion(unanswerable, found()).correct).toBe(true);
    expect(scoreQuestion(unanswerable, found(item("Z", "z", 1))).correct).toBe(false);
    expect(scoreQuestion(unanswerable, found(item("B", "y", 1)))).toMatchObject({
      leaked: true,
      correct: false,
    });
  });

  test("scoreQuestion: galat validasi dihitung salah", () => {
    const failure: RecallResult = { ok: false, errors: [] };
    expect(scoreQuestion(answerable, failure).correct).toBe(false);
    expect(scoreQuestion(unanswerable, failure).correct).toBe(false);
  });

  test("summarize, byCategory, dan rasio kosong", () => {
    const scores: Score[] = [
      scoreQuestion(answerable, found(item("A", "x", 1), item("A", "x", 2))),
      scoreQuestion(answerable, found(item("Z", "z", 0), item("A", "x", 1))),
      scoreQuestion(unanswerable, found()),
      scoreQuestion(unanswerable, found(item("B", "y", 1))),
    ];
    const summary = summarize(scores);
    expect(summary).toMatchObject({
      total: 4,
      correct: 2,
      accuracy: 0.5,
      answerable: 2,
      answeredFully: 1,
      unanswerable: 2,
      abstained: 1,
      falseAnswerRate: 0.5,
      leakRate: 0.25,
    });
    expect(summary.recall).toBeCloseTo(0.75);
    expect(summary.hitAt1).toBe(0.5);
    expect(summary.mrr).toBeCloseTo(0.75);

    const groups = byCategory(scores);
    expect(groups.get("direct")?.total).toBe(2);
    expect(groups.get("unanswerable")?.total).toBe(2);

    const empty = summarize([]);
    expect(empty).toMatchObject({ total: 0, accuracy: 0, recall: 0, falseAnswerRate: 0 });
  });

  test("pickThreshold: aman dulu, lalu lengkap terbanyak, lalu ambang lebih ketat", () => {
    const base = summarize([]);
    const point = (
      minSimilarity: number,
      minKeywordCoverage: number,
      patch: Partial<typeof base>,
    ) => ({ minSimilarity, minKeywordCoverage, summary: { ...base, ...patch } });
    const points = [
      point(0.3, 0.5, { answeredFully: 30, falseAnswerRate: 0.4 }),
      point(0.5, 0.5, { answeredFully: 20, falseAnswerRate: 0.02, accuracy: 0.8 }),
      point(0.6, 0.5, { answeredFully: 20, falseAnswerRate: 0.02, accuracy: 0.8 }),
      point(0.7, 0.5, { answeredFully: 25, falseAnswerRate: 0.0, leakRate: 0.1 }),
      point(0.4, 0.5, { answeredFully: 20, falseAnswerRate: 0.0, accuracy: 0.7 }),
    ];
    expect(pickThreshold(points, 0.05)).toMatchObject({ minSimilarity: 0.6 });
    expect(pickThreshold(points, 0)).toMatchObject({ minSimilarity: 0.4 });
    expect(pickThreshold([points[0] as (typeof points)[number]], 0.05)).toBeUndefined();
  });
});
