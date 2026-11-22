import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { restoreRunnerSettings, storagePool } from "../src/storage/postgres.ts";
import { caCert, freshDatabaseUrl } from "./support/db.ts";

test("Storage restores configured PostgreSQL limits before authored statements and rolls back", async (t) => {
  const pool = storagePool(await freshDatabaseUrl(), caCert(), 1);
  t.after(async () => {
    await pool.end();
  });
  const probe = `tdas_timeout_${randomBytes(4).toString("hex")}`;

  const client = await pool.connect();
  await client.query("begin");
  try {
    await restoreRunnerSettings(client, 120, 120);
    await client.query("select set_config('statement_timeout', '0', false)");
    await client.query("select set_config('lock_timeout', '0', false)");
    assert.equal((await client.query("show statement_timeout")).rows[0]?.statement_timeout, "0");
    assert.equal((await client.query("show lock_timeout")).rows[0]?.lock_timeout, "0");

    await restoreRunnerSettings(client, 120, 120);
    assert.equal(
      (await client.query("show statement_timeout")).rows[0]?.statement_timeout,
      "120ms",
    );
    assert.equal((await client.query("show lock_timeout")).rows[0]?.lock_timeout, "120ms");
    await assert.rejects(
      client.query("select pg_sleep(0.4)"),
      (error: { code?: string }) => error.code === "57014",
    );
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }

  const second = await pool.connect();
  await second.query("begin");
  try {
    await restoreRunnerSettings(second, 120, 120);
    await second.query(`create table ${probe} (id int)`);
    await restoreRunnerSettings(second, 120, 120);
    await assert.rejects(
      second.query("select * from tdas_missing_relation"),
      (error: { code?: string }) => error.code === "42P01",
    );
  } finally {
    await second.query("rollback").catch(() => {});
    second.release();
  }
  const after = await pool.query<{ name: string | null }>(
    `select to_regclass('${probe}')::text as name`,
  );
  assert.equal(after.rows[0]?.name, null);
});
