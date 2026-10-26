import { isAbsolute, relative, resolve } from "node:path";
import { createRemoteEngines, Surreal, type SurrealSession } from "surrealdb";
import { MemoryError } from "./errors.ts";
import type { ResolvedOptions } from "./options.ts";

export interface Storage {
  db: SurrealSession;
  // Hanya menutup koneksi yang dibuka library; koneksi milik aplikasi tidak disentuh.
  close(): Promise<void>;
}

const embedded = /^(rocksdb|surrealkv):\/\/(.*)$/;

// Engine yang dijalankan di dalam proses ini (butuh paket opsional @surrealdb/node).
const inProcess = /^(mem|rocksdb|surrealkv):\/\//;

type NodeModule = { createNodeEngines: typeof import("@surrealdb/node").createNodeEngines };

// @surrealdb/node membawa binari native dan hanya dibutuhkan engine embedded, jadi dimuat saat
// diperlukan. Pemakai yang hanya memakai server remote (ws://, http://) tidak perlu memasangnya.
export async function loadNodeEngines(
  importer: () => Promise<NodeModule> = () => import("@surrealdb/node"),
) {
  try {
    return (await importer()).createNodeEngines();
  } catch (cause) {
    throw new MemoryError(
      "storage",
      "engine embedded (mem://, rocksdb://, surrealkv://) membutuhkan paket @surrealdb/node dan @surrealdb/node-native; pasang keduanya, atau pakai server remote (ws://, http://) atau storage: { db }",
      { cause: String(cause) },
    );
  }
}

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
    engines: {
      ...createRemoteEngines(),
      ...(inProcess.test(storage.url) ? await loadNodeEngines() : {}),
    },
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
