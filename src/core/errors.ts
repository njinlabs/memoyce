export type MemoryErrorCode =
  | "invalid_options"
  | "storage"
  | "migration"
  | "unknown_attribute"
  | "invalid_value"
  | "not_found"
  | "scope_mismatch"
  | "stale_time";

// Semua kegagalan yang bisa diperbaiki pemanggil memakai kelas ini, dengan `code` yang stabil
// dan `details` terstruktur (misalnya saran atribut), supaya lapisan tool bisa mengubahnya
// menjadi data untuk AI pemanggil.
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MemoryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}
