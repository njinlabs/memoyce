import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, Surreal } from "surrealdb";
import z from "zod";
import { env } from "./config";

export let db: Surreal;

export const dbEnvSchema = z.object({
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

export async function connectDb(): Promise<void> {
  db = new Surreal({
    engines: { ...createRemoteEngines(), ...createNodeEngines() },
  });

  try {
    await db.connect(`rocksdb://${env.SURREAL_PATH.replaceAll("\\", "/")}`);

    await db.query(
      `DEFINE NAMESPACE IF NOT EXISTS ${env.SURREAL_NAMESPACE};
       USE NS ${env.SURREAL_NAMESPACE};
       DEFINE DATABASE IF NOT EXISTS ${env.SURREAL_DATABASE};`,
    );
    await db.use({
      namespace: env.SURREAL_NAMESPACE,
      database: env.SURREAL_DATABASE,
    });
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}
