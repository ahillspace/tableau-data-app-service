import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { type Db, migrate, openDatabase } from "../../src/persistence/database.ts";
import type { SealingKeys } from "../../src/platform/settings.ts";

export const caCert = (): string => readFileSync(process.env.TDAS_TEST_PG_CA as string, "utf8");

export async function freshDatabaseUrl(): Promise<string> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({
    connectionString: process.env.TDAS_TEST_PG,
    ssl: { ca: caCert() },
  });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(process.env.TDAS_TEST_PG as string);
  url.pathname = `/${name}`;
  return url.href;
}

export async function freshDatabase(): Promise<{
  db: Db;
  url: string;
  close: () => Promise<void>;
}> {
  const url = await freshDatabaseUrl();
  const { db } = openDatabase({ url, caCert: caCert(), applicationName: "tdas-test" });
  await migrate(db);
  return { db, url, close: () => db.destroy() };
}

export function testKeys(...ids: string[]): SealingKeys {
  const keys = new Map<string, Buffer>();
  for (const id of ids.length ? ids : ["k1"]) keys.set(id, randomBytes(32));
  return { current: ids.at(-1) ?? "k1", keys };
}

export function sealingKeysEnv(keys: SealingKeys): string {
  return JSON.stringify({
    current: keys.current,
    keys: Object.fromEntries([...keys.keys].map(([id, key]) => [id, key.toString("base64")])),
  });
}
