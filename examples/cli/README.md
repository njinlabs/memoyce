# Aplikasi uji CLI

Chat di terminal dengan **Gemini** yang memakai memori dari library ini lewat tool. Tujuannya
menguji dengan LLM sungguhan hal-hal yang tidak bisa dibuktikan tes otomatis: apakah model patuh
pada deskripsi tool (kutipan persis, atribut yang benar), dan apakah ambang "tidak tahu" masuk akal.

Ini bukan bagian library: tidak ikut paket, tidak ikut coverage. Logika intinya (`agent.ts`,
`embedders.ts`) tetap dites tanpa jaringan di `tests/units/example-cli.test.ts`.

## Menjalankan

```bash
cp .env.example .env     # lalu isi GEMINI_API_KEY
bun run example:cli
```

- `GEMINI_API_KEY` wajib (https://aistudio.google.com/apikey).
- Embedding untuk pencarian makna: memakai OpenAI bila `OPENAI_API_KEY` diisi, selain itu memakai
  embedding Gemini dengan kunci yang sama. `EMBEDDING_PROVIDER=none` mematikan vektor.
- Model bawaan `gemini-3.5-flash-lite`; ganti lewat `GEMINI_MODEL` (daftar model berubah, cek
  dokumentasi Gemini bila model ditolak).
- Data disimpan di RocksDB `./data/cli-demo` (di-ignore git). Hanya satu proses yang boleh membuka
  database yang sama pada satu waktu.

Opsi: `--scope <nama>` (pemilik memori; bawaan `demo:lead-1`), `--db <path>`, `--window <N>`
(jumlah giliran riwayat yang dikirim ke model; bawaan 6), `--quiet` (sembunyikan jejak tool),
`--reindex` (izinkan membangun ulang vektor bila embedding diganti).

Perintah di dalam chat: `/recall <pertanyaan>` (jalankan pencarian langsung dan lihat bukti serta
sinyalnya), `/clear` (kosongkan riwayat chat, memori tetap), `/tools`, `/reindex`, `/exit`.

## Skenario uji yang disarankan

1. **Menyimpan dengan bukti.** "Budi dari PT Maju tanya paket Pro. Budget sekitar 50 juta, yang
   memutuskan Ibu Sari." Perhatikan jejak `memory_remember`: apakah model memakai atribut yang
   benar dan kutipan persis? Bila ditolak, apakah ia memperbaiki sendiri?
2. **Memori melampaui riwayat.** `/clear` (atau `--window 1` lalu banyak ngobrol), lalu tanya
   "berapa budget PT Maju?". Jawabannya harus datang dari memori, bukan riwayat.
3. **Perubahan nilai.** "Kabar baru, budget PT Maju naik jadi 75 juta." Lalu tanya budget
   sekarang dan "berapa budget bulan lalu?" (`/recall` dengan tanggal lewat pertanyaan model).
4. **Berani tidak tahu.** Tanyakan hal yang tidak pernah disebut ("siapa direktur PT Maju?").
   Model harus mengaku tidak tahu, bukan mengarang.
5. **Pertanyaan parafrase.** Tanya dengan kata berbeda ("dana yang tersedia buat Maju berapa?")
   untuk melihat sumbangan jalur vektor di `signals` pada `/recall`.

## Mengkalibrasi ambang

Ambang bawaan (`minSimilarity` 0,5 dan `minKeywordCoverage` 0,5) belum dikalibrasi untuk model
embedding mana pun. Atur sementara lewat env, lalu amati `/recall`:

```bash
MIN_SIMILARITY=0.6 bun run example:cli
```

- Terlalu rendah: pertanyaan yang tidak relevan tetap mengembalikan fakta (salah "tahu").
- Terlalu tinggi: pertanyaan relevan dijawab "tidak tahu".

Catat beberapa pasang pertanyaan yang seharusnya bisa dan tidak bisa dijawab beserta nilai
`signals.vector`-nya; itu bahan untuk set evaluasi berlabel.
