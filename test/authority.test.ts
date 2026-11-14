import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { registerSiteRoutes } from "../src/access/sites.js";
import { ConnectionService } from "../src/connections/service.js";
import { prepareRequest } from "../src/connections/snapshot.js";
import { createHttpApp } from "../src/http/app.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { randomSecret, verifier } from "../src/security/secrets.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

test("background start distinguishes reconnectable freshness from lost original generation", async () => {
  const f = await coreFixture();
  try {
    const providers = new ProviderRegistry([fixtureProvider]);
    const connections = new ConnectionService(f.db, f.access, f.secrets, providers, {
      connectTimeoutMs: 1000,
      headersTimeoutMs: 1000,
      stallTimeoutMs: 1000,
      maxSockets: 4,
    });
    const row = await f.credentials.publishLocal(f.alice.access, fixtureProvider, candidate());
    const scope = {
      access: f.alice.access,
      providerRegistrationId: "fixture",
      connectionId: row.id,
      authorityGeneration: 1,
      started: false,
      purpose: "start" as const,
    };
    await f.db
      .updateTable("connections")
      .set({ state: "reauthorization-required" })
      .where("id", "=", row.id)
      .execute();
    await assert.rejects(
      f.db.transaction().execute((tx) => connections.lockBackground(tx, scope)),
      { status: 422, code: "reauthorization-required" },
    );
    await assert.rejects(
      f.db
        .transaction()
        .execute((tx) => connections.lockBackground(tx, { ...scope, access: f.bob.access })),
      { status: 404 },
    );
    await f.db
      .updateTable("connections")
      .set({ authority_generation: 2 })
      .where("id", "=", row.id)
      .execute();
    await assert.rejects(
      f.db.transaction().execute((tx) => connections.lockBackground(tx, scope)),
      { status: 404 },
    );
    await f.db
      .updateTable("connections")
      .set({ authority_generation: 1, state: "disconnected", bundle: null })
      .where("id", "=", row.id)
      .execute();
    await assert.rejects(
      f.db.transaction().execute((tx) => connections.lockBackground(tx, scope)),
      { status: 404 },
    );
  } finally {
    await f.close();
  }
});

test("personal authority crosses configured apps but never owners; usable proxy snapshot succeeds on a read-only database", async () => {
  const f = await coreFixture();
  try {
    const connection = await f.credentials.publishLocal(
      f.alice.access,
      fixtureProvider,
      candidate(),
    );
    await sql`set default_transaction_read_only=on`.execute(f.db);
    const prepared = await prepareRequest(
      f.db,
      f.secrets,
      fixtureProvider,
      "two",
      { token: f.alice.token },
      connection.id,
    );
    assert.equal(prepared.access.ownerId, f.alice.access.ownerId);
    assert.deepEqual(prepared.take()?.credentials, { token: "secret-one" });
    assert.throws(() => prepared.take());
    await assert.rejects(
      prepareRequest(
        f.db,
        f.secrets,
        fixtureProvider,
        "two",
        { token: f.bob.token },
        connection.id,
      ),
      { status: 404 },
    );
    await sql`set default_transaction_read_only=off`.execute(f.db);
    await f.db
      .updateTable("tableau_sites")
      .set({ enabled: false })
      .where("id", "=", "site-row")
      .execute();
    await assert.rejects(
      prepareRequest(
        f.db,
        f.secrets,
        fixtureProvider,
        "one",
        { token: f.alice.token },
        connection.id,
      ),
      { status: 401 },
    );
  } finally {
    await f.close();
  }
});

test("racing local replacements publish one complete bundle and reject stale preparation without a durable processor", async () => {
  const f = await coreFixture();
  try {
    const connection = await f.credentials.publishLocal(
      f.alice.access,
      fixtureProvider,
      candidate(),
    );
    const expected = await f.credentials.capture(f.alice.access, fixtureProvider, {
      connectionId: connection.id,
      expectedAuthorityGeneration: 1,
    });
    const results = await Promise.allSettled(
      ["two", "three"].map((token) =>
        f.credentials.publishLocal(f.alice.access, fixtureProvider, candidate(token), expected),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status === "rejected" && rejected.reason.code, "stale-mutation");
    const prepared = await prepareRequest(
      f.db,
      f.secrets,
      fixtureProvider,
      "one",
      { token: f.alice.token },
      connection.id,
    );
    assert.equal(prepared.take()?.credentialGeneration, 2);
    const mutations = await f.db.selectFrom("credential_mutations").select("id").execute();
    assert.equal(mutations.length, 0);
  } finally {
    await f.close();
  }
});

test("sole mutation owner excludes import and invalidating dispatch retains an unusable exact-revision barrier after interruption", async () => {
  const f = await coreFixture();
  try {
    const connection = await f.credentials.publishLocal(
      f.alice.access,
      fixtureProvider,
      candidate(),
    );
    const previous = await f.credentials.capture(f.alice.access, fixtureProvider, {
      connectionId: connection.id,
      expectedAuthorityGeneration: 1,
    });
    const ref = await f.credentials.reserve(
      f.alice.access,
      "fixture",
      "renewal",
      new Date(Date.now() + 30000),
      { connectionId: connection.id, expectedAuthorityGeneration: 1 },
    );
    await assert.rejects(
      f.credentials.publishLocal(f.alice.access, fixtureProvider, candidate("stale"), previous),
      { code: "credential-mutation-in-progress" },
    );
    const claim = await f.credentials.claim(f.alice.access, "fixture", ref, "process-one", 10000);
    await f.credentials.dispatch(f.alice.access, "fixture", ref, claim, true);
    await assert.rejects(
      prepareRequest(
        f.db,
        f.secrets,
        fixtureProvider,
        "one",
        { token: f.alice.token },
        connection.id,
      ),
      { code: "renewal-uncertain" },
    );
    assert.equal(await f.credentials.recover(ref, true), "uncertain");
    await assert.rejects(
      f.credentials.publish(f.alice.access, fixtureProvider, ref, claim, candidate("late")),
      { code: "stale-mutation" },
    );
    const row = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.credential_generation, 1);
    assert.equal(row.state, "renewal-uncertain");
  } finally {
    await f.close();
  }
});

test("registry credentials cannot become viewer authority; duplicate enrollment never reenables and changes have atomic attribution", async () => {
  const f = await coreFixture();
  const management = randomSecret();
  const app = await createHttpApp({ db: f.db });
  registerSiteRoutes(app, f.db, [{ actorId: "enrollment", verifier: verifier(management) }]);
  try {
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/tableau-sites",
          headers: { authorization: `Bearer ${f.alice.token}` },
        })
      ).statusCode,
      401,
    );
    const headers = { authorization: `Bearer ${management}` };
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/v1/admin/tableau-sites/site-row",
          headers,
          payload: { enabled: false },
        })
      ).statusCode,
      200,
    );
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/admin/tableau-sites",
      headers,
      payload: { deploymentId: "cloud", siteId: "site" },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().enabled, false);
    assert.equal((await f.db.selectFrom("site_changes").selectAll().execute()).length, 1);
    await assert.rejects(f.access.authenticate(management, "one"), { status: 401 });
  } finally {
    await app.close();
    await f.close();
  }
});

test("fixed authentication expiry is checked after a lock wait rather than transaction-start time", async () => {
  const f = await coreFixture();
  try {
    await f.db
      .updateTable("sessions")
      .set({ authentication_expires_at: sql`clock_timestamp() + interval '250 milliseconds'` })
      .where("id", "=", f.alice.sessionId)
      .execute();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = f.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("tableau_sites")
        .select("id")
        .where("id", "=", "site-row")
        .forUpdate()
        .execute();
      locked();
      await gate;
    });
    await ready;
    const pending = f.credentials.publishLocal(f.alice.access, fixtureProvider, candidate());
    await sql`select pg_sleep(0.35)`.execute(f.db);
    release();
    await holding;
    await assert.rejects(pending, { status: 401 });
    assert.equal((await f.db.selectFrom("connections").select("id").execute()).length, 0);
  } finally {
    await f.close();
  }
});
