import { z } from "zod";
import { dbEnvSchema } from "./db";

const configSchema = z.object({
  ...dbEnvSchema.shape,
});

export let env: z.infer<typeof configSchema>;

export async function loadConfig(): Promise<void> {
  env = await configSchema.parseAsync(process.env);
}
