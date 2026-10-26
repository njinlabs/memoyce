import type { RememberInput } from "../src/index";

// Set evaluasi retrieval. Fakta sudah diekstrak (tulisan tangan), jadi yang diukur adalah
// penyimpanan + recall, BUKAN mutu ekstraksi LLM. Kosakata atribut: examples/cli/attributes.ts.
//
// Dua scope: org:1 (korpus utama) dan org:2 (tenant lain dengan nama entitas yang sama, untuk
// menguji isolasi). Titik waktu dibuat berurutan agar pertanyaan "pada tanggal X" punya
// jawaban pasti. Setiap pertanyaan diberi label jawaban yang BENAR dan (bila perlu) jawaban yang
// TIDAK BOLEH muncul (nilai lama, entitas mirip, scope lain).

export type Category =
  | "direct"
  | "paraphrase"
  | "multi"
  | "temporal"
  | "relation"
  | "near_miss"
  | "entity_variant"
  | "scope"
  | "scale"
  | "unanswerable";

// Fakta yang diharapkan. `value` diabaikan bila tidak diisi; untuk nilai bertipe entitas, isi
// dengan nama entitasnya.
export interface Expected {
  entity: string;
  attribute: string;
  value?: string | number | boolean;
}

export interface EvalQuestion {
  id: string;
  category: Category;
  scope: string | string[];
  query: string;
  as_of?: string;
  // Fakta yang harus muncul. Kosong = pertanyaan tidak bisa dijawab (harus `found: false`).
  answers: Expected[];
  // Fakta yang tidak boleh muncul sama sekali (nilai lama, entitas mirip, scope lain).
  forbidden?: Expected[];
}

export type SeedStep = RememberInput;

const ORG1 = "org:1";
const ORG2 = "org:2";

const maju = { name: "PT Maju", kind: "organization" } as const;

// ---------------------------------------------------------------------------------------------
// Korpus inti org:1 (alur penjualan PT Maju dari discovery sampai closed won, dengan riwayat)
// ---------------------------------------------------------------------------------------------
const coreSteps: SeedStep[] = [
  {
    scope: ORG1,
    source: {
      received_at: "2026-01-12T09:00:00Z",
      content:
        "Catatan telepon pertama: Budi Santoso, Kepala Pengadaan di PT Maju (Bandung), " +
        "menanyakan paket Pro untuk 200 pengguna. Anggaran sekitar 50 juta. Keputusan akhir " +
        "ada di Ibu Sari Wulandari, direktur operasional. Budi bilang tim mereka sering " +
        "kesulitan karena data pelanggan tersebar di banyak spreadsheet.",
    },
    facts: [
      { entity: maju, attribute: "city", value: "Bandung", quote: "PT Maju (Bandung)" },
      { entity: "PT Maju", attribute: "stage", value: "discovery", quote: "menanyakan paket Pro" },
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 50_000_000,
        quote: "Anggaran sekitar 50 juta",
      },
      {
        entity: "PT Maju",
        attribute: "decision_maker",
        value: { name: "Sari Wulandari", kind: "person" },
        quote: "Ibu Sari Wulandari",
      },
      {
        entity: "PT Maju",
        attribute: "pain_point",
        value: "data pelanggan tersebar di banyak spreadsheet",
        quote: "data pelanggan tersebar di banyak spreadsheet",
      },
      {
        entity: { name: "Budi Santoso", kind: "person" },
        attribute: "works_for",
        value: "PT Maju",
        quote: "Budi Santoso, Kepala Pengadaan di PT Maju",
      },
      {
        entity: "Budi Santoso",
        attribute: "role",
        value: "Kepala Pengadaan",
        quote: "Kepala Pengadaan",
      },
      {
        entity: "Sari Wulandari",
        attribute: "role",
        value: "Direktur Operasional",
        quote: "direktur operasional",
      },
    ],
  },
  {
    scope: ORG1,
    source: {
      received_at: "2026-02-03T14:00:00Z",
      content:
        "Demo untuk PT Maju selesai. Budi minta integrasi dengan WhatsApp dan laporan mingguan " +
        "otomatis. Mereka tidak mau server di luar negeri, data harus tersimpan di Indonesia. " +
        "Budget naik jadi 75 juta setelah Ibu Sari menyetujui tambahan modul.",
    },
    facts: [
      { entity: "PT Maju", attribute: "stage", value: "demo", quote: "Demo untuk PT Maju selesai" },
      {
        entity: "PT Maju",
        attribute: "preference",
        value: "integrasi dengan WhatsApp",
        quote: "integrasi dengan WhatsApp",
      },
      {
        entity: "PT Maju",
        attribute: "preference",
        value: "laporan mingguan otomatis",
        quote: "laporan mingguan otomatis",
      },
      {
        entity: "PT Maju",
        attribute: "preference",
        value: "data harus tersimpan di Indonesia",
        quote: "data harus tersimpan di Indonesia",
      },
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 75_000_000,
        quote: "Budget naik jadi 75 juta",
      },
    ],
  },
  {
    scope: ORG1,
    source: {
      received_at: "2026-03-10T10:30:00Z",
      content:
        "Update: PT Maju masuk negosiasi. Diskon 10 persen diminta. Langkah berikutnya: kirim " +
        "proposal revisi sebelum 20 Maret. Budi mengganti nomor kontak ke 0812-5550-1122. " +
        "Ibu Sari sekarang pindah jadi Direktur Utama.",
    },
    facts: [
      { entity: "PT Maju", attribute: "stage", value: "negosiasi", quote: "masuk negosiasi" },
      {
        entity: "PT Maju",
        attribute: "preference",
        value: "diskon 10 persen",
        quote: "Diskon 10 persen diminta",
      },
      {
        entity: "PT Maju",
        attribute: "next_step",
        value: "kirim proposal revisi sebelum 20 Maret",
        quote: "kirim proposal revisi sebelum 20 Maret",
      },
      {
        entity: "Budi Santoso",
        attribute: "contact",
        value: "0812-5550-1122",
        quote: "0812-5550-1122",
      },
      {
        entity: "Sari Wulandari",
        attribute: "role",
        value: "Direktur Utama",
        quote: "Direktur Utama",
      },
    ],
  },
  {
    scope: ORG1,
    source: {
      received_at: "2026-04-02T08:00:00Z",
      content:
        "PT Maju resmi closed won, kontrak ditandatangani 1 April untuk paket Pro 200 pengguna. " +
        "Kick-off dijadwalkan 15 April.",
    },
    facts: [
      { entity: "PT Maju", attribute: "stage", value: "closed_won", quote: "closed won" },
      {
        entity: "PT Maju",
        attribute: "next_step",
        value: "kick-off 15 April",
        quote: "Kick-off dijadwalkan 15 April",
      },
    ],
  },
  // Entitas bernama mirip (PT Maju Jaya) dengan nilai berbeda: menguji keliru entitas.
  {
    scope: ORG1,
    source: {
      received_at: "2026-01-20T11:00:00Z",
      content:
        "PT Maju Jaya, perusahaan distribusi di Surabaya, dihubungi lewat Dewi Lestari " +
        "(manajer pembelian). Anggaran mereka hanya 20 juta dan masih tahap lead. Mereka " +
        "butuh sistem untuk melacak pengiriman.",
    },
    facts: [
      {
        entity: { name: "PT Maju Jaya", kind: "organization" },
        attribute: "city",
        value: "Surabaya",
        quote: "di Surabaya",
      },
      {
        entity: "PT Maju Jaya",
        attribute: "budget",
        value: 20_000_000,
        quote: "Anggaran mereka hanya 20 juta",
      },
      { entity: "PT Maju Jaya", attribute: "stage", value: "lead", quote: "masih tahap lead" },
      {
        entity: "PT Maju Jaya",
        attribute: "pain_point",
        value: "melacak pengiriman",
        quote: "melacak pengiriman",
      },
      {
        entity: { name: "Dewi Lestari", kind: "person" },
        attribute: "works_for",
        value: "PT Maju Jaya",
        quote: "dihubungi lewat Dewi Lestari",
      },
      {
        entity: "Dewi Lestari",
        attribute: "role",
        value: "Manajer Pembelian",
        quote: "manajer pembelian",
      },
    ],
  },
  {
    scope: ORG1,
    source: {
      received_at: "2026-02-14T13:00:00Z",
      content:
        "CV Berkah (toko bahan bangunan di Medan) tertarik paket Starter. Pemilik, Pak Hendra " +
        "Gunawan, memutuskan sendiri. Budget maksimal 15 juta, ingin bayar per bulan, bukan " +
        "setahun di muka. Kendala utama: stok barang sering tidak sinkron antara toko dan gudang.",
    },
    facts: [
      {
        entity: { name: "CV Berkah", kind: "organization" },
        attribute: "city",
        value: "Medan",
        quote: "di Medan",
      },
      {
        entity: "CV Berkah",
        attribute: "stage",
        value: "discovery",
        quote: "tertarik paket Starter",
      },
      {
        entity: "CV Berkah",
        attribute: "budget",
        value: 15_000_000,
        quote: "Budget maksimal 15 juta",
      },
      {
        entity: "CV Berkah",
        attribute: "decision_maker",
        value: { name: "Hendra Gunawan", kind: "person" },
        quote: "Pak Hendra Gunawan",
      },
      {
        entity: "CV Berkah",
        attribute: "preference",
        value: "bayar per bulan",
        quote: "bayar per bulan",
      },
      {
        entity: "CV Berkah",
        attribute: "pain_point",
        value: "stok barang sering tidak sinkron antara toko dan gudang",
        quote: "stok barang sering tidak sinkron antara toko dan gudang",
      },
    ],
  },
  {
    scope: ORG1,
    source: {
      received_at: "2026-03-25T09:00:00Z",
      content:
        "CV Berkah memutuskan menunda pembelian sampai kuartal ketiga karena kas sedang ketat.",
    },
    facts: [
      { entity: "CV Berkah", attribute: "stage", value: "ditunda", quote: "menunda pembelian" },
      {
        entity: "CV Berkah",
        attribute: "next_step",
        value: "hubungi lagi di kuartal ketiga",
        quote: "sampai kuartal ketiga",
      },
    ],
  },
  // Anggaran dan kontak SENGAJA tidak pernah disebut: dasar pertanyaan tak terjawab.
  {
    scope: ORG1,
    source: {
      received_at: "2026-02-25T16:00:00Z",
      content:
        "PT Nusantara Logistik di Jakarta. Rina Aprilia, Head of Operations, minta demo minggu " +
        "depan. Mereka sangat peduli soal keamanan data dan sertifikasi ISO 27001.",
    },
    facts: [
      {
        entity: { name: "PT Nusantara Logistik", kind: "organization" },
        attribute: "city",
        value: "Jakarta",
        quote: "di Jakarta",
      },
      {
        entity: "PT Nusantara Logistik",
        attribute: "stage",
        value: "menunggu demo",
        quote: "minta demo minggu depan",
      },
      {
        entity: "PT Nusantara Logistik",
        attribute: "preference",
        value: "sertifikasi ISO 27001",
        quote: "sertifikasi ISO 27001",
      },
      {
        entity: { name: "Rina Aprilia", kind: "person" },
        attribute: "works_for",
        value: "PT Nusantara Logistik",
        quote: "Rina Aprilia, Head of Operations",
      },
      {
        entity: "Rina Aprilia",
        attribute: "role",
        value: "Head of Operations",
        quote: "Head of Operations",
      },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Tenant lain (org:2): nama entitas sama (PT Maju), isi berbeda.
// ---------------------------------------------------------------------------------------------
const org2Steps: SeedStep[] = [
  {
    scope: ORG2,
    source: {
      received_at: "2026-02-02T09:00:00Z",
      content:
        "PT Maju (Semarang) meminta penawaran paket Enterprise. Anggaran mereka 120 juta. " +
        "Keputusan ada pada Pak Rudi Hartono, Direktur Keuangan.",
    },
    facts: [
      {
        entity: { name: "PT Maju", kind: "organization" },
        attribute: "city",
        value: "Semarang",
        quote: "PT Maju (Semarang)",
      },
      {
        entity: "PT Maju",
        attribute: "budget",
        value: 120_000_000,
        quote: "Anggaran mereka 120 juta",
      },
      {
        entity: "PT Maju",
        attribute: "decision_maker",
        value: { name: "Rudi Hartono", kind: "person" },
        quote: "Pak Rudi Hartono",
      },
      {
        entity: "Rudi Hartono",
        attribute: "role",
        value: "Direktur Keuangan",
        quote: "Direktur Keuangan",
      },
    ],
  },
  {
    scope: ORG2,
    source: {
      received_at: "2026-02-09T10:00:00Z",
      content:
        "PT Samudra Biru (Makassar) tertarik paket Pro. Anggaran 90 juta. Pengambil keputusan " +
        "adalah Ibu Tania Putri.",
    },
    facts: [
      {
        entity: { name: "PT Samudra Biru", kind: "organization" },
        attribute: "city",
        value: "Makassar",
        quote: "PT Samudra Biru (Makassar)",
      },
      {
        entity: "PT Samudra Biru",
        attribute: "budget",
        value: 90_000_000,
        quote: "Anggaran 90 juta",
      },
      {
        entity: "PT Samudra Biru",
        attribute: "decision_maker",
        value: { name: "Tania Putri", kind: "person" },
        quote: "Ibu Tania Putri",
      },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Distraktor (skala): perusahaan sintetis deterministik di org:1 supaya pencarian tidak mudah.
// ---------------------------------------------------------------------------------------------
interface Lead {
  company: string;
  city: string;
  person: string;
  role: string;
  juta: number;
  stage: string;
}

export const distractors: Lead[] = [
  {
    company: "PT Sinar Mulia",
    city: "Bandung",
    person: "Agus Prasetyo",
    role: "Manajer IT",
    juta: 85,
    stage: "demo",
  },
  {
    company: "CV Karya Abadi",
    city: "Surabaya",
    person: "Lina Marlina",
    role: "Pemilik",
    juta: 12,
    stage: "lead",
  },
  {
    company: "PT Delta Pratama",
    city: "Jakarta",
    person: "Yusuf Hakim",
    role: "Kepala Pengadaan",
    juta: 140,
    stage: "negosiasi",
  },
  {
    company: "PT Cahaya Baru",
    city: "Yogyakarta",
    person: "Maya Kusuma",
    role: "Direktur Komersial",
    juta: 60,
    stage: "discovery",
  },
  {
    company: "UD Tani Makmur",
    city: "Malang",
    person: "Slamet Riyadi",
    role: "Pemilik",
    juta: 8,
    stage: "lead",
  },
  {
    company: "PT Garuda Teknik",
    city: "Bekasi",
    person: "Fajar Nugroho",
    role: "Manajer Operasional",
    juta: 210,
    stage: "demo",
  },
  {
    company: "CV Mitra Sejahtera",
    city: "Bandung",
    person: "Wulan Sari Dewanti",
    role: "Manajer Keuangan",
    juta: 35,
    stage: "discovery",
  },
  {
    company: "PT Bumi Konstruksi",
    city: "Balikpapan",
    person: "Anton Wijaya",
    role: "Direktur Utama",
    juta: 300,
    stage: "negosiasi",
  },
  {
    company: "PT Lestari Pangan",
    city: "Bogor",
    person: "Nia Ramadhani",
    role: "Kepala Penjualan",
    juta: 55,
    stage: "discovery",
  },
  {
    company: "CV Cipta Kreasi",
    city: "Denpasar",
    person: "Komang Adi",
    role: "Pemilik",
    juta: 18,
    stage: "lead",
  },
  {
    company: "PT Samudra Kargo",
    city: "Semarang",
    person: "Bayu Setiawan",
    role: "Manajer Logistik",
    juta: 95,
    stage: "demo",
  },
  {
    company: "PT Kencana Medika",
    city: "Jakarta",
    person: "dr. Ratna Pertiwi",
    role: "Direktur Klinik",
    juta: 160,
    stage: "negosiasi",
  },
  {
    company: "CV Pelangi Printing",
    city: "Solo",
    person: "Dimas Anggara",
    role: "Pemilik",
    juta: 22,
    stage: "discovery",
  },
  {
    company: "PT Andalas Energi",
    city: "Padang",
    person: "Zulkifli Hasan",
    role: "Kepala Proyek",
    juta: 275,
    stage: "lead",
  },
  {
    company: "PT Nirmala Textile",
    city: "Bandung",
    person: "Citra Anjani",
    role: "Manajer Pabrik",
    juta: 110,
    stage: "demo",
  },
  {
    company: "UD Sumber Rejeki",
    city: "Cirebon",
    person: "Tono Susilo",
    role: "Pemilik",
    juta: 9,
    stage: "lead",
  },
  {
    company: "PT Wahana Digital",
    city: "Jakarta",
    person: "Kevin Tanuwijaya",
    role: "CTO",
    juta: 180,
    stage: "discovery",
  },
  {
    company: "CV Anugrah Furniture",
    city: "Jepara",
    person: "Hasan Basri",
    role: "Pemilik",
    juta: 27,
    stage: "negosiasi",
  },
  {
    company: "PT Prima Farmasi",
    city: "Tangerang",
    person: "Indah Permata",
    role: "Kepala Pengadaan",
    juta: 125,
    stage: "demo",
  },
  {
    company: "PT Tirta Amerta",
    city: "Surabaya",
    person: "Gunawan Pranoto",
    role: "Direktur Operasional",
    juta: 230,
    stage: "discovery",
  },
  {
    company: "CV Harapan Jaya Motor",
    city: "Palembang",
    person: "Roni Saputra",
    role: "Pemilik",
    juta: 31,
    stage: "lead",
  },
  {
    company: "PT Multi Sarana",
    city: "Depok",
    person: "Putri Handayani",
    role: "Manajer Pemasaran",
    juta: 70,
    stage: "negosiasi",
  },
  {
    company: "PT Karya Mandiri Utama",
    city: "Makassar",
    person: "Andi Baso",
    role: "Direktur Utama",
    juta: 195,
    stage: "discovery",
  },
  {
    company: "CV Berlian Teknik",
    city: "Pontianak",
    person: "Hendri Tan",
    role: "Pemilik",
    juta: 14,
    stage: "lead",
  },
];

function distractorStep(lead: Lead, index: number): SeedStep {
  const { company, city, person, role, juta, stage } = lead;
  const day = String(5 + index).padStart(2, "0");
  return {
    scope: ORG1,
    source: {
      received_at: `2026-01-${day}T10:00:00Z`,
      content:
        `${company} (${city}) dihubungi lewat ${person}, ${role}. ` +
        `Anggaran sekitar ${juta} juta. Tahap saat ini: ${stage}.`,
    },
    facts: [
      {
        entity: { name: company, kind: "organization" },
        attribute: "city",
        value: city,
        quote: `${company} (${city})`,
      },
      {
        entity: company,
        attribute: "budget",
        value: juta * 1_000_000,
        quote: `Anggaran sekitar ${juta} juta`,
      },
      { entity: company, attribute: "stage", value: stage, quote: `Tahap saat ini: ${stage}` },
      {
        entity: { name: person, kind: "person" },
        attribute: "works_for",
        value: company,
        quote: `${person}, ${role}`,
      },
      { entity: person, attribute: "role", value: role, quote: role },
    ],
  };
}

export const seedSteps: SeedStep[] = [
  ...coreSteps,
  ...org2Steps,
  ...distractors.map(distractorStep),
];

// ---------------------------------------------------------------------------------------------
// Pertanyaan
// ---------------------------------------------------------------------------------------------
const budgetMaju = (value: number): Expected => ({ entity: "PT Maju", attribute: "budget", value });
const stageMaju = (value: string): Expected => ({ entity: "PT Maju", attribute: "stage", value });
const q = (
  id: string,
  category: Category,
  scope: string | string[],
  query: string,
  answers: Expected[],
  extra: { as_of?: string; forbidden?: Expected[] } = {},
): EvalQuestion => ({ id, category, scope, query, answers, ...extra });

const coreQuestions: EvalQuestion[] = [
  // direct: istilah pertanyaan sama dengan istilah fakta
  q("direct-1", "direct", ORG1, "Berapa anggaran PT Maju?", [budgetMaju(75_000_000)], {
    forbidden: [budgetMaju(50_000_000)],
  }),
  q("direct-2", "direct", ORG1, "Siapa pengambil keputusan di PT Maju?", [
    { entity: "PT Maju", attribute: "decision_maker", value: "Sari Wulandari" },
  ]),
  q("direct-3", "direct", ORG1, "PT Maju ada di kota mana?", [
    { entity: "PT Maju", attribute: "city", value: "Bandung" },
  ]),
  q("direct-4", "direct", ORG1, "Apa jabatan Budi Santoso?", [
    { entity: "Budi Santoso", attribute: "role", value: "Kepala Pengadaan" },
  ]),
  q("direct-5", "direct", ORG1, "Siapa pengambil keputusan CV Berkah?", [
    { entity: "CV Berkah", attribute: "decision_maker", value: "Hendra Gunawan" },
  ]),
  q("direct-6", "direct", ORG1, "Apa jabatan Dewi Lestari?", [
    { entity: "Dewi Lestari", attribute: "role", value: "Manajer Pembelian" },
  ]),
  q("direct-7", "direct", ORG1, "Di kota mana PT Nusantara Logistik berada?", [
    { entity: "PT Nusantara Logistik", attribute: "city", value: "Jakarta" },
  ]),

  // paraphrase: sedikit kesamaan kata; menguji kanal vektor
  q("para-1", "paraphrase", ORG1, "Berapa dana yang disiapkan PT Maju untuk membeli?", [
    budgetMaju(75_000_000),
  ]),
  q("para-2", "paraphrase", ORG1, "Apa yang dikeluhkan CV Berkah?", [
    {
      entity: "CV Berkah",
      attribute: "pain_point",
      value: "stok barang sering tidak sinkron antara toko dan gudang",
    },
  ]),
  q("para-3", "paraphrase", ORG1, "Apakah PT Maju punya syarat soal lokasi penyimpanan data?", [
    { entity: "PT Maju", attribute: "preference", value: "data harus tersimpan di Indonesia" },
  ]),
  q("para-4", "paraphrase", ORG1, "Pelanggan mana yang sedang kesulitan melacak kiriman barang?", [
    { entity: "PT Maju Jaya", attribute: "pain_point", value: "melacak pengiriman" },
  ]),
  q("para-5", "paraphrase", ORG1, "Siapa yang ingin membayar secara bulanan?", [
    { entity: "CV Berkah", attribute: "preference", value: "bayar per bulan" },
  ]),
  q("para-6", "paraphrase", ORG1, "Perusahaan mana yang peduli standar keamanan informasi?", [
    { entity: "PT Nusantara Logistik", attribute: "preference", value: "sertifikasi ISO 27001" },
  ]),
  q("para-7", "paraphrase", ORG1, "Di mana CV Berkah berlokasi?", [
    { entity: "CV Berkah", attribute: "city", value: "Medan" },
  ]),

  // multi: semua nilai atribut multi harus muncul
  q("multi-1", "multi", ORG1, "Apa saja permintaan dan syarat dari PT Maju?", [
    { entity: "PT Maju", attribute: "preference", value: "integrasi dengan WhatsApp" },
    { entity: "PT Maju", attribute: "preference", value: "laporan mingguan otomatis" },
    { entity: "PT Maju", attribute: "preference", value: "data harus tersimpan di Indonesia" },
    { entity: "PT Maju", attribute: "preference", value: "diskon 10 persen" },
  ]),
  q("multi-2", "multi", ORG1, "Apa saja kendala yang dihadapi PT Maju?", [
    {
      entity: "PT Maju",
      attribute: "pain_point",
      value: "data pelanggan tersebar di banyak spreadsheet",
    },
  ]),

  // temporal: "benar pada tanggal X" dan nilai lama tidak boleh bocor
  q("time-1", "temporal", ORG1, "Berapa anggaran PT Maju?", [budgetMaju(50_000_000)], {
    as_of: "2026-01-20T00:00:00Z",
    forbidden: [budgetMaju(75_000_000)],
  }),
  q("time-2", "temporal", ORG1, "Berapa anggaran PT Maju?", [budgetMaju(75_000_000)], {
    as_of: "2026-02-10T00:00:00Z",
    forbidden: [budgetMaju(50_000_000)],
  }),
  q("time-3", "temporal", ORG1, "Apa tahap penjualan PT Maju?", [stageMaju("discovery")], {
    as_of: "2026-01-15T00:00:00Z",
    forbidden: [stageMaju("demo"), stageMaju("negosiasi"), stageMaju("closed_won")],
  }),
  q("time-4", "temporal", ORG1, "Apa tahap penjualan PT Maju?", [stageMaju("demo")], {
    as_of: "2026-02-10T00:00:00Z",
    forbidden: [stageMaju("discovery"), stageMaju("negosiasi"), stageMaju("closed_won")],
  }),
  q("time-5", "temporal", ORG1, "Apa tahap penjualan PT Maju?", [stageMaju("negosiasi")], {
    as_of: "2026-03-15T00:00:00Z",
    forbidden: [stageMaju("discovery"), stageMaju("demo"), stageMaju("closed_won")],
  }),
  q("time-6", "temporal", ORG1, "Apa tahap penjualan PT Maju?", [stageMaju("closed_won")], {
    forbidden: [stageMaju("discovery"), stageMaju("demo"), stageMaju("negosiasi")],
  }),
  q(
    "time-7",
    "temporal",
    ORG1,
    "Apa jabatan Sari Wulandari?",
    [{ entity: "Sari Wulandari", attribute: "role", value: "Direktur Operasional" }],
    {
      as_of: "2026-02-01T00:00:00Z",
      forbidden: [{ entity: "Sari Wulandari", attribute: "role", value: "Direktur Utama" }],
    },
  ),
  q(
    "time-8",
    "temporal",
    ORG1,
    "Apa jabatan Sari Wulandari?",
    [{ entity: "Sari Wulandari", attribute: "role", value: "Direktur Utama" }],
    { forbidden: [{ entity: "Sari Wulandari", attribute: "role", value: "Direktur Operasional" }] },
  ),
  q(
    "time-9",
    "temporal",
    ORG1,
    "Apa langkah berikutnya untuk PT Maju?",
    [
      {
        entity: "PT Maju",
        attribute: "next_step",
        value: "kirim proposal revisi sebelum 20 Maret",
      },
    ],
    { as_of: "2026-03-12T00:00:00Z" },
  ),
  q(
    "time-10",
    "temporal",
    ORG1,
    "Apa langkah berikutnya untuk PT Maju?",
    [{ entity: "PT Maju", attribute: "next_step", value: "kick-off 15 April" }],
    {
      forbidden: [
        {
          entity: "PT Maju",
          attribute: "next_step",
          value: "kirim proposal revisi sebelum 20 Maret",
        },
      ],
    },
  ),
  q(
    "time-11",
    "temporal",
    ORG1,
    "Apa tahap penjualan CV Berkah?",
    [{ entity: "CV Berkah", attribute: "stage", value: "ditunda" }],
    { forbidden: [{ entity: "CV Berkah", attribute: "stage", value: "discovery" }] },
  ),
  q("time-12", "temporal", ORG1, "Apa nomor kontak Budi Santoso?", [
    { entity: "Budi Santoso", attribute: "contact", value: "0812-5550-1122" },
  ]),

  // relation: lewat entitas lain (satu dan dua lompatan)
  q("rel-1", "relation", ORG1, "Di perusahaan mana Budi Santoso bekerja?", [
    { entity: "Budi Santoso", attribute: "works_for", value: "PT Maju" },
  ]),
  q(
    "rel-2",
    "relation",
    ORG1,
    "Siapa saja orang yang bekerja di PT Maju Jaya?",
    [{ entity: "Dewi Lestari", attribute: "works_for", value: "PT Maju Jaya" }],
    { forbidden: [{ entity: "Budi Santoso", attribute: "works_for" }] },
  ),
  q("rel-3", "relation", ORG1, "Apa jabatan pengambil keputusan di PT Maju?", [
    { entity: "Sari Wulandari", attribute: "role", value: "Direktur Utama" },
  ]),
  q("rel-4", "relation", ORG1, "Di kota mana perusahaan tempat Budi Santoso bekerja?", [
    { entity: "PT Maju", attribute: "city", value: "Bandung" },
  ]),

  // near_miss: nama entitas mirip, jangan tertukar
  q(
    "near-1",
    "near_miss",
    ORG1,
    "Berapa anggaran PT Maju Jaya?",
    [{ entity: "PT Maju Jaya", attribute: "budget", value: 20_000_000 }],
    { forbidden: [budgetMaju(75_000_000), budgetMaju(50_000_000)] },
  ),
  q(
    "near-2",
    "near_miss",
    ORG1,
    "Di kota mana PT Maju Jaya berada?",
    [{ entity: "PT Maju Jaya", attribute: "city", value: "Surabaya" }],
    { forbidden: [{ entity: "PT Maju", attribute: "city" }] },
  ),
  q(
    "near-3",
    "near_miss",
    ORG1,
    "Apa tahap penjualan PT Maju Jaya?",
    [{ entity: "PT Maju Jaya", attribute: "stage", value: "lead" }],
    { forbidden: [stageMaju("closed_won")] },
  ),

  // entity_variant: penyebutan tidak persis nama/alias. Mengukur lemahnya resolusi persis.
  q("variant-1", "entity_variant", ORG1, "Apa jabatan Budi?", [
    { entity: "Budi Santoso", attribute: "role", value: "Kepala Pengadaan" },
  ]),
  q("variant-2", "entity_variant", ORG1, "Apa jabatan Ibu Sari sekarang?", [
    { entity: "Sari Wulandari", attribute: "role", value: "Direktur Utama" },
  ]),
  q("variant-3", "entity_variant", ORG1, "Di kota mana Nusantara Logistik berada?", [
    { entity: "PT Nusantara Logistik", attribute: "city", value: "Jakarta" },
  ]),
  q("variant-4", "entity_variant", ORG1, "Apa tahap penjualan Berkah?", [
    { entity: "CV Berkah", attribute: "stage", value: "ditunda" },
  ]),
  q("variant-5", "entity_variant", ORG1, "Berapa anggaran perusahaan Pak Hendra?", [
    { entity: "CV Berkah", attribute: "budget", value: 15_000_000 },
  ]),

  // scope: isolasi antar tenant
  q(
    "scope-1",
    "scope",
    ORG2,
    "Berapa anggaran PT Maju?",
    [{ entity: "PT Maju", attribute: "budget", value: 120_000_000 }],
    { forbidden: [budgetMaju(75_000_000), budgetMaju(50_000_000)] },
  ),
  q(
    "scope-2",
    "scope",
    ORG2,
    "Siapa pengambil keputusan di PT Maju?",
    [{ entity: "PT Maju", attribute: "decision_maker", value: "Rudi Hartono" }],
    { forbidden: [{ entity: "PT Maju", attribute: "decision_maker", value: "Sari Wulandari" }] },
  ),
  q(
    "scope-3",
    "scope",
    ORG2,
    "PT Maju ada di kota mana?",
    [{ entity: "PT Maju", attribute: "city", value: "Semarang" }],
    { forbidden: [{ entity: "PT Maju", attribute: "city", value: "Bandung" }] },
  ),
  q("scope-4", "scope", ORG2, "Berapa anggaran PT Samudra Biru?", [
    { entity: "PT Samudra Biru", attribute: "budget", value: 90_000_000 },
  ]),
  q("scope-5", "scope", [ORG1, ORG2], "Berapa anggaran PT Samudra Biru?", [
    { entity: "PT Samudra Biru", attribute: "budget", value: 90_000_000 },
  ]),
  // Tak terjawab di scope ini, walau ada di scope lain: kebocoran = kegagalan berat.
  q("scope-6", "unanswerable", ORG1, "Berapa anggaran PT Samudra Biru?", [], {
    forbidden: [{ entity: "PT Samudra Biru", attribute: "budget" }],
  }),
  q("scope-7", "unanswerable", ORG2, "Apa jabatan Budi Santoso?", [], {
    forbidden: [{ entity: "Budi Santoso", attribute: "role" }],
  }),
  q("scope-8", "unanswerable", ORG1, "Siapa pengambil keputusan PT Samudra Biru?", [], {
    forbidden: [{ entity: "PT Samudra Biru", attribute: "decision_maker" }],
  }),

  // unanswerable: harus `found: false`
  q("none-1", "unanswerable", ORG1, "Siapa pemilik saham mayoritas PT Maju?", []),
  q("none-2", "unanswerable", ORG1, "Berapa anggaran PT Nusantara Logistik?", []),
  q("none-3", "unanswerable", ORG1, "Apa nomor telepon Rina Aprilia?", []),
  q("none-4", "unanswerable", ORG1, "Berapa anggaran PT Sentosa Abadi?", []),
  q("none-5", "unanswerable", ORG1, "Siapa presiden Indonesia saat ini?", []),
  q("none-6", "unanswerable", ORG1, "Bagaimana cuaca di Bandung hari ini?", []),
  q("none-7", "unanswerable", ORG1, "Kompetitor mana yang dipertimbangkan PT Maju?", []),
  q("none-8", "unanswerable", ORG1, "Kapan CV Berkah menandatangani kontrak?", []),
  q("none-9", "unanswerable", ORG1, "Berapa jumlah karyawan PT Maju Jaya?", []),
  q("none-10", "unanswerable", ORG1, "Apa warna logo PT Maju?", []),
  q("none-11", "unanswerable", ORG1, "Berapa anggaran perusahaan tempat Rina Aprilia bekerja?", []),
  // Sebelum fakta apa pun ada: sadar waktu berarti tidak tahu.
  q("none-12", "unanswerable", ORG1, "Berapa anggaran PT Maju?", [], {
    as_of: "2026-01-01T00:00:00Z",
    forbidden: [budgetMaju(50_000_000), budgetMaju(75_000_000)],
  }),
  q("none-13", "unanswerable", ORG1, "Apa nomor kontak Budi Santoso?", [], {
    as_of: "2026-02-01T00:00:00Z",
    forbidden: [{ entity: "Budi Santoso", attribute: "contact" }],
  }),
];

// Pertanyaan skala: dibangkitkan dari distraktor (jawaban pasti tunggal).
const scaleQuestions: EvalQuestion[] = [
  ...[0, 5, 11, 17, 22].map((i) => {
    const lead = distractors[i] as Lead;
    return q(`scale-budget-${i}`, "scale", ORG1, `Berapa anggaran ${lead.company}?`, [
      { entity: lead.company, attribute: "budget", value: lead.juta * 1_000_000 },
    ]);
  }),
  ...[2, 8, 13].map((i) => {
    const lead = distractors[i] as Lead;
    return q(`scale-role-${i}`, "scale", ORG1, `Apa jabatan ${lead.person}?`, [
      { entity: lead.person, attribute: "role", value: lead.role },
    ]);
  }),
  ...[3, 9, 20].map((i) => {
    const lead = distractors[i] as Lead;
    return q(`scale-none-${i}`, "unanswerable", ORG1, `Apa nomor telepon ${lead.person}?`, []);
  }),
];

export const questions: EvalQuestion[] = [...coreQuestions, ...scaleQuestions];
