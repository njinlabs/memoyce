import { z } from "zod";

// Tanggal berupa teks ISO supaya skema input bisa menjadi JSON Schema untuk tool AI.
export const isoTime = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
