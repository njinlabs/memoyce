# Agent Memory Layer

Lapisan memori untuk AI agent yang bisa dijalankan sendiri (self-hosted). Penyimpanan di SurrealDB; LLM dipanggil lewat API pihak ketiga yang sudah ada (bukan model lokal).

## Stack

- Runtime: Bun, TypeScript (ESM), entry point `index.ts`
- Penyimpanan: SurrealDB embedded, backend RocksDB (`@surrealdb/node`, tanpa server terpisah, tanpa auth); data di `SURREAL_PATH`. Kode inti di `src/core`. Env divalidasi zod di `src/core/config.ts`. SurrealDB (dokumen + graf + full-text + vektor dalam satu basis data)
- LLM: API pihak ketiga, dipakai untuk ekstraksi fakta, embedding, dan penjawab
- Typecheck: `bun run typecheck`
- Lint + format: Biome (`bun run lint` untuk cek, `bun run format` untuk memperbaiki otomatis). Jalankan keduanya sebelum menyelesaikan pekerjaan.

## Prinsip Desain

Lima persyaratan ini adalah kontrak sistem. Setiap perubahan harus menjaganya.
1. **Fakta terstruktur, bukan sekadar potongan chat.** Memori disimpan sebagai entitas, atribut, dan nilai. Potongan teks mentah hanya menjadi sumber, bukan unit memori.
2. **Sadar waktu.** Fakta lama ditutup (diberi waktu berakhir), tidak pernah dihapus. Sistem harus bisa menjawab "benar pada tanggal X". Pembaruan nilai = tutup fakta lama + buat fakta baru, dalam satu transaksi.
3. **Punya sumber (provenance).** Setiap fakta menunjuk ke teks asalnya. Fakta tanpa sumber tidak boleh disimpan.
4. **Pencarian hibrida.** Kombinasi kata kunci (full-text), makna (vektor), dan relasi (traversal graf). Hasil dari ketiganya digabung dan diperingkat.
5. **Berani menjawab "tidak tahu".** Jika data tidak ada atau skor retrieval di bawah ambang, jawabannya harus eksplisit tidak tahu. Jangan mengisi celah dengan tebakan LLM.

## Model Data (rancangan awal, belum final)

- `entity`: objek yang diketahui (orang, organisasi, tempat, dst.), dengan alias dan embedding
- `source`: teks asal (pesan/dokumen), dengan waktu diterima
- `fact`: relasi entitas -> atribut -> nilai, dengan `valid_from`, `valid_to` (kosong = masih berlaku), dan `source` wajib
- Relasi antar entitas disimpan sebagai edge graf SurrealDB (`RELATE`), juga dengan rentang waktu dan sumber
- Query "pada tanggal X": `valid_from <= X AND (valid_to = NONE OR valid_to > X)`

## Aturan Kerja

- Jangan pernah `DELETE` fakta untuk menangani perubahan; tutup dengan `valid_to`. Penghapusan nyata hanya untuk permintaan privasi eksplisit.
- Output LLM untuk ekstraksi harus divalidasi skemanya sebelum ditulis ke DB.
- Kunci API LLM hanya lewat environment variable, tidak boleh di kode atau repo.
- Init hanya sekali di `index.ts` (`loadConfig()` lalu `connectDb()`). Modul di `src/core` saling memakai state modul-level (`env`, `db`) secara langsung; ini desain yang disengaja, jangan diubah menjadi dependency injection.
- Gunakan API Bun bawaan bila ada; tambah dependensi hanya bila perlu.

## Status

Baru dimulai: baru ada kerangka proyek Bun. Skema, ekstraksi, dan retrieval belum dibuat.
