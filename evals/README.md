# Set evaluasi retrieval

Mengukur seberapa akurat `memory.recall` pada embedding sungguhan, dan **di mana** ia salah. Bukan bagian
library (tidak ikut paket, `run.ts` dikecualikan dari coverage); membaca environment variable boleh di sini.

## Menjalankan

Isi `.env` (kunci Gemini atau OpenAI, lihat `.env.example`), lalu:

```
bun run eval                       # ringkasan per kategori pada ambang bawaan
bun run eval --failures            # + daftar pertanyaan yang gagal dan alasannya
bun run eval --sweep               # + sapuan ambang (sim x coverage) dan usulan titik
bun run eval --similarity 0.76 --coverage 0.5
bun run eval --language id         # aplikasi mengisi daftar kata fungsi/gelar Indonesia (bawaan: tanpa daftar, netral bahasa)
EMBEDDING_PROVIDER=none bun run eval   # tanpa vektor (kata kunci + graf): mengukur sumbangan vektor
bun run eval --rewrite             # Gemini menulis ulang query dari deskripsi tool (deskripsi lama vs baru)
bun run eval --signals             # sinyal mentah (kosinus, cakupan kata, hubungan entitas) per pertanyaan
```

Tanpa kunci API, `bun test tests/units/eval.test.ts` tetap memvalidasi dataset dan harness
(embedder palsu: hanya mekanisme, bukan mutu semantik).

Embedding di-cache di `data/eval-embeddings.json` (di-ignore git; kunci memuat model), jadi menjalankan
ulang setelah mengubah `recall` cepat dan tidak memakai kuota API. Teks baru otomatis di-embed sendiri.

## Apa yang diukur

Fakta **sudah diekstrak** (ditulis tangan di `dataset.ts`), jadi yang dinilai adalah `remember` + `recall`,
bukan mutu ekstraksi LLM. Korpus: ±35 fakta inti (alur PT Maju dengan riwayat nilai berubah, entitas bernama
mirip, tenant kedua `org:2`) + 24 lead sintetis sebagai distraktor.

| Kategori         | Menguji                                                                                                          | Prinsip       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| `direct`         | istilah pertanyaan = istilah fakta                                                                               | 4             |
| `paraphrase`     | makna sama, kata beda (kanal vektor)                                                                             | 4             |
| `multi`          | atribut `multi`: semua nilai harus muncul                                                                        | 1             |
| `temporal`       | "benar pada tanggal X"; nilai lama tidak boleh bocor                                                             | 2             |
| `relation`       | satu dan dua lompatan lewat entitas lain (kanal graf)                                                            | 4             |
| `near_miss`      | `PT Maju` vs `PT Maju Jaya` tidak boleh tertukar                                                                 | 1             |
| `entity_variant` | "Budi", "Ibu Sari", "Nusantara Logistik": resolusi longgar                                                       | 1             |
| `scope`          | isolasi antar tenant, nama entitas sama                                                                          | kontrak scope |
| `scale`          | jawaban tetap benar di tengah distraktor                                                                         | 4             |
| `unanswerable`   | harus `found: false` (atribut tak pernah disebut, entitas tak ada, di luar topik, sebelum fakta ada, scope lain) | 5             |

Sekitar sepertiga pertanyaan tidak bisa dijawab; tanpa itu ambang "tidak tahu" tidak terukur.

## Membaca hasil

- **lengkap**: pertanyaan bisa dijawab dan semua jawaban berlabel muncul tanpa fakta terlarang.
- **tolak / salah**: pada yang tak bisa dijawab, berapa yang dijawab "tidak tahu" (baik) vs tetap `found: true`
  (menebak). `salah` adalah angka paling penting untuk produk: AI akan memakai apa pun yang dikembalikan.
- **bocor**: hasil memuat fakta terlarang (nilai lama, entitas mirip, scope lain). Target 0%.
- **hit@1 / mrr**: apakah jawaban benar ada di peringkat teratas (AI cenderung memakai hasil pertama).

Ambang dipilih dengan `--sweep`: titik dengan jawaban lengkap terbanyak yang `salah` <= `--max-false-answer`
(bawaan 5%) dan tanpa kebocoran. Ulangi untuk setiap model embedding; ambang tidak berpindah antar model.

## Menambah pertanyaan

Tambahkan di `questions` pada `dataset.ts`. Label jawaban memakai `(entity, attribute, value)`, bukan id.
Jika pertanyaan butuh fakta baru, tambahkan ke langkah `seedSteps`. Tes `eval.test.ts` memastikan kutipan
benar dan setiap label menunjuk fakta yang ada. Tambahkan pertanyaan dari kegagalan nyata yang ditemukan
di aplikasi, terutama yang tak terjawab tetapi dijawab.

## Batasan

- Dataset kecil dan sintetis; cukup untuk membandingkan konfigurasi dan menemukan kelas kesalahan, belum
  cukup untuk menjanjikan angka produksi. Perluas dengan data percakapan nyata (dianonimkan).
- Korpus berbahasa Indonesia saja.
- Ratusan ribu fakta per scope tidak tercakup di sini; itu urusan benchmark skala terpisah.
