import type { RecallItem, RecallResult } from "../src/index";
import type { Category, EvalQuestion, Expected } from "./dataset";

// Penilaian murni (tanpa DB, tanpa jaringan). Dua sisi yang harus seimbang:
//  - pertanyaan yang BISA dijawab: apakah jawaban benar muncul, dan di peringkat berapa;
//  - pertanyaan yang TIDAK bisa dijawab: apakah sistem berani bilang "tidak tahu".
// Fakta terlarang (nilai lama, entitas mirip, scope lain) yang ikut muncul selalu dihitung salah,
// karena AI yang membaca hasilnya bisa mengambilnya sebagai jawaban.

export interface Score {
  id: string;
  category: Category;
  answerable: boolean;
  found: boolean;
  // Hanya untuk yang bisa dijawab: porsi jawaban yang muncul, dan peringkat jawaban pertama (1-based).
  recall: number;
  firstRank?: number;
  // Fakta terlarang muncul di hasil.
  leaked: boolean;
  // Jawaban benar secara keseluruhan: bisa dijawab -> semua jawaban muncul dan tidak bocor;
  // tak bisa dijawab -> `found: false` dan tidak bocor.
  correct: boolean;
}

const normalize = (value: unknown): string => String(value).trim().toLowerCase();

function itemValue(item: RecallItem): unknown {
  const value = item.value;
  if (typeof value === "object" && value !== null && "name" in value) {
    return (value as { name: unknown }).name;
  }
  return value;
}

export function matches(item: RecallItem, expected: Expected): boolean {
  if (normalize(item.entity.name) !== normalize(expected.entity)) return false;
  if (item.attribute.replace(/^attribute:/, "") !== expected.attribute) return false;
  if (expected.value === undefined) return true;
  return normalize(itemValue(item)) === normalize(expected.value);
}

export function scoreQuestion(question: EvalQuestion, result: RecallResult): Score {
  const answerable = question.answers.length > 0;
  const base = { id: question.id, category: question.category, answerable };
  if (!result.ok) {
    return { ...base, found: false, recall: 0, leaked: false, correct: false };
  }

  const items = result.items;
  const leaked = (question.forbidden ?? []).some((f) => items.some((item) => matches(item, f)));
  const ranks = question.answers.map((a) => items.findIndex((item) => matches(item, a)) + 1);
  const hit = ranks.filter((r) => r > 0);
  const recallRatio = answerable ? hit.length / question.answers.length : 0;
  const firstRank = hit.length > 0 ? Math.min(...hit) : undefined;

  const correct = answerable ? recallRatio === 1 && !leaked : !result.found && !leaked;
  return { ...base, found: result.found, recall: recallRatio, firstRank, leaked, correct };
}

export interface Summary {
  total: number;
  correct: number;
  accuracy: number;
  // Pertanyaan yang bisa dijawab.
  answerable: number;
  answeredFully: number;
  // Rata-rata porsi jawaban yang muncul.
  recall: number;
  // Jawaban benar di peringkat 1, dan rata-rata 1/peringkat.
  hitAt1: number;
  mrr: number;
  // Pertanyaan yang tidak bisa dijawab.
  unanswerable: number;
  abstained: number;
  // Porsi tak-bisa-dijawab yang tetap dijawab "ketemu" (risiko menebak). Makin kecil makin baik.
  falseAnswerRate: number;
  // Porsi hasil yang memuat fakta terlarang. Makin kecil makin baik.
  leakRate: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);

export function summarize(scores: Score[]): Summary {
  const answerable = scores.filter((s) => s.answerable);
  const unanswerable = scores.filter((s) => !s.answerable);
  const abstained = unanswerable.filter((s) => !s.found);
  return {
    total: scores.length,
    correct: scores.filter((s) => s.correct).length,
    accuracy: ratio(scores.filter((s) => s.correct).length, scores.length),
    answerable: answerable.length,
    answeredFully: answerable.filter((s) => s.recall === 1 && !s.leaked).length,
    recall: ratio(
      answerable.reduce((sum, s) => sum + s.recall, 0),
      answerable.length,
    ),
    hitAt1: ratio(answerable.filter((s) => s.firstRank === 1).length, answerable.length),
    mrr: ratio(
      answerable.reduce((sum, s) => sum + (s.firstRank ? 1 / s.firstRank : 0), 0),
      answerable.length,
    ),
    unanswerable: unanswerable.length,
    abstained: abstained.length,
    falseAnswerRate: ratio(unanswerable.length - abstained.length, unanswerable.length),
    leakRate: ratio(scores.filter((s) => s.leaked).length, scores.length),
  };
}

export function byCategory(scores: Score[]): Map<Category, Summary> {
  const groups = new Map<Category, Score[]>();
  for (const score of scores) {
    const group = groups.get(score.category) ?? [];
    group.push(score);
    groups.set(score.category, group);
  }
  return new Map([...groups].map(([category, group]) => [category, summarize(group)]));
}

export interface SweepPoint {
  minSimilarity: number;
  minKeywordCoverage: number;
  summary: Summary;
}

// Titik terbaik: jawaban lengkap terbanyak dengan false answer rate dan kebocoran di bawah
// batas; seri dipecah oleh akurasi total lalu ambang yang lebih ketat (lebih aman).
export function pickThreshold(
  points: SweepPoint[],
  maxFalseAnswerRate: number,
): SweepPoint | undefined {
  const safe = points.filter(
    (p) => p.summary.falseAnswerRate <= maxFalseAnswerRate && p.summary.leakRate === 0,
  );
  return safe.sort(
    (a, b) =>
      b.summary.answeredFully - a.summary.answeredFully ||
      b.summary.accuracy - a.summary.accuracy ||
      b.minSimilarity + b.minKeywordCoverage - (a.minSimilarity + a.minKeywordCoverage),
  )[0];
}
