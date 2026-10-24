import type { AttributeDef } from "../../src/index";

// Kosakata contoh untuk agen penjualan. Library tidak membawa kosakata domain.
export const salesAttributes: AttributeDef[] = [
  {
    key: "works_for",
    description: "perusahaan tempat seseorang bekerja",
    type: "entity",
    aliases: ["employer", "company", "perusahaan"],
  },
  { key: "role", description: "jabatan", aliases: ["jabatan", "title"] },
  { key: "city", description: "kota", aliases: ["kota", "location"] },
  {
    key: "budget",
    description: "anggaran dalam rupiah (angka)",
    type: "number",
    aliases: ["dana", "anggaran"],
  },
  {
    key: "stage",
    description: "tahap penjualan (lead, discovery, demo, negosiasi, closed_won, closed_lost)",
    aliases: ["tahap", "status"],
  },
  {
    key: "decision_maker",
    description: "pengambil keputusan pembelian",
    type: "entity",
    aliases: ["pengambil_keputusan"],
  },
  {
    key: "pain_point",
    description: "masalah atau keluhan yang dihadapi",
    cardinality: "multi",
    aliases: ["masalah", "keluhan"],
  },
  {
    key: "preference",
    description: "preferensi atau syarat yang disebut",
    cardinality: "multi",
    aliases: ["preferensi"],
  },
  {
    key: "next_step",
    description: "langkah berikutnya yang disepakati",
    aliases: ["langkah_berikutnya"],
  },
  {
    key: "contact",
    description: "kontak (telepon atau email)",
    aliases: ["kontak", "email", "phone"],
  },
];
