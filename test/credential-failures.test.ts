import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { openCredential } from "../src/connections/store.ts";
import type { Authentication } from "../src/contracts/operator.ts";
import { connectionsHarness } from "./support/connections.ts";
import { testKeys } from "./support/db.ts";
import {
  type IntakeHarness,
  IntakeProvider,
  intakeHarness,
  signingKey,
  tokenResponse,
} from "./support/intake-providers.ts";

async function fixture(t: TestContext) {
  const provider = await new IntakeProvider().start();
  const h = await intakeHarness(provider);
  t.after(async () => {
    await h.close();
    await provider.close();
  });
  return { provider, h };
}

async function currentConnection(h: IntakeHarness, id: string) {
  return h.db
    .selectFrom("connections")
    .selectAll()
    .where("definition_id", "=", id)
    .where("status", "<>", "disconnected")
    .executeTakeFirstOrThrow();
}

const generatedMethods = [
  ["client_credentials", "shared"],
  ["jwt_bearer", "shared"],
  ["jwt_bearer", "personal"],
] as const;

for (const [method, ownership] of generatedMethods) {
  async function setup(h: IntakeHarness, provider: IntakeProvider) {
    const input = { kind: "jwt" as const, privateKey: signingKey().privateKey, issuer: "owner" };
    const response = {
      ...tokenResponse,
      rules: {
        ...tokenResponse.rules,
        rejectedGrant: [{ path: ["error"], equals: "invalid_grant" }],
      },
      mapping: { ...tokenResponse.mapping, scope: ["scope"] },
    };
    const authentication: Authentication =
      method === "client_credentials"
        ? {
            method,
            tokenEndpoint: `${provider.origin}/token`,
            clientAuthentication: { method: "none" },
            scopeParameter: { name: "scope", separator: " " },
            response,
          }
        : {
            method,
            tokenEndpoint: `${provider.origin}/token`,
            clientAuthentication: { method: "none" },
            jwt: {
              algorithm: "RS256",
              issuer: { credential: "issuer" },
              audience: `${provider.origin}/token`,
              ttlSeconds: 300,
            },
            response,
          };
    await h.create(
      h.definition("generated", {
        ownership,
        authentication,
        scopes: ["configured"],
        ...(method === "jwt_bearer" && ownership === "shared" ? { credential: input } : {}),
      }),
    );
    if (ownership === "personal")
      await h.connections.setPersonalCredential(h.app.principal, "generated", input);
    return input;
  }

  test(`${ownership} ${method} configured rejected exchange suspends authorization until explicit recovery`, async (t) => {
    const { provider, h } = await fixture(t);
    const input = await setup(h, provider);
    provider.expect("/token", () => {}, {
      json: { access_token: "synthetic-expired-access", expires_in: 120, scope: "granted" },
    });
    provider.expect("/native", () => {});
    assert.equal((await h.native("generated")).status, 200);
    const before = await currentConnection(h, "generated");
    h.identity.clock.offsetMs += 130_000;
    provider.expect(
      "/token",
      (request) => {
        assert.equal(
          request.form.get("grant_type"),
          method === "client_credentials"
            ? "client_credentials"
            : "urn:ietf:params:oauth:grant-type:jwt-bearer",
        );
      },
      { status: 400, json: { error: "invalid_grant" } },
    );
    const refused = await h.native("generated");
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, "needs-authorization");
    const after = await currentConnection(h, "generated");
    assert.equal(after.status, "needs-authorization");
    assert.equal(after.disconnect_reason, "exchange-rejected");
    assert.deepEqual(after.sealed, before.sealed);
    assert.deepEqual(after.scopes, before.scopes);
    assert.deepEqual(after.authorized_at, before.authorized_at);
    assert.deepEqual(after.credential_set_at, before.credential_set_at);
    assert.equal(after.credential_generation, before.credential_generation);
    assert.deepEqual(after.credential_expires_at, before.credential_expires_at);
    if (method === "jwt_bearer")
      assert.deepEqual(openCredential(h.sealer, after.id, after.sealed!).input, input);
    const requests = provider.requests.length;
    assert.equal((await h.native("generated")).status, 403);
    assert.equal(provider.requests.length, requests);
    const apps = await h.request("/v1/definitions", { bearer: h.app.bearer });
    const app = (await apps.json()).definitions.find(
      (row: { id: string }) => row.id === "generated",
    );
    assert.equal(app.status, "needs-authorization");
    assert.deepEqual(app.scopes, ["granted"]);
    const operator = await h.view("generated");
    assert.equal(operator.connectionCounts.needsAuthorization, 1);
    assert.equal(operator.connectionCounts.connected, 0);
    if (ownership === "shared") {
      assert.equal(operator.credential.set, true);
      assert.equal(operator.setup.state, "needs-setup");
      assert.deepEqual(operator.setup.missing, [
        method === "client_credentials" ? "authorization" : "credential",
      ]);
    }
    assert.equal(
      (await h.connections.listConnections({ definitionId: "generated" }))[0]?.status,
      "needs-authorization",
    );
    if (method === "client_credentials")
      await h.definitions.connectMachine(h.operator.principal, "generated");
    else if (ownership === "personal")
      await h.connections.setPersonalCredential(h.app.principal, "generated", input);
    else
      await h.definitions.setSecrets("test", "generated", {
        expectedVersion: operator.version,
        credential: input,
      });
    provider.expect("/token", () => {}, { json: { access_token: "synthetic-recovered-access" } });
    provider.expect("/native", (request) => {
      assert.equal(request.headers.authorization, "Bearer synthetic-recovered-access");
    });
    assert.equal((await h.native("generated")).status, 200);
    assert.equal(provider.count("/token"), 3);
    assert.equal(provider.count("/native"), 2);
    await h.assertSafe([
      input.privateKey,
      "synthetic-expired-access",
      "synthetic-recovered-access",
    ]);
    provider.assertComplete();
  });

  test(`${ownership} ${method} unclassified exchange failures keep authorization retryable`, async (t) => {
    const { provider, h } = await fixture(t);
    await setup(h, provider);
    const before = await currentConnection(h, "generated");
    for (const [reply, expected] of [
      [{ status: 500, json: { error: "invalid_grant" } }, "exchange-uncertain"],
      [{ status: 429, json: { error: "invalid_grant" } }, "exchange-uncertain"],
      [{ status: 400, json: { error: "other_error" } }, "exchange-failed"],
      [{ drop: true }, "exchange-uncertain"],
    ] as const) {
      const count = provider.count("/token");
      provider.expect("/token", () => {}, reply);
      const response = await h.native("generated");
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, expected);
      assert.equal(provider.count("/token"), count + 1);
      const after = await currentConnection(h, "generated");
      assert.deepEqual(after, before);
    }
    assert.equal(provider.count("/native"), 0);
    provider.expect("/token", () => {}, { json: { access_token: "synthetic-retry-access" } });
    provider.expect("/native", () => {});
    assert.equal((await h.native("generated")).status, 200);
    provider.assertComplete();
  });
}

for (const owner of [true, false]) {
  for (const revoke of [false, true]) {
    test(`${owner ? "owner" : "operator"} disconnect with missing sealing key commits local deletion${revoke ? " before optional revocation" : " without revocation"}`, async (t) => {
      const { provider, h } = await fixture(t);
      await h.create(
        h.definition("disconnect", {
          ownership: owner ? "personal" : "shared",
          authentication: { method: "static" },
          ...(!owner ? { credential: { kind: "token", value: "synthetic-disconnect-key" } } : {}),
          ...(revoke
            ? {
                revocation: {
                  url: `${provider.origin}/revoke`,
                  method: "POST",
                  credential: "accessToken",
                  encoding: "form",
                  response: { successStatuses: [200] },
                },
              }
            : {}),
        }),
      );
      if (owner)
        await h.connections.setPersonalCredential(h.app.principal, "disconnect", {
          kind: "token",
          value: "synthetic-disconnect-key",
        });
      const before = await currentConnection(h, "disconnect");
      const outbound = provider.outbound();
      t.after(() => outbound.close());
      const replica = connectionsHarness(h.db, {
        keys: testKeys("replacement"),
        outbound,
        clock: h.identity.clock,
      });
      assert.throws(() => openCredential(replica.sealer, before.id, before.sealed!), {
        code: "credential-unavailable",
      });
      const disconnected = owner
        ? await replica.connections.disconnectOwn(h.app.principal, "disconnect")
        : await replica.connections.disconnectAny(h.operator.principal, before.id);
      assert.equal(disconnected, true);
      const after = await h.db
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", before.id)
        .executeTakeFirstOrThrow();
      assert.equal(after.status, "disconnected");
      assert.equal(after.sealed, null);
      assert.equal(after.disconnect_reason, owner ? "owner" : "operator");
      assert.ok(after.disconnected_at);
      const audits = await h.db
        .selectFrom("audit")
        .selectAll()
        .where("target", "=", "disconnect")
        .execute();
      assert.equal(audits.filter((row) => row.action === "connection.disconnect").length, 1);
      const failures = audits.filter((row) => row.action === "connection.revoke-failed");
      assert.equal(failures.length, revoke ? 1 : 0);
      if (revoke) assert.deepEqual(failures[0]?.detail, { code: "revoke-failed" });
      assert.equal(provider.requests.length, 0);
      await h.assertSafe(["synthetic-disconnect-key"]);
      assert.equal(JSON.stringify(replica.lines).includes("synthetic-disconnect-key"), false);
      provider.assertComplete();
    });
  }
}
