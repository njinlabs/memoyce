import type { Surreal } from "surrealdb";
import { z } from "zod";
import { MemoryError } from "./errors";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const attributeSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "date", "entity", "json"]).default("string"),
  cardinality: z.enum(["single", "multi"]).default("single"),
  aliases: z.array(z.string().min(1)).default([]),
});

const storageBase = {
  namespace: identifier.default("agent"),
  database: identifier.default("memory"),
};

// Tepat satu dari url (library membuka koneksi sendiri) atau db (koneksi milik aplikasi).
const storageSchema = z.union(
  [
    z.object({ ...storageBase, url: z.string().min(1) }),
    z.object({
      ...storageBase,
      db: z.custom<Surreal>(
        (v) => typeof v === "object" && v !== null && typeof (v as Surreal).query === "function",
        "db harus instance Surreal",
      ),
    }),
  ],
  { error: "isi tepat satu dari storage.url atau storage.db" },
);

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
}

export const optionsSchema = z
  .object({
    storage: storageSchema,
    attributes: z.array(attributeSchema).default([]),
    vocabulary: z.enum(["strict", "open"]).default("strict"),
    migrate: z.enum(["auto", "check", "off"]).default("auto"),
  })
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    for (const [i, attribute] of options.attributes.entries()) {
      for (const name of [attribute.key, ...attribute.aliases]) {
        const normalized = normalizeName(name);
        if (seen.has(normalized)) {
          ctx.addIssue({
            code: "custom",
            path: ["attributes", i],
            message: `nama atribut/alias ganda: ${normalized}`,
          });
        }
        seen.add(normalized);
      }
    }
  });

export type AttributeDef = z.input<typeof attributeSchema>;
export type MemoryOptions = z.input<typeof optionsSchema>;
export type ResolvedOptions = z.output<typeof optionsSchema>;
export type ResolvedAttribute = z.output<typeof attributeSchema>;

export function parseOptions(input: unknown): ResolvedOptions {
  const result = optionsSchema.safeParse(input);
  if (!result.success) {
    throw new MemoryError("invalid_options", z.prettifyError(result.error), {
      issues: result.error.issues,
    });
  }
  return result.data;
}
