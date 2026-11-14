import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { CredentialsService } from "../src/connections/credentials.js";
import { ConnectionService } from "../src/connections/service.js";
import { Sources } from "../src/events/sources.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

const policy = {
  maxSockets: 8,
  connectTimeoutMs: 1000,
  headersTimeoutMs: 1000,
  stallTimeoutMs: 1000,
};
test("derived endpoint credentials bind current base generation, recipient and expiry without publishing another bundle", async () => {
  const f = await coreFixture();
  let calls = 0,
    derived = 0,
    mode = "valid",
    waiting: () => void = () => {},
    release: () => void = () => {};
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.headers.authorization, "Bearer derived-secret");
    response.end("derived endpoint");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const provider = {
    ...fixtureProvider,
    endpoints: {
      api: {
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        allowHttp: true,
        privateCidrs: ["127.0.0.1/32"],
        derived: {
          audience: "fixture-data",
          async derive() {
            derived++;
            if (mode === "hold") {
              waiting();
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
            return {
              headers: new Headers({ authorization: "Bearer derived-secret" }),
              audience: mode === "wrong-audience" ? "another-recipient" : "fixture-data",
              expiresAt: new Date(
                Date.now() + (mode === "expired" ? -1 : mode === "too-long" ? 120000 : 10000),
              ),
            };
          },
        },
      },
    },
  };
  const connections = new ConnectionService(
    f.db,
    f.access,
    f.secrets,
    new ProviderRegistry([provider]),
    policy,
  );
  let scope: Awaited<ReturnType<ConnectionService["openScope"]>> | undefined;
  try {
    const row = await f.credentials.publishLocal(f.alice.access, provider, {
      ...candidate(),
      expiresAt: new Date(Date.now() + 60000),
    });
    scope = await connections.openScope(
      { source: "request", access: f.alice.access },
      "fixture",
      row.id,
      new AbortController().signal,
    );
    assert.equal(
      await (await scope.context.request({ endpoint: "api", method: "GET", path: "/data" })).text(),
      "derived endpoint",
    );
    assert.equal(calls, 1);
    assert.equal(derived, 1);
    mode = "hold";
    const ready = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const pending = scope.context.request({ endpoint: "api", method: "GET", path: "/data" });
    await ready;
    const previous = await f.credentials.capture(f.alice.access, provider, {
      connectionId: row.id,
      expectedAuthorityGeneration: 1,
    });
    await f.credentials.publishLocal(
      f.alice.access,
      provider,
      { ...candidate("new-base"), expiresAt: new Date(Date.now() + 60000) },
      previous,
    );
    release();
    await assert.rejects(pending, { code: "stale-mutation" });
    for (mode of ["wrong-audience", "expired", "too-long"])
      await assert.rejects(
        scope.context.request({ endpoint: "api", method: "GET", path: "/data" }),
        { code: "invalid-derived-credential" },
      );
    assert.equal(calls, 1);
    const final = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    assert.equal(final.credential_generation, 2);
    assert.equal((await f.db.selectFrom("credential_mutations").select("id").execute()).length, 0);
  } finally {
    release();
    await scope?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test("account replacement and disconnect retire routing atomically; failed retirement cannot partially disconnect", async () => {
  const f = await coreFixture();
  let sources: Sources | undefined,
    fail = false;
  const retire = async (...args: Parameters<Sources["retireConnection"]>) => {
    await sources!.retireConnection(...args);
    if (fail) throw new Error("Injected retirement failure");
  };
  const registry = new ProviderRegistry([fixtureProvider]);
  const connections = new ConnectionService(f.db, f.access, f.secrets, registry, policy, retire);
  const credentials = new CredentialsService(f.db, f.access, f.secrets, retire);
  sources = new Sources(
    { db: f.db, controlDb: f.db, access: f.access, connections, secrets: f.secrets },
    new Map([
      [
        "fixture",
        {
          verify: async () => {
            throw new Error("Unused");
          },
          eventValid: () => true,
          forwardingUnavailable: { status: 503 },
          verifyAssociation: async () => ({
            accountKey: "account",
            privateContext: { signingSecret: "protected" },
          }),
        },
      ],
    ]),
  );
  try {
    const row = await credentials.publishLocal(f.alice.access, fixtureProvider, candidate());
    const source = await sources.associate(f.alice.access, {
      providerRegistrationId: "fixture",
      connectionId: row.id,
      setup: "manual",
      inputs: {},
    });
    const previous = await credentials.capture(f.alice.access, fixtureProvider, {
      connectionId: row.id,
      expectedAuthorityGeneration: 1,
    });
    await credentials.publishLocal(
      f.alice.access,
      fixtureProvider,
      { ...candidate("new-account"), accountKey: "another-account" },
      previous,
    );
    assert.equal((await sources.get(source))?.state, "retired");
    assert.deepEqual(sources.context((await sources.get(source))!), {});
    const next = await sources.associate(f.alice.access, {
      providerRegistrationId: "fixture",
      connectionId: row.id,
      setup: "manual",
      inputs: {},
    });
    fail = true;
    await assert.rejects(
      connections.disconnect(f.alice.access, row.id, 2),
      /Injected retirement failure/,
    );
    assert.equal((await sources.get(next))?.state, "active");
    assert.equal(
      (
        await f.db
          .selectFrom("connections")
          .select("state")
          .where("id", "=", row.id)
          .executeTakeFirstOrThrow()
      ).state,
      "active",
    );
    fail = false;
    await connections.disconnect(f.alice.access, row.id, 2);
    assert.equal((await sources.get(next))?.state, "retired");
    assert.equal((await sources.get(next))?.revision, 2);
  } finally {
    await f.close();
  }
});
