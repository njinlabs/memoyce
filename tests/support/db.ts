import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/core/config";
import { connectDb, db } from "../../src/core/db";
import { applySchema } from "../../src/core/schema";

// DB uji di dalam repo (`data` sudah di-ignore git), satu folder per run.
const root = "./data";
const prefix = "test-";

function removeDir(path: string): void {
  try {
    // Path absolut: rmSync Bun di Windows gagal untuk path relatif "./...".
    rmSync(resolve(path), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`gagal menghapus ${path}:`, error);
  }
}

export async function setupTestDb(): Promise<() => Promise<void>> {
  // RocksDB di Windows masih menulis setelah close(), jadi sisa run sebelumnya dibersihkan di awal.
  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith(prefix)) removeDir(`${root}/${name}`);
    }
  } catch {}

  const dir = `${root}/${prefix}${crypto.randomUUID()}`;
  process.env.SURREAL_PATH = dir;
  await loadConfig();
  await connectDb();
  await applySchema();

  return async () => {
    await db.close();
    removeDir(dir);
  };
}
