import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createContext } from "../../src/core/context";
import { assertFact, factsAt } from "../../src/core/fact";
import { currentVersion, latestVersion } from "../../src/core/migrations";
import { createEntity, createSource } from "../../src/core/records";
import { testAttributes } from "../support/context";

// Penyimpanan embedded sungguhan: data bertahan antar sesi dan migrasi tidak diulang.

const dir = resolve("data", `test-durability-${crypto.randomUUID()}`);
const open = (migrate: "auto" | "check") =>
  createContext({ storage: { url: `rocksdb://${dir}` }, attributes: testAttributes, migrate });

afterAll(() => {
  // Path absolut: rmSync Bun di Windows gagal diam-diam untuk path relatif "./...".
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("fakta bertahan setelah ditutup dan dibuka ulang, tanpa migrasi ulang", async () => {
  const scope = "org:1";
  const first = await open("auto");
  const entity = await createEntity(first.ctx, { scope, name: "Budi", kind: "person" });
  const source = await createSource(first.ctx, { scope, content: "Budi di Acme" });
  await assertFact(first.ctx, {
    scope,
    entity,
    attribute: "employer",
    value: "Acme",
    source,
    at: new Date("2025-01-01"),
  });
  await first.close();

  // `check` lolos hanya bila database sudah berada di versi terbaru.
  const second = await open("check");
  expect(await currentVersion(second.ctx.db)).toBe(latestVersion());
  const facts = await factsAt(second.ctx, { scope, entity, at: new Date("2025-06-01") });
  expect(facts.map((f) => f.value)).toEqual(["Acme"]);
  await second.close();
});
