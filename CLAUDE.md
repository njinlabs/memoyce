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
3. **Punya sumber (provenance).** Setiap fakta menunjuk ke teks asalnya. Fakta tanpa sumber tidak boleh disimpan. Kutipan yang diberikan AI pemanggil harus benar-benar ada di teks sumber (diverifikasi library, belum dibuat).
4. **Pencarian hibrida.** Kombinasi kata kunci (full-text), makna (vektor), dan relasi (traversal graf). Hasil dari ketiganya digabung dan diperingkat. Tanpa embedder, jalur vektor dilewati dan sisanya tetap jalan.
5. **Berani menjawab "tidak tahu".** Jika data tidak ada atau skor retrieval di bawah ambang, hasilnya harus eksplisit `found: false` dengan pesan jangan menebak. Library tidak memanggil LLM untuk mengisi celah.

## Kontrak Library

- **Tanpa state global dan tanpa `process.env`.** Semua konfigurasi masuk lewat opsi `createMemory(options)`; semua state ada di instance (`Ctx` di `src/core/context.ts`). Fungsi internal menerima `ctx` sebagai argumen pertama. Aplikasi boleh membuat banyak instance. (Aturan lama "state module-level, jangan DI" sudah dicabut.)
- **Tanpa klien LLM.** AI pemanggil mengekstrak fakta dan mengirimnya terstruktur lewat tool. Satu-satunya yang pluggable adalah `embedder` (opsional; dimensi dan model dicatat di `meta`, ganti model = `reindex()`).
- **Tool netral, tanpa adapter.** Definisi tool = `{ name, description, inputSchema (JSON Schema dari zod), execute }`. Aplikasi menempelkannya ke SDK AI-nya sendiri. `execute` memvalidasi input dan mengembalikan kegagalan yang bisa diperbaiki sebagai **data** (kode + saran), tidak melempar.
- **Scope = kepemilikan, buram bagi library.** Setiap panggilan tulis menerima satu `scope` (string bebas, misalnya `org:42/lead:7`); baca menerima satu atau beberapa scope. Library tidak tahu arti scope, tetapi **menegakkannya di lapisan query** (retrieval hibrida terjadi di dalam library, jadi filter tidak boleh diserahkan ke aplikasi). Entitas, sumber, dan fakta terikat scope; mereferensikan record scope lain ditolak, baik di kode (`scope_mismatch`) maupun di skema (ASSERT).
- **Kosakata atribut dikonfigurasi aplikasi** (`attributes`): `key`, `description`, `type` (`string|number|boolean|date|entity|json`), `cardinality` (`single|multi`), `aliases`. Library tidak membawa kosakata domain. Mode `vocabulary: "strict"` (default) menolak atribut tak dikenal dengan saran; `"open"` menerimanya sebagai `json` bernilai tunggal. Tabel `attribute` di DB hanya cermin konfigurasi (atribut yang dihapus dari konfigurasi ditandai `active = false`, tidak dihapus).
- **Penyimpanan** lewat `storage: { url }` (library membuka dan menutup koneksi) atau `storage: { db }` (instance `Surreal` milik aplikasi; library memakai session sendiri dan tidak menutup koneksinya). Path embedded dinormalisasi menjadi relatif terhadap cwd karena engine memotong drive Windows (`normalizeUrl`).
- **API publik** hanya yang diekspor `src/index.ts`: `createMemory`, tipe, `MemoryError`. Semver berlaku sejak rilis pertama. `assertFact`, `RecordId`, dan fungsi `src/core` lain bersifat internal.
- **Migrasi skema** otomatis saat `createMemory` (`migrate: "auto" | "check" | "off"`). Daftar `migrations` di `src/core/migrations.ts` **hanya boleh ditambah di akhir**; migrasi yang sudah dirilis tidak boleh diubah. Tiap migrasi idempoten (`DEFINE ... IF NOT EXISTS`), bersifat aditif bila mungkin, dan berjalan dalam transaksi bersama pembaruan `meta:schema`. Database yang versinya lebih baru dari library ditolak.

## Model Data (skema versi 1)

- `source`: `scope`, `content`, `received_at`, `meta`. Teks asal.
- `entity`: `scope`, `name`, `kind`, `aliases`, `embedding` (opsional). Resolusi entitas (alias, kemiripan) belum dibuat.
- `attribute`: cermin kosakata (id = key).
- `fact`: `scope`, `entity`, `attribute`, `value` (literal, atau referensi `entity` untuk relasi), `valid_from`, `valid_to` (`NONE` = masih berlaku), `source` wajib. **Satu struktur untuk atribut dan relasi**; tidak ada tabel edge `RELATE`. Edge ditambahkan hanya bila pengukuran menunjukkan traversal membutuhkannya.
- `meta`: `meta:schema` menyimpan versi skema.
- Query "pada tanggal X": `valid_from <= X AND (valid_to = NONE OR valid_to > X)`. Index selalu berawalan `scope`.
- `single`: nilai baru menutup nilai lama. `multi`: nilai ditambah, nilai lain tidak disentuh; penutupan lewat `retractFact`.

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

Selesai: opsi + validasi, penyimpanan (url/db), migrasi, kosakata atribut, `source`/`entity`, `assertFact` / `retractFact` / `factsAt` (temporal, scope, kardinalitas, nilai referensi).
Belum: `remember` (verifikasi kutipan, resolusi entitas), `recall` hibrida (full-text, vektor, graf, fusi, ambang), tool netral, `embedder` + `reindex`, `forget`, build/exports untuk npm, smoke test Node, README pemakai.
