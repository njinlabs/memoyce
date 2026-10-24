import { z } from "zod";

const configSchema = z.object({
  SURREAL_PATH: z.string().min(1).default("./data/surreal"),
  SURREAL_NAMESPACE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("agent"),
  SURREAL_DATABASE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("agent"),
});

export let env: z.infer<typeof configSchema>;

export async function loadConfig(): Promise<void> {
  env = await configSchema.parseAsync(process.env);
}
