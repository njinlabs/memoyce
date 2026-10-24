import { isAbsolute, relative, resolve } from "node:path";
import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, Surreal, type SurrealSession } from "surrealdb";
import { MemoryError } from "./errors";
import type { ResolvedOptions } from "./options";

export interface Storage {
  db: SurrealSession;
  // Hanya menutup koneksi yang dibuka library; koneksi milik aplikasi tidak disentuh.
  close(): Promise<void>;
}

const embedded = /^(rocksdb|surrealkv):\/\/(.*)$/;

// Engine memotong drive path absolut Windows ("C:/x" menjadi "./C/x"), jadi path engine
// embedded selalu diubah menjadi relatif terhadap cwd. Beda drive tidak bisa direlatifkan.
// URL lain (mem://, ws://, ...) tidak diubah.
export function normalizeUrl(url: string): string {
  const match = embedded.exec(url);
  if (!match) return url;
  const [, scheme, path = ""] = match;
  const relativePath = relative(process.cwd(), resolve(path));
  if (isAbsolute(relativePath)) {
    throw new MemoryError("storage", `path harus satu drive dengan working directory: ${path}`);
  }
  return `${scheme}://${relativePath.replaceAll("\\", "/") || "."}`;
}

export async function openStorage(storage: ResolvedOptions["storage"]): Promise<Storage> {
  if ("db" in storage) {
    // Session sendiri supaya `use` di sini tidak mengubah namespace/database milik aplikasi.
    const db = await storage.db.newSession();
    await selectDatabase(db, storage);
    return { db, close: async () => {} };
  }

  const client = new Surreal({
    engines: { ...createRemoteEngines(), ...createNodeEngines() },
  });
  try {
    await client.connect(normalizeUrl(storage.url));
    await selectDatabase(client, storage);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return { db: client, close: () => client.close().then(() => {}) };
}

async function selectDatabase(
  db: SurrealSession,
  storage: { namespace: string; database: string },
): Promise<void> {
  await db.query(
    `DEFINE NAMESPACE IF NOT EXISTS ${storage.namespace};
     USE NS ${storage.namespace};
     DEFINE DATABASE IF NOT EXISTS ${storage.database};`,
  );
  await db.use({ namespace: storage.namespace, database: storage.database });
}
