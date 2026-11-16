import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSchemaCurrent, migrate, openDatabase } from "../src/persistence/database.ts";
import { bumpRevision, currentRevision } from "../src/persistence/revision.ts";
import { caCert, freshDatabase, freshDatabaseUrl } from "./support/db.ts";
import { makeCertificates } from "./support/global.ts";

test("V2: connections verify the server certificate against the configured CA", async () => {
  const url = await freshDatabaseUrl();
  const good = openDatabase({ url, caCert: caCert(), applicationName: "t" });
  await migrate(good.db);
  await good.db.destroy();

  const other = mkdtempSync(join(tmpdir(), "tdas-ca-"));
  makeCertificates(other, "localhost", "DNS:localhost");
  const wrong = openDatabase({
    url,
    caCert: readFileSync(join(other, "ca.crt"), "utf8"),
    applicationName: "t",
  });
  await assert.rejects(assertSchemaCurrent(wrong.db), (error: Error) =>
    /certificate|schema/.test(`${error.message} ${String(error.cause)}`),
  );
  await wrong.db.destroy();

  // Without the CA, the throwaway certificate is not publicly trusted, so the connection fails too.
  const none = openDatabase({ url: `${url}?sslmode=disable`, applicationName: "t" });
  await assert.rejects(
    none.db.selectFrom("installation_revision").selectAll().execute(),
    /certificate/,
  );
  await none.db.destroy();
});

test("API and worker refuse a schema that is behind", async () => {
  const url = await freshDatabaseUrl();
  const { db } = openDatabase({ url, caCert: caCert(), applicationName: "t" });
  await assert.rejects(assertSchemaCurrent(db), { code: "schema-behind" });
  await migrate(db);
  await assertSchemaCurrent(db);
  await db.destroy();
});

test("the installation revision only moves when bumped in a transaction", async () => {
  const { db, close } = await freshDatabase();
  try {
    const before = await currentRevision(db);
    await db.transaction().execute((tx) => bumpRevision(tx));
    assert.equal(await currentRevision(db), before + 1n);
    await assert.rejects(
      db.transaction().execute(async (tx) => {
        await bumpRevision(tx);
        throw new Error("rollback");
      }),
    );
    assert.equal(await currentRevision(db), before + 1n);
  } finally {
    await close();
  }
});
