import { afterEach, expect, test } from "bun:test";
import { env, loadConfig } from "../../src/core/config";

const keys = ["SURREAL_PATH", "SURREAL_NAMESPACE", "SURREAL_DATABASE"] as const;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv(): void {
  for (const k of keys) delete process.env[k];
}

test("memakai nilai default bila env kosong", async () => {
  clearEnv();
  await loadConfig();
  expect(env).toMatchObject({
    SURREAL_PATH: "./data/surreal",
    SURREAL_NAMESPACE: "agent",
    SURREAL_DATABASE: "agent",
  });
});

test("membaca nilai dari env", async () => {
  clearEnv();
  process.env.SURREAL_PATH = "./x";
  process.env.SURREAL_NAMESPACE = "ns_1";
  process.env.SURREAL_DATABASE = "db_1";
  await loadConfig();
  expect(env).toMatchObject({
    SURREAL_PATH: "./x",
    SURREAL_NAMESPACE: "ns_1",
    SURREAL_DATABASE: "db_1",
  });
});

test.each([
  ["SURREAL_NAMESPACE", "bad name;"],
  ["SURREAL_DATABASE", "1abc"],
  ["SURREAL_PATH", ""],
])("menolak %s tidak valid (%p)", async (key, value) => {
  clearEnv();
  process.env[key] = value;
  await expect(loadConfig()).rejects.toThrow();
});
