import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/http/app.ts";
import { JobService } from "../src/jobs/service.ts";
import { Log } from "../src/platform/log.ts";
import { NativeRouter } from "../src/router/router.ts";
import { connectionsHarness } from "./support/connections.ts";
import { freshDatabase, testKeys } from "./support/db.ts";
import { identityHarness, operatorSignIn, tableauSignIn } from "./support/identity.ts";
import { TableauStandIn } from "./support/tableau.ts";

test("operator intake seals a shared credential, rotates with optimistic concurrency and clears explicitly", async () => {
  const database = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const h = await identityHarness(database.db, tableau);
  const c = connectionsHarness(database.db, {
    keys: testKeys(),
    outbound: h.outbound,
    clock: h.clock,
  });
  const log = new Log(() => {});
  const jobs = new JobService({
    db: database.db,
    connections: c.connections,
    publicOrigin: "https://service.test",
    clock: h.clock,
    log,
    limits: {
      inputBytes: 4096,
      resultBytes: 4096,
      runtimeSeconds: 3600,
      resultRetentionSeconds: 86400,
      recordRetentionSeconds: 86400,
    },
  });
  const api = await createApi({
    db: database.db,
    publicOrigin: "https://service.test",
    identity: h.identity,
    connections: c.connections,
    router: new NativeRouter({ connections: c.connections, outbound: h.outbound, log }),
    jobs,
    events: undefined,
    log,
  });
  try {
    await api.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const signed = await tableauSignIn(h, tableau, {
      siteId: "site-a",
      siteContentUrl: "alpha",
      userId: "user-op",
      userName: "op@example.com",
    });
    const op = await operatorSignIn(h, signed.cookie);
    const site = await database.db
      .selectFrom("trusted_sites")
      .select("id")
      .executeTakeFirstOrThrow();
    const call = async (path: string, body: unknown, method = "PUT") =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "Tableau-Service-Authorization": `Bearer ${op.bearer}`,
        },
        body: JSON.stringify(body),
      });
    const created = await call(
      "/v1/admin/definitions",
      {
        id: "key",
        displayName: "Key",
        ownership: "shared",
        apiHosts: ["https://api.example"],
        authentication: { method: "static" },
        credentialPlacement: { kind: "bearer" },
        scopes: [],
        audience: [site.id],
        privateHosts: false,
        enabled: true,
        credential: { kind: "token", value: "synthetic-intake-one" },
      },
      "POST",
    );
    assert.equal(created.status, 201, await created.clone().text());
    const first = (await created.json()).definition;
    assert.deepEqual(first.credential, { set: true, setAt: first.credential.setAt });
    assert.equal(JSON.stringify(first).includes("synthetic-intake-one"), false);
    const rotated = await call("/v1/admin/definitions/key/secrets", {
      expectedVersion: first.version,
      credential: { kind: "token", value: "synthetic-intake-two" },
    });
    assert.equal(rotated.status, 200, await rotated.clone().text());
    const second = (await rotated.json()).definition;
    assert.equal(second.generation, first.generation);
    assert.equal(second.version, first.version + 1);
    const stale = await call("/v1/admin/definitions/key/secrets", {
      expectedVersion: first.version,
      credential: null,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "definition-conflict");
    const empty = await call("/v1/admin/definitions/key/secrets", {
      expectedVersion: second.version,
      credential: { kind: "token", value: "" },
    });
    assert.equal(empty.status, 400);
    const query = await call(
      "/v1/admin/definitions/key/secrets?credential=synthetic-query-secret",
      { expectedVersion: second.version, credential: null },
    );
    assert.equal(query.status, 400);
    assert.equal((await query.text()).includes("synthetic-query-secret"), false);
    const cleared = await call("/v1/admin/definitions/key/secrets", {
      expectedVersion: second.version,
      credential: null,
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json()).definition.credential, { set: false, setAt: null });
    assert.equal((await fetch(`${origin}/secret/obsolete`)).status, 404);
  } finally {
    await api.close();
    await h.close();
    await tableau.close();
    await database.close();
  }
});
