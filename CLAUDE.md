# Agent Memory Kit

Library memori untuk AI agent, diinstall oleh aplikasi pemakai (misalnya aplikasi Sales Agent AI-Native). Penyimpanan di SurrealDB. **AI milik aplikasi pemakai yang memanggil tool memori ini**; library tidak memanggil LLM.

## Stack

- TypeScript (ESM), kode library di `src/` (`src/index.ts` = API publik, `src/core/` = internal). Target runtime: **Bun dan Node**. Kode di `src/` tidak boleh memakai API Bun (`Bun.*`, `bun:*`). Bun hanya untuk pengembangan: `bun test`, `bun install`.
- Penyimpanan: SurrealDB (dokumen + graf + full-text + vektor dalam satu basis data) lewat paket `surrealdb`. Engine dipilih pemakai: `rocksdb://`, `surrealkv://`, `mem://` (embedded lewat `@surrealdb/node`), atau `ws://`/`http://` (server remote). Semua memakai SurrealQL yang sama; tidak ada lapisan abstraksi database lain.
- Perintah: `bun run typecheck` (tsc), `bun run lint` / `bun run format` (Biome), `bun test`, `bun run test:coverage`. Jalankan typecheck, lint, dan test:coverage sebelum menyelesaikan pekerjaan.
- Tambah dependensi hanya bila perlu.

## Prinsip Desain

Lima persyaratan ini adalah kontrak sistem. Setiap perubahan harus menjaganya.
1. **Fakta terstruktur, bukan sekadar potongan chat.** Memori disimpan sebagai entitas, atribut, dan nilai. Potongan teks mentah hanya menjadi sumber, bukan unit memori.
2. **Sadar waktu.** Fakta lama ditutup (diberi waktu berakhir), tidak pernah dihapus. Sistem harus bisa menjawab "benar pada tanggal X". Pembaruan nilai = tutup fakta lama + buat fakta baru, dalam satu transaksi.
3. **Punya sumber (provenance).** Setiap fakta menunjuk ke teks asalnya. Fakta tanpa sumber tidak boleh disimpan. Setiap fakta membawa `quote` dari AI pemanggil, dan `remember` memverifikasi bahwa kutipan itu benar-benar ada di teks sumber (tanpa beda huruf/spasi, minimal 3 karakter) sebelum menulis apa pun.
4. **Pencarian hibrida.** Kombinasi kata kunci (full-text), makna (vektor), dan relasi (traversal graf). Hasil dari ketiganya digabung dan diperingkat. Tanpa embedder, jalur vektor dilewati dan sisanya tetap jalan.
5. **Berani menjawab "tidak tahu".** Jika data tidak ada atau skor retrieval di bawah ambang, hasilnya harus eksplisit `found: false` dengan pesan jangan menebak. Library tidak memanggil LLM untuk mengisi celah.

## Kontrak Library

- **Tanpa state global dan tanpa `process.env`.** Semua konfigurasi masuk lewat opsi `createMemory(options)`; semua state ada di instance (`Ctx` di `src/core/context.ts`). Fungsi internal menerima `ctx` sebagai argumen pertama. Aplikasi boleh membuat banyak instance. (Aturan lama "state module-level, jangan DI" sudah dicabut.)
- **Tanpa klien LLM.** AI pemanggil mengekstrak fakta dan mengirimnya terstruktur lewat tool. Satu-satunya yang pluggable adalah `embedder` (opsional): `{ model, dimension, maxBatch?, embed(texts, { kind: "document" | "query" }) }`. Model dan dimensi dicatat di `meta:embedding`; embedder yang berbeda dari yang tercatat (atau data lama tanpa vektor) ditolak dengan `embedder_mismatch`, kecuali `onEmbedderChange: "reindex"` atau `memory.reindex()`. Kegagalan embedder dilempar sebagai `MemoryError("embedder")` SEBELUM penulisan, jadi tidak ada data setengah tertulis.
- **Tool netral, tanpa adapter.** Definisi tool = `{ name, description, inputSchema (JSON Schema dari zod), execute }`. Aplikasi menempelkannya ke SDK AI-nya sendiri. `execute` memvalidasi input dan mengembalikan kegagalan yang bisa diperbaiki sebagai **data** (kode + saran), tidak melempar.
- **Scope = kepemilikan, buram bagi library.** Setiap panggilan tulis menerima satu `scope` (string bebas, misalnya `org:42/lead:7`); baca menerima satu atau beberapa scope. Library tidak tahu arti scope, tetapi **menegakkannya di lapisan query** (retrieval hibrida terjadi di dalam library, jadi filter tidak boleh diserahkan ke aplikasi). Entitas, sumber, dan fakta terikat scope; mereferensikan record scope lain ditolak, baik di kode (`scope_mismatch`) maupun di skema (ASSERT).
- **Kosakata atribut dikonfigurasi aplikasi** (`attributes`): `key`, `description`, `type` (`string|number|boolean|date|entity|json`), `cardinality` (`single|multi`), `aliases`. Library tidak membawa kosakata domain. Mode `vocabulary: "strict"` (default) menolak atribut tak dikenal dengan saran; `"open"` menerimanya sebagai `json` bernilai tunggal. Tabel `attribute` di DB hanya cermin konfigurasi (atribut yang dihapus dari konfigurasi ditandai `active = false`, tidak dihapus).
- **Penyimpanan** lewat `storage: { url }` (library membuka dan menutup koneksi) atau `storage: { db }` (instance `Surreal` milik aplikasi; library memakai session sendiri dan tidak menutup koneksinya). Path embedded dinormalisasi menjadi relatif terhadap cwd karena engine memotong drive Windows (`normalizeUrl`).
- **API publik** hanya yang diekspor `src/index.ts`: `createMemory`, tipe, `MemoryError`. Semver berlaku sejak rilis pertama. `assertFact`, `RecordId`, dan fungsi `src/core` lain bersifat internal.
- **Migrasi skema** otomatis saat `createMemory` (`migrate: "auto" | "check" | "off"`). Daftar `migrations` di `src/core/migrations.ts` **hanya boleh ditambah di akhir**; migrasi yang sudah dirilis tidak boleh diubah. Tiap migrasi idempoten (`DEFINE ... IF NOT EXISTS`), bersifat aditif bila mungkin, dan berjalan dalam transaksi bersama pembaruan `meta:schema`. Database yang versinya lebih baru dari library ditolak.

## Model Data (skema versi 3)

- `source`: `scope`, `content`, `received_at`, `meta`. Teks asal.
- `entity`: `scope`, `name`, `kind`, `aliases`, `embedding` (opsional), `keys` (nama + alias ter-normalisasi, dihitung DB lewat `VALUE`; harus identik dengan `entityKey()` di `entities.ts`: trim + huruf kecil). Index `(scope, keys)`.
- `attribute`: cermin kosakata (id = key).
- `fact`: `scope`, `entity`, `attribute`, `value` (literal, atau referensi `entity` untuk relasi), `valid_from`, `valid_to` (`NONE` = masih berlaku), `source` wajib, `quote` (opsional di skema, selalu diisi oleh `remember`), `text` (kalimat fakta untuk full-text dan embedding, mis. "PT Maju · anggaran: 75000000 — Budget naik jadi 75 juta"). **Satu struktur untuk atribut dan relasi**; tidak ada tabel edge `RELATE`. Edge ditambahkan hanya bila pengukuran menunjukkan traversal membutuhkannya.
- `meta`: `meta:schema` (versi skema) dan `meta:embedding` (model + dimensi vektor).
- Partisi vektor `fvec_<hash(scope)>` (fakta) dan `evec_<hash(scope)>` (entitas): satu tabel + satu index HNSW per scope, dibuat lazy dan idempoten (`vectors.ts`). Baris vektor memakai id yang sama dengan fakta/entitasnya; `fvec` membawa `valid_from`/`valid_to` yang disinkronkan saat fakta ditutup (dalam transaksi yang sama). Ini **data turunan**: boleh dihapus dan dibangun ulang (`reindex`), tidak melanggar aturan "jangan hapus fakta".
- Index lain: full-text BM25 pada `fact.text` (analyzer `blank, class, punct` + `ascii, lowercase`, tanpa stemmer karena multibahasa), `fact(scope, value)` untuk pencarian balik relasi, `entity(scope, keys)`.
- Query "pada tanggal X": `valid_from <= X AND (valid_to = NONE OR valid_to > X)`. Index selalu berawalan `scope`.
- `single`: nilai baru menutup nilai lama. `multi`: nilai ditambah, nilai lain tidak disentuh; penutupan lewat `retractFact`.

## remember

`memory.remember({ scope, source: { content, received_at?, meta? }, facts: [{ entity, attribute, value, quote, valid_from? }] })`. Input berupa JSON murni (tanggal ISO string) supaya skemanya (`rememberSchema`) bisa menjadi JSON Schema tool.
- **Dua tahap.** Tahap 1 hanya membaca: skema input, atribut (strict/open), tipe nilai, kutipan, dan resolusi entitas untuk semua fakta. Satu saja yang tidak valid = **tidak ada yang ditulis**, dan semua galat dikembalikan sekaligus (`{ ok: false, stage: "validation", errors }`, tiap galat punya `index`, `code`, `details`). Tahap 2 menulis sumber, entitas baru, lalu fakta menurut urutan waktu berlaku (urutan input tidak memicu `stale_time`). Kegagalan saat menulis (mis. `stale_time` karena menyisipkan fakta lebih lama dari yang berlaku) dilaporkan per fakta (`stage: "write"`); yang berhasil tetap tersimpan.
- **Rujukan entitas:** string (nama), `{ name, kind? }`, atau `{ id: "entity:..." }`. Resolusi: nama/alias persis (tanpa beda huruf) dalam scope. Satu cocok = dipakai (kind hanya petunjuk); lebih dari satu = `kind` menyaring, sisanya `ambiguous_entity` dengan daftar kandidat; tidak ada = dibuat (kind default `unknown`). Entitas yang sama disebut berkali-kali dalam satu panggilan = satu entitas. Untuk atribut bertipe `entity`, nilai memakai bentuk rujukan yang sama.
- `valid_from` default = `received_at` sumber (waktu fakta disampaikan), bukan waktu pemrosesan.
- Id di antarmuka berbentuk teks `tabel:id` (`idToString`/`parseId` di `ids.ts`). Id dibuat tanpa tanda minus (`newId`).
- Belum ada pencegahan duplikat entitas pada panggilan `remember` yang bersamaan (dua proses membuat entitas bernama sama sekaligus); tidak ada unique index karena nama sama boleh dipakai entitas berbeda kind.

## Vektor dan recall

**Mengapa vektor per scope.** Terukur di SurrealDB 3.x: KNN dengan filter scope berbiaya linier terhadap ukuran scope (0,3-2 detik pada 90 ribu baris, dan filter `valid_to` di dalam KNN lebih buruk), sedangkan KNN tanpa filter cepat. Jadi KNN selalu dijalankan tanpa filter di dalam partisi scope, dan validitas waktu disaring sesudahnya (ambil kandidat lebih banyak, perluas bila perlu, batas 2000). Jangan menambah filter ke operator `<|k,ef|>`.

`memory.recall({ scope (string | string[]), query, as_of?, limit?, min_similarity?, min_keyword_coverage? })` menggabungkan tiga kanal:
- **Vektor:** ANN pada `fvec` (query di-embed dengan `kind: "query"`).
- **Kata kunci:** BM25 dengan semantik OR (`@0,OR@`) pada `fact.text`. Skor BM25 hanya dipakai untuk peringkat: pada korpus kecil bisa 0 walau kata cocok persis. Bukti kata kunci = **cakupan istilah query** (porsi istilah bermakna, tanpa kata tanya/penghubung dari `contentTerms`, yang ada di teks fakta).
- **Graf:** entitas yang disebut (n-gram query dicocokkan ke `entity.keys`, dan kemiripan makna ke `evec`), lalu fakta langsung entitas itu dan fakta berelasi satu lompatan (nilai yang menunjuk ke entitas itu, atau milik entitas yang ditunjuk faktanya). Kandidat graf yang lolos dari ANN dinilai kemiripannya lewat lookup id langsung.

Fusi RRF (bobot vektor 1, kata kunci 1, graf 0,5). **Skor RRF berbasis peringkat sehingga selalu menghasilkan sesuatu**; yang menentukan "tahu atau tidak" adalah ambang absolut: kemiripan kosinus >= `minSimilarity` ATAU cakupan istilah >= `minKeywordCoverage`. Fakta yang hanya terhubung lewat entitas tanpa bukti isi **tidak** dikembalikan. Hasil tanpa bukti = `{ found: false, items: [], linked_entities, message: "... Jangan menebak." }`.

**Ambang bawaan (0,5 / 0,5) belum dikalibrasi.** Kemiripan bergantung pada model embedding; kalibrasi dengan set evaluasi berlabel (pertanyaan yang bisa dan tidak bisa dijawab) pada model sungguhan sebelum dipakai produksi. Tes memakai embedder palsu (bag-of-words) yang hanya menguji mekanisme, bukan mutu semantik.

## Aturan Kerja

- Jangan pernah `DELETE` fakta untuk menangani perubahan; tutup dengan `valid_to`. Penghapusan nyata hanya lewat `forget` untuk permintaan privasi eksplisit (satu-satunya jalur `DELETE`, khusus aplikasi, bukan tool AI; belum dibuat).
- Semua input dari luar (opsi, argumen tool) divalidasi zod sebelum menyentuh DB.
- Kegagalan yang bisa diperbaiki pemanggil memakai `MemoryError` dengan `code` stabil dan `details` terstruktur. Di dalam transaksi SurrealQL, `THROW "kode:detail"` lalu dipetakan kembali di TypeScript.
- Kunci API dan kredensial tidak ada di library; mereka milik aplikasi.
- Komentar dan pesan galat berbahasa Indonesia, mengikuti kode yang ada.

## Pengujian

- `bun test`, root `tests/`: `tests/units/` (satu modul; DB nyata `mem://` boleh dipakai karena logika ada di SurrealQL), `tests/features/` (alur ujung ke ujung; hanya batas eksternal yang dipalsukan), `tests/support/` (helper `openTestContext`).
- Coverage line dan function minimal 95% (`bunfig.toml`, gagal otomatis). Skenario fitur diturunkan dari 5 prinsip desain, bukan dari angka coverage. Modul baru dibuat bersama tes unit dan skenario fitur-nya.
- Builder SDK (`db.create(...)`, `db.query(...)`) bersifat thenable, bukan Promise: bungkus dengan fungsi `async` sebelum memakai `expect(...).rejects`.
- `rmSync` Bun di Windows gagal diam-diam untuk path relatif `./...`; pakai `path.resolve` untuk path yang dihapus.
- Test untuk penyimpanan embedded sungguhan (`rocksdb://`) ditaruh di `data/` (di-ignore git) dan dibersihkan sendiri.

## Status

Selesai: opsi + validasi, penyimpanan (url/db), migrasi (v1-v3), kosakata atribut, `source`/`entity`, `assertFact` / `retractFact` / `factsAt`, `remember` (validasi dua tahap, verifikasi kutipan, resolusi entitas persis, embedding), `embedder` pluggable + `meta:embedding` + `reindex`, partisi vektor per scope, `recall` hibrida (vektor + BM25 + graf, RRF, ambang "tidak tahu").
Belum: **kalibrasi ambang dan harness benchmark** (korpus realistis, dimensi 768-1536, skala ratusan ribu fakta per scope; pengukuran spike hanya data sintetis), resolusi entitas longgar lewat kemiripan (saat ini hanya nama/alias persis), penyisipan riwayat yang lebih lama dari fakta berlaku (`stale_time`), tool netral (`remember`/`recall`/`list_attributes`), `forget`, build/exports untuk npm, smoke test Node, README pemakai.
