import { isAbsolute, relative, resolve } from "node:path";
import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, Surreal } from "surrealdb";
import { env } from "./config";

export let db: Surreal;

// Engine memotong drive path absolut Windows ("C:/x" menjadi "./C/x"), jadi path selalu
// diubah menjadi relatif terhadap cwd. Beda drive tidak bisa direlatifkan.
export function rocksdbUrl(path: string): string {
  const relativePath = relative(process.cwd(), resolve(path));
  if (isAbsolute(relativePath)) {
    throw new Error(`SURREAL_PATH harus satu drive dengan working directory: ${path}`);
  }
  return `rocksdb://${relativePath.replaceAll("\\", "/") || "."}`;
}

export async function connectDb(): Promise<void> {
  db = new Surreal({
    engines: { ...createRemoteEngines(), ...createNodeEngines() },
  });

  try {
    await db.connect(rocksdbUrl(env.SURREAL_PATH));

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
