import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AuthorizationService } from "../src/connections/authorizations.js";
import { OperatorConnections } from "../src/connections/operator.js";
import { createHttpApp } from "../src/http/app.js";
import { registerOperatorRoutes } from "../src/http/operator-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { randomSecret, verifier } from "../src/security/secrets.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

test("operator imports publish explicit named audiences with credentials, reject viewer authority, and never enroll later sites implicitly", async () => {
  const f = await coreFixture();
  const secret = randomSecret();
  const provider = {
    ...fixtureProvider,
    mode: "operator" as const,
    staticSetup: {
      remote: false,
      mayInvalidate: false,
      inputSchema: z.strictObject({ token: z.string() }),
      async prepare(input: unknown) {
        return candidate((input as { token: string }).token);
      },
    },
  };
  const registry = new ProviderRegistry([provider]);
  const policy = {
    maxSockets: 4,
    connectTimeoutMs: 1000,
    headersTimeoutMs: 1000,
    stallTimeoutMs: 1000,
  };
  const operators = new OperatorConnections(
    f.db,
    f.credentials,
    registry,
    policy,
    { operationMs: 30000, leaseMs: 30000 },
    new Set(["operator"]),
  );
  const authorizations = new AuthorizationService(
    f.db,
    f.access,
    f.credentials,
    registry,
    f.secrets,
    policy,
    30000,
    30000,
    operators,
  );
  const app = await createHttpApp({ db: f.db });
  registerOperatorRoutes(app, operators, authorizations, [
    { actorId: "operator", verifier: verifier(secret) },
  ]);
  try {
    await f.db
      .updateTable("provider_registrations")
      .set({ mode: "operator" })
      .where("id", "=", "fixture")
      .execute();
    const url = "/v1/operator/apps/one/connections/static";
    const payload = {
      providerRegistrationId: "fixture",
      inputs: { token: "operator-secret" },
      audience: [{ deploymentId: "cloud", siteId: "site", subjectId: "alice" }],
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${f.alice.token}` },
          payload,
        })
      ).statusCode,
      401,
    );
    const created = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${secret}` },
      payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(!created.body.includes("operator-secret"));
    const id = created.json().id;
    assert.equal(await f.access.connectionVisible(f.alice.access, id), true);
    assert.equal(await f.access.connectionVisible(f.bob.access, id), false);
    await f.db
      .insertInto("tableau_sites")
      .values({ id: "later", deployment_id: "cloud", site_id: "later", enabled: true })
      .execute();
    const later = await f.access.createSession(
      {
        deploymentId: "cloud",
        siteId: "later",
        subjectId: "alice",
        adapterId: "fixture",
        verifiedAt: new Date(),
      },
      "one",
    );
    assert.equal(await f.access.connectionVisible(later.access, id), false);
    const replacement = { connectionId: id, expectedAuthorityGeneration: 1 };
    const changed = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${secret}` },
      payload: { ...payload, replacement, audience: [] },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(await f.access.connectionVisible(f.alice.access, id), false);
    const row = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(row.owner_id, null);
    assert.equal(row.credential_generation, 2);
    assert.equal(row.authority_generation, 1);
    assert.equal((await f.db.selectFrom("credential_mutations").select("id").execute()).length, 0);
  } finally {
    await app.close();
    await f.close();
  }
});
