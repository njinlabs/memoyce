import { z } from "zod";

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function isIso(value: string): boolean {
  if (!ISO.test(value)) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  // Tanggal tanpa jam: tolak hari yang tidak ada (mis. 2025-02-30) lewat bolak-balik.
  return value.length > 10 || new Date(time).toISOString().slice(0, 10) === value;
}

// Tanggal berupa teks ISO 8601 supaya skema input bisa menjadi JSON Schema untuk tool AI.
// Validasi lewat refine agar tidak ikut ke JSON Schema sebagai regex panjang (boros token).
export const isoTime = z
  .string()
  .refine(isIso, "harus tanggal/waktu ISO 8601, mis. 2025-01-31 atau 2025-01-31T09:00:00Z")
  .describe("Tanggal/waktu ISO 8601, mis. 2025-01-31 atau 2025-01-31T09:00:00Z");
