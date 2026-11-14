import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createHttpApp } from "../src/http/app.js";
import { SecretBox } from "../src/security/encryption.js";
import { testPostgres } from "./postgres.js";

test("encrypted records authenticate key, record, provider, revision and full tag before disclosure", () => {
  const box = new SecretBox(
    "a",
    new Map([
      ["a", Buffer.alloc(32, 1)],
      ["b", Buffer.alloc(32, 2)],
    ]),
  );
  const binding = { kind: "credential", id: "one", provider: "slack", revision: "1:1" };
  const sealed = box.seal(Buffer.from("private token"), binding);
  assert.equal(box.open(sealed, binding).toString(), "private token");
  for (const changed of [
    { ...binding, id: "two" },
    { ...binding, revision: "1:2" },
    { ...binding, provider: "other" },
  ])
    assert.throws(() => box.open(sealed, changed));
  for (const changed of [
    { ...sealed, tag: sealed.tag.slice(1) },
    { ...sealed, keyId: "b" },
    { ...sealed, ciphertext: "AAAA" },
  ])
    assert.throws(() => box.open(changed, binding));
  assert.notEqual(sealed.nonce, box.seal(Buffer.from("private token"), binding).nonce);
});

test("invalid production configuration fails before readiness", () => {
  assert.throws(() =>
    loadConfig({
      DATABASE_URL: "postgres://localhost/db",
      SERVICE_ORIGIN: "http://localhost",
      ENCRYPTION_ACTIVE_KEY_ID: "missing",
      ENCRYPTION_KEYS: "{}",
    }),
  );
});

test("real Postgres migrations are repeatable; uniqueness survives concurrent registrations and readiness checks installed schema", async () => {
  const pg = await testPostgres();
  try {
    await migrate(pg.db);
    await pg.db
      .insertInto("deployments")
      .values({
        id: "cloud",
        kind: "cloud",
        adapter_id: "cloud",
        config_revision: 1,
        enabled: true,
      })
      .execute();
    const results = await Promise.allSettled(
      ["a", "b"].map((id) =>
        pg.db
          .insertInto("tableau_sites")
          .values({ id, deployment_id: "cloud", site_id: "stable-site", enabled: true })
          .execute(),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const app = await createHttpApp({ db: pg.db });
    assert.equal((await app.inject("/health/ready")).statusCode, 200);
    assert.equal((await app.inject("/v1/test/login")).statusCode, 404);
    await sql`update service_schema set version = 99`.execute(pg.db);
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    await app.close();
  } finally {
    await pg.close();
  }
});
