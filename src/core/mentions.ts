const MAX_NGRAM = 4;
const MAX_PARTIAL_GRAM = 4;
const MIN_PARTIAL_TOKEN = 3;

const words = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// n-gram kata (1..4) dari query, untuk mencocokkan nama/alias entitas secara persis.
export function ngrams(query: string): string[] {
  const list = words(query);
  const grams = new Set<string>();
  for (let size = 1; size <= MAX_NGRAM; size++) {
    for (let i = 0; i + size <= list.length; i++) grams.add(list.slice(i, i + size).join(" "));
  }
  return [...grams].slice(0, 300);
}

export interface NamedEntity {
  id: string;
  scope: string;
  // Nama + alias ter-normalisasi (`entity.keys`).
  keys: string[];
}

interface Span {
  start: number;
  end: number;
}

function spansOf(list: string[], keys: string[]): Span[] {
  const spans: Span[] = [];
  for (const key of new Set(keys)) {
    const size = key.split(/\s+/).filter(Boolean).length;
    if (size === 0) continue;
    for (let i = 0; i + size <= list.length; i++) {
      if (list.slice(i, i + size).join(" ") === key) spans.push({ start: i, end: i + size });
    }
  }
  return spans;
}

const length = (span: Span): number => span.end - span.start;
const inside = (inner: Span, outer: Span): boolean =>
  outer.start <= inner.start && outer.end >= inner.end && length(outer) > length(inner);

interface Spanned {
  id: string;
  scope: string;
  spans: Span[];
}

// Entitas yang SEMUA penyebutannya berada di dalam penyebutan entitas lain yang lebih panjang
// (dalam scope yang sama).
function shadowedBy(items: Spanned[]): Set<string> {
  const shadowed = new Set<string>();
  for (const item of items) {
    if (item.spans.length === 0) continue;
    const others = items.filter((o) => o.id !== item.id && o.scope === item.scope);
    if (item.spans.every((span) => others.some((o) => o.spans.some((t) => inside(span, t))))) {
      shadowed.add(item.id);
    }
  }
  return shadowed;
}

// Kecocokan terpanjang menang: entitas yang SEMUA penyebutannya di query hanyalah bagian dari
// penyebutan entitas lain yang lebih panjang (dalam scope yang sama) adalah salah sasaran.
// Contoh: "PT Maju Jaya" memuat "pt maju", tetapi yang ditanya PT Maju Jaya, bukan PT Maju.
// Bila PT Maju juga disebut di tempat lain pada query, ia tetap dianggap disebut.
export function shadowedEntities(query: string, entities: NamedEntity[]): Set<string> {
  const list = words(query);
  return shadowedBy(entities.map((e) => ({ ...e, spans: spansOf(list, e.keys) })));
}

// Posisi kata pada query yang sudah dijelaskan oleh penyebutan entitas persis.
export function coveredPositions(query: string, entities: NamedEntity[]): Set<number> {
  const list = words(query);
  const covered = new Set<number>();
  for (const entity of entities) {
    for (const span of spansOf(list, entity.keys)) {
      for (let i = span.start; i < span.end; i++) covered.add(i);
    }
  }
  return covered;
}

// Rangkaian kata query yang masih mungkin menyebut entitas sebagian: bukan gelar, bukan kata
// yang dikecualikan (kata tanya, kata atribut), dan belum dijelaskan penyebutan persis.
function partialRuns(
  list: string[],
  covered: Set<number>,
  ignore: Set<string>,
  titles: ReadonlySet<string>,
): { start: number; tokens: string[] }[] {
  const runs: { start: number; tokens: string[] }[] = [];
  let current: { start: number; tokens: string[] } | undefined;
  for (const [i, word] of list.entries()) {
    const eligible = !covered.has(i) && !titles.has(word) && !ignore.has(word);
    if (!eligible) {
      current = undefined;
      continue;
    }
    if (!current) {
      current = { start: i, tokens: [] };
      runs.push(current);
    }
    current.tokens.push(word);
  }
  return runs;
}

// Kata query yang layak dicari di indeks kata entitas (penyaring awal sebelum pencocokan teliti).
export function partialLookupWords(
  query: string,
  covered: Set<number>,
  ignore: Set<string>,
  titles: ReadonlySet<string>,
): string[] {
  const found = partialRuns(words(query), covered, ignore, titles)
    .flatMap((run) => run.tokens)
    .filter((token) => token.length >= MIN_PARTIAL_TOKEN && !/^\d+$/.test(token));
  return [...new Set(found)];
}

const contains = (haystack: string[], needle: string[]): boolean => {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true;
  }
  return false;
};

// Nama sebagian: sebuah rangkaian kata query sama dengan potongan berurutan dari nama/alias
// entitas (tanpa gelar). "Budi" -> Budi Santoso; "Nusantara Logistik" -> PT Nusantara Logistik.
// Penyebutan yang lebih panjang menang atas yang lebih pendek (entitas lain pada scope sama).
// Bila beberapa entitas cocok sama baiknya (dua "Budi"), semuanya dikembalikan: jawabannya
// memuat nama masing-masing sehingga pemanggil bisa membedakan, tidak ditebak satu.
export function partialEntities(
  query: string,
  entities: NamedEntity[],
  covered: Set<number>,
  ignore: Set<string>,
  titles: ReadonlySet<string>,
): Set<string> {
  const list = words(query);
  const runs = partialRuns(list, covered, ignore, titles);
  const spanned: Spanned[] = entities.map((entity) => {
    const cores = entity.keys.map((key) => words(key).filter((w) => !titles.has(w)));
    const spans: Span[] = [];
    for (const run of runs) {
      for (let size = 1; size <= Math.min(MAX_PARTIAL_GRAM, run.tokens.length); size++) {
        for (let s = 0; s + size <= run.tokens.length; s++) {
          const gram = run.tokens.slice(s, s + size);
          const shortSingle =
            size === 1 &&
            ((gram[0] as string).length < MIN_PARTIAL_TOKEN || /^\d+$/.test(gram[0] as string));
          if (shortSingle) continue;
          if (cores.some((core) => contains(core, gram))) {
            spans.push({ start: run.start + s, end: run.start + s + size });
          }
        }
      }
    }
    return { id: entity.id, scope: entity.scope, spans };
  });
  const shadowed = shadowedBy(spanned);
  return new Set(spanned.filter((e) => e.spans.length > 0 && !shadowed.has(e.id)).map((e) => e.id));
}
