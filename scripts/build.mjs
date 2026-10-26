// Build paket untuk npm: tsc (ESM + deklarasi) lalu merapikan impor relatif di .d.ts.
// TypeScript menulis ulang ".ts" -> ".js" pada JS tetapi mempertahankan ".ts" pada .d.ts; pemakai
// dengan moduleResolution node16/nodenext membutuhkan ".js" di deklarasi.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
  stdio: "inherit",
});

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

let fixed = 0;
for (const file of walk("dist").filter((f) => f.endsWith(".d.ts"))) {
  const source = readFileSync(file, "utf8");
  const out = source.replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
  if (out !== source) {
    writeFileSync(file, out);
    fixed++;
  }
}
const leftovers = walk("dist").filter(
  (f) =>
    /\.(d\.ts|js)$/.test(f) && /from\s+["']\.{1,2}\/[^"']+\.ts["']/.test(readFileSync(f, "utf8")),
);
if (leftovers.length > 0) throw new Error(`impor .ts tersisa: ${leftovers.join(", ")}`);
console.log(`build selesai; ${fixed} berkas .d.ts dirapikan`);
